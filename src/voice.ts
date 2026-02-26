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

/**
 * Transcribe an audio file to text via Speaches (Faster-whisper).
 *
 * Handles the .oga → .ogg rename gotcha (Telegram voice notes use .oga,
 * Faster-whisper expects .ogg — same Opus codec, different extension).
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  let finalPath = audioPath;

  // GOTCHA: Telegram sends .oga, whisper needs .ogg
  if (audioPath.endsWith('.oga')) {
    finalPath = audioPath.replace(/\.oga$/, '.ogg');
    renameSync(audioPath, finalPath);
  }

  logger.debug({ path: finalPath }, 'Transcribing audio');

  const transcription = await speachesClient.audio.transcriptions.create({
    file: createReadStream(finalPath),
    model: 'Systran/faster-whisper-small',
    language: 'en',
  });

  logger.debug(
    { textLength: transcription.text.length },
    'Transcription complete',
  );

  return transcription.text;
}

/**
 * Synthesize text to speech via Speaches (Kokoro TTS).
 * Returns an MP3 audio buffer ready to send as a voice message.
 *
 * Automatically detects language (English/Spanish) and selects
 * the matching Kokoro voice.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const detected = franc(text);
  const { voice, lang } = VOICE_MAP[detected] ?? DEFAULT_VOICE;

  logger.debug({ textLength: text.length, detected, voice, lang }, 'Synthesizing speech');

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
