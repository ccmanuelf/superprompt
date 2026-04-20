import OpenAI from 'openai';
import { franc } from 'franc-min';
import { createReadStream, renameSync, statSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

/** Map detected language (ISO 639-3) to Kokoro voice ID */
const VOICE_MAP: Record<string, { voice: string; lang: string }> = {
  spa: { voice: 'ef_dora', lang: 'es' },
  eng: { voice: 'af_heart', lang: 'en' },
};
const DEFAULT_VOICE = VOICE_MAP.eng;

// 2 min absorbs Kokoro/Whisper cold-start after Speaches idle-unloads the model.
const SPEACHES_REQUEST_TIMEOUT_MS = 120_000;

// Minimum webm/opus payload. MediaRecorder writes a ~200-byte EBML header even
// for an essentially-empty recording; anything below this cannot contain a
// decodable cluster and Speaches would return 415 Failed to decode.
const MIN_AUDIO_BYTES = 2_000;

const speachesClient = new OpenAI({
  baseURL: config.SPEACHES_URL,
  apiKey: 'not-needed', // Speaches doesn't require auth
  timeout: SPEACHES_REQUEST_TIMEOUT_MS,
  maxRetries: 0, // we handle retries ourselves with targeted strategy
});

export interface TranscriptionResult {
  text: string;
  detectedLanguage: string | null; // ISO 639-1 (e.g., 'en', 'es')
}

/**
 * Transcribe an audio file to text via Speaches (Faster-whisper).
 * Returns both the text and the detected language for TTS voice selection.
 *
 * Handles the .oga → .ogg rename gotcha (Telegram voice notes use .oga,
 * Faster-whisper expects .ogg — same Opus codec, different extension).
 */
export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
  let finalPath = audioPath;

  // GOTCHA: Telegram sends .oga, whisper needs .ogg
  if (audioPath.endsWith('.oga')) {
    finalPath = audioPath.replace(/\.oga$/, '.ogg');
    renameSync(audioPath, finalPath);
  }

  // Guard: tiny files are either truncated recordings or silent blips that
  // MediaRecorder finalized with only an EBML header. Speaches returns 415
  // "Failed to decode audio" for these; short-circuit with an empty transcript
  // so the caller treats it as "no speech" instead of a hard error.
  const size = statSync(finalPath).size;
  if (size < MIN_AUDIO_BYTES) {
    logger.debug({ path: finalPath, size }, 'Audio below minimum size — skipping STT');
    return { text: '', detectedLanguage: null };
  }

  logger.debug({ path: finalPath, size }, 'Transcribing audio');

  // Omit language param — Faster-whisper auto-detects (supports 99 languages)
  let transcription: { text: string };
  try {
    transcription = await speachesClient.audio.transcriptions.create({
      file: createReadStream(finalPath),
      model: 'Systran/faster-whisper-small',
    });
  } catch (err) {
    // Speaches returns 415 when ffmpeg can't decode the payload — happens with
    // short/malformed browser recordings. Treat as "no speech", not an error.
    const status = (err as { status?: number })?.status;
    if (status === 415) {
      logger.warn({ path: finalPath, size }, 'Speaches could not decode audio (415) — treating as silence');
      return { text: '', detectedLanguage: null };
    }
    throw err;
  }

  // Detect language from the transcribed text (franc on the user's full utterance
  // is more reliable than on the short AI response)
  const detected = franc(transcription.text);
  const detectedLanguage = detected === 'spa' ? 'es' : detected === 'eng' ? 'en' : null;

  logger.debug(
    { textLength: transcription.text.length, detectedLanguage },
    'Transcription complete',
  );

  return { text: transcription.text, detectedLanguage };
}

/** Map ISO 639-1 codes (from Whisper) to Kokoro voice config */
const VOICE_MAP_ISO1: Record<string, { voice: string; lang: string }> = {
  es: { voice: 'ef_dora', lang: 'es' },
  en: { voice: 'af_heart', lang: 'en' },
};

/**
 * Synthesize text to speech via Speaches (Kokoro TTS).
 * Returns an MP3 audio buffer ready to send as a voice message.
 *
 * Uses languageHint (from STT) when available for reliable voice selection.
 * Falls back to franc text detection for responses without STT context (e.g., Telegram).
 */
export async function synthesizeSpeech(text: string, languageHint?: string | null): Promise<Buffer> {
  // Priority: STT language hint > franc text detection > default English
  let voiceConfig = DEFAULT_VOICE;
  let detectionSource = 'default';

  if (languageHint && VOICE_MAP_ISO1[languageHint]) {
    voiceConfig = VOICE_MAP_ISO1[languageHint];
    detectionSource = 'stt-hint';
  } else {
    const detected = franc(text);
    if (VOICE_MAP[detected]) {
      voiceConfig = VOICE_MAP[detected];
      detectionSource = 'franc';
    }
  }

  const { voice, lang } = voiceConfig;
  logger.debug({ textLength: text.length, voice, lang, detectionSource }, 'Synthesizing speech');

  // Kokoro is idle-unloaded by Speaches after inactivity; the first request
  // after unload blocks while the ONNX model loads (~20-40s cpu). The default
  // keepalive socket timeout can fire before load completes → "Socket timeout".
  // Retry once on transient connection errors with the model now warm.
  const request = () => speachesClient.audio.speech.create({
    model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
    voice,
    input: text,
    response_format: 'mp3',
  });

  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request();
  } catch (err) {
    if (isTransientFetchError(err)) {
      logger.warn({ err: (err as Error).message, voice }, 'TTS cold-start timeout — retrying once');
      response = await request();
    } else {
      throw err;
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Detects transient fetch/socket errors that warrant a single retry. The first
 * Kokoro request after idle-unload commonly hits ERR_SOCKET_TIMEOUT or a
 * connection reset while the ONNX runtime warms up.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string; cause?: { code?: string } }).code
    ?? (err as { cause?: { code?: string } }).cause?.code;
  if (code && ['ERR_SOCKET_TIMEOUT', 'ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const name = (err as { name?: string }).name;
  if (name === 'FetchError' || name === 'AbortError') return true;
  const message = (err as { message?: string }).message ?? '';
  return /socket timeout|fetch failed|network/i.test(message);
}

/**
 * Check if the Speaches voice service is reachable.
 * Returns capability flags for STT and TTS.
 */
export async function voiceCapabilities(): Promise<{
  stt: boolean;
  tts: boolean;
}> {
  // Strip /v1 suffix for health endpoint
  const baseUrl = config.SPEACHES_URL.replace(/\/v1\/?$/, '');

  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      return { stt: true, tts: true };
    }
  } catch {
    // Speaches not reachable — graceful degradation
  }

  logger.warn('Speaches voice service not reachable');
  return { stt: false, tts: false };
}
