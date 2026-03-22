import OpenAI from 'openai';
import { franc } from 'franc-min';
import { createReadStream, renameSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

/** Map detected language (ISO 639-3) to Kokoro voice ID */
const VOICE_MAP: Record<string, { voice: string; lang: string }> = {
  spa: { voice: 'ef_dora', lang: 'es' },
  eng: { voice: 'af_heart', lang: 'en' },
};
const DEFAULT_VOICE = VOICE_MAP.eng;

const speachesClient = new OpenAI({
  baseURL: config.SPEACHES_URL,
  apiKey: 'not-needed', // Speaches doesn't require auth
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

  logger.debug({ path: finalPath }, 'Transcribing audio');

  // Omit language param — Faster-whisper auto-detects (supports 99 languages)
  const transcription = await speachesClient.audio.transcriptions.create({
    file: createReadStream(finalPath),
    model: 'Systran/faster-whisper-small',
  });

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

  const response = await speachesClient.audio.speech.create({
    model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
    voice,
    input: text,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
