import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio, synthesizeSpeech } from '../voice.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import { getRecentChatLog } from '../db-core.js';
import {
  isKanbanAction, parseKanbanAction, executeKanbanAction, stripKanbanBlock,
} from '../kanban.js';
import type { ProviderRouter } from '../providers/router.js';
import {
  getPendingConfirmation, clearPendingConfirmation,
  detectConfirmationResponse, handleToolConfirmation,
} from '../policy-engine.js';
import {
  parseVoiceCommand, executeVoiceCommand,
  pickGreetingLanguage, greetingText,
} from '../voice-commands.js';

export interface VoiceResult {
  transcript: string;
  text: string;
  audio: Buffer | null;
  provider: string;
}

export interface GreetingResult {
  text: string;
  audio: Buffer | null;
  language: 'en' | 'es';
  warmupTimedOut: boolean;
}

/** How long we wait for Ollama's cold-load before giving up and greeting anyway. */
const WARMUP_TIMEOUT_MS = 120_000;

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

      // 2a. Voice-command interception (rc.83). Short phrases like
      // "new chat" / "nuevo chat" / "switch to the small model" bypass
      // the AI entirely — they're direct state changes. When no command
      // matches, flow continues to the normal AI pipeline.
      const command = parseVoiceCommand(transcript);
      if (command) {
        const ack = await executeVoiceCommand(command, this.chatId, this.router);
        let cmdAudio: Buffer | null = null;
        try {
          const buf = await synthesizeSpeech(ack, command.language);
          if (buf.length > 0) cmdAudio = buf;
        } catch (err) {
          logger.warn({ err, chatId: this.chatId, command: command.kind }, 'Voice command TTS failed');
        }
        logger.info({ chatId: this.chatId, command: command.kind, ack }, 'Voice command handled');
        return { transcript, text: ack, audio: cmdAudio, provider: 'voice-command' };
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

      // 4. Send to AI with isVoice flag.
      // Whisper's language detection on a full utterance beats stopword
      // counting on short transcripts — forward it as a hard override so
      // "okay, continue" after a Spanish turn doesn't keep the Spanish
      // register (rc.82).
      const response = await this.router.sendMessage({
        chatId: this.chatId,
        message: fullMessage,
        rawUserMessage: transcript,
        isVoice: true,
        platform: 'voice-web',
        languageHint: detectedLanguage === 'en' || detectedLanguage === 'es' ? detectedLanguage : undefined,
      });

      let responseText = response.text || '(No response)';

      // 4b. rc.84 — intercept kanban_action JSON blocks from Claude.
      // Claude's kanban pattern is to embed a ```json {"kanban_action": ...}```
      // block; telegram.ts and matrix.ts parse and execute these blocks,
      // but voice-web used to pass them straight to TTS where the code-fence
      // stripper (rc.79) replaced them with "code block." Result: reads
      // worked (model narrated from context) but creates silently failed —
      // the JSON block was spoken as text, never executed.
      if (isKanbanAction(responseText)) {
        const userWantsKanban =
          /\b(board|kanban|task|card|ticket|todo|to-?do|tablero|tarea|tarjeta|pendiente|pendientes|por hacer)\b/i.test(transcript);
        if (userWantsKanban) {
          const kanbanReq = parseKanbanAction(responseText);
          if (kanbanReq) {
            try {
              const kanbanResult = await executeKanbanAction(this.chatId, kanbanReq);
              logger.info({ chatId: this.chatId, action: kanbanReq.kanban_action }, 'Voice web: kanban action executed');
              // Keep the model's context text, drop the JSON block, and
              // append the tool result so the TTS speaks the confirmation.
              responseText = `${stripKanbanBlock(responseText)}\n\n${kanbanResult}`.trim();
            } catch (err) {
              logger.error({ err, chatId: this.chatId }, 'Voice web: kanban execution failed');
              responseText = stripKanbanBlock(responseText);
            }
          }
        } else {
          // Model emitted the JSON block but the user didn't actually ask
          // for a board action — strip it silently instead of hallucinating
          // a card into existence.
          logger.debug({ chatId: this.chatId }, 'Voice web: kanban JSON in response without user intent — stripping');
          responseText = stripKanbanBlock(responseText);
        }
      }

      // 5. Save conversation turn (fire-and-forget)
      saveConversationTurn(this.chatId, transcript, responseText).catch((err) => {
        logger.warn({ err }, 'Voice web: failed to save conversation memory');
      });

      // 6. Synthesize speech (pass STT language for reliable voice selection)
      let audio: Buffer | null = null;
      try {
        const buf = await synthesizeSpeech(responseText, detectedLanguage);
        // synthesizeSpeech can legitimately return 0 bytes (response was all
        // markdown, nothing speakable). Don't ship an empty binary frame — the
        // browser would try to play silent mp3 while we log nothing.
        if (buf.length > 0) {
          audio = buf;
          logger.info({ chatId: this.chatId, bytes: buf.length, provider: response.provider }, 'Voice web: response ready with audio');
        } else {
          logger.warn({ chatId: this.chatId, provider: response.provider, responseLength: responseText.length }, 'Voice web: response ready but no audio produced');
        }
      } catch (err) {
        logger.warn({ err, chatId: this.chatId }, 'Voice web: TTS failed');
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

  /**
   * Prepare the session for its first user utterance:
   *   1. Warm the Ollama model (cold-load is the 2-3 min wait that used to
   *      eat the user's first sentence).
   *   2. Pick a greeting language based on recent chat history.
   *   3. Synthesize the greeting — this ALSO warms Kokoro, so TTS is
   *      ready by the time the user replies.
   *
   * Warmup is capped at WARMUP_TIMEOUT_MS; if Ollama doesn't respond in
   * time we greet anyway with a flag so the UI can tell the user their
   * first turn may still be slow. Failures never block the greeting —
   * the whole point is to guarantee the user hears the bot before they
   * start speaking.
   */
  async warmupAndGreet(): Promise<GreetingResult> {
    // Pick language from recent user turns. Bot replies are ignored since
    // they may carry a different register than the user's actual input.
    let language: 'en' | 'es' = 'es'; // default bias — see pickGreetingLanguage
    try {
      const recent = await getRecentChatLog(this.chatId, 10);
      const userMessages = recent.filter((r) => r.role === 'user').map((r) => r.content);
      language = pickGreetingLanguage(userMessages);
    } catch (err) {
      logger.warn({ err, chatId: this.chatId }, 'Greeting: could not read chat history, using default language');
    }

    // Warmup Ollama in the background with a hard timeout. The 10m keep-alive
    // is intentional — voice conversations run in bursts, a few minutes of
    // idle between turns is normal.
    const warmupPromise = this.router.preloadOllamaForChat(this.chatId, '10m');
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), WARMUP_TIMEOUT_MS);
    });
    const warmupResult = await Promise.race([warmupPromise, timeoutPromise]);
    const warmupTimedOut = warmupResult === null;

    if (warmupTimedOut) {
      logger.warn({ chatId: this.chatId, timeoutMs: WARMUP_TIMEOUT_MS }, 'Greeting: Ollama warmup timed out, proceeding with greeting anyway');
    }

    // Greeting text + TTS. TTS failure here is non-fatal — we return
    // text-only and the client still knows the bot is ready.
    const text = greetingText(language);
    let audio: Buffer | null = null;
    try {
      const buf = await synthesizeSpeech(text, language);
      if (buf.length > 0) audio = buf;
    } catch (err) {
      logger.warn({ err, chatId: this.chatId }, 'Greeting: TTS failed, returning text-only');
    }

    logger.info({ chatId: this.chatId, language, warmupTimedOut, audioBytes: audio?.length ?? 0 }, 'Greeting: ready');
    return { text, audio, language, warmupTimedOut };
  }
}
