import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio, synthesizeSpeech } from '../voice.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import type { ProviderRouter } from '../providers/router.js';
import {
  getPendingConfirmation, clearPendingConfirmation,
  detectConfirmationResponse, handleToolConfirmation,
} from '../policy-engine.js';

export interface VoiceResult {
  transcript: string;
  text: string;
  audio: Buffer | null;
  provider: string;
}

/** Max audio size: 25 MB (prevents abuse / accidental huge uploads) */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Manages a single voice chat session.
 * Each WebSocket connection gets its own VoiceSession.
 * Audio processing is serialized — concurrent requests are queued.
 */
export class VoiceSession {
  private queue: Promise<VoiceResult> = Promise.resolve({
    transcript: '', text: '', audio: null, provider: '',
  });

  constructor(
    private chatId: string,
    private router: ProviderRouter,
  ) {}

  /**
   * Process an audio buffer through the full pipeline:
   * save temp file → STT → memory context → AI (isVoice) → TTS → return
   *
   * Requests are serialized per session to prevent race conditions
   * with memory context and response ordering.
   */
  processAudio(audioBuffer: Buffer): Promise<VoiceResult> {
    const task = this.queue.then(() => this._processAudioImpl(audioBuffer));
    // Update queue head (swallow errors so queue continues)
    this.queue = task.catch(() => ({
      transcript: '', text: '', audio: null, provider: '',
    }));
    return task;
  }

  private async _processAudioImpl(audioBuffer: Buffer): Promise<VoiceResult> {
    // 0. Validate size
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      throw new Error(`Audio too large: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)`);
    }

    // 1. Save to temp file (webm/opus from browser)
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const tempPath = resolve(UPLOADS_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_webvoice.webm`);
    writeFileSync(tempPath, audioBuffer);

    try {
      // 2. Transcribe (returns text + detected language)
      const { text: transcript, detectedLanguage } = await transcribeAudio(tempPath);
      logger.info({ chatId: this.chatId, transcript, detectedLanguage }, 'Voice web: transcribed');

      if (!transcript.trim()) {
        return { transcript: '', text: '(No speech detected)', audio: null, provider: '' };
      }

      // 2b. Check for pending tool confirmation (SA4)
      const pendingConfirm = getPendingConfirmation(this.chatId);
      if (pendingConfirm) {
        const confirmAction = detectConfirmationResponse(transcript);
        if (confirmAction) {
          const { executeTool } = await import('../providers/tools/index.js');
          const result = await handleToolConfirmation(this.chatId, confirmAction, executeTool);
          const responseText = result.message
            + (result.executed && result.result ? `\n\nResult: ${JSON.stringify(result.result)}` : '');
          let audio: Buffer | null = null;
          try { audio = await synthesizeSpeech(responseText); } catch { /* TTS optional */ }
          return { transcript, text: responseText, audio, provider: 'system' };
        }
        // Not a confirmation response — clear pending and proceed normally
        clearPendingConfirmation(this.chatId);
      }

      // 3. Build memory context
      const memoryContext = await buildMemoryContext(this.chatId, transcript);
      const fullMessage = memoryContext
        ? `${memoryContext}\n\n${transcript}`
        : transcript;

      // 4. Send to AI with isVoice flag
      const response = await this.router.sendMessage({
        chatId: this.chatId,
        message: fullMessage,
        isVoice: true,
        platform: 'voice-web',
      });

      const responseText = response.text || '(No response)';

      // 5. Save conversation turn (fire-and-forget)
      saveConversationTurn(this.chatId, transcript, responseText).catch((err) => {
        logger.warn({ err }, 'Voice web: failed to save conversation memory');
      });

      // 6. Synthesize speech (pass STT language for reliable voice selection)
      let audio: Buffer | null = null;
      try {
        audio = await synthesizeSpeech(responseText, detectedLanguage);
      } catch (err) {
        logger.warn({ err }, 'Voice web: TTS failed');
      }

      return {
        transcript,
        text: responseText,
        audio,
        provider: response.provider,
      };
    } finally {
      // Clean up temp file
      try { unlinkSync(tempPath); } catch { /* already gone */ }
    }
  }
}
