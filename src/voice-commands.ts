/**
 * Voice command shim — intercepts transcripts before they hit the AI and
 * maps natural-language phrases to direct state changes (model switch,
 * session reset, status query). The model would otherwise treat these
 * as normal conversation and either hallucinate an answer or loop through
 * tool calls that can't reach session state.
 *
 * Design principles:
 * - Bilingual (EN + ES) by design. Any new phrase must be added in both.
 * - Only match on strong signals. A user saying "I want to reset my
 *   perspective on this" is not asking for /newchat. Patterns require
 *   specific command verbs ("start over", "switch", "new chat").
 * - Commands are orthogonal to AI conversation. When no command matches,
 *   the caller keeps the existing chat flow.
 * - Every command produces a short acknowledgment string in the user's
 *   language — the TTS reads that back so the user knows it worked.
 */
import type { ProviderRouter } from './providers/router.js';
import { clearSession } from './db-core.js';
import { logger } from './logger.js';

export type CommandKind = 'new-chat' | 'switch-model' | 'status';

export type VoiceCommand =
  | { kind: 'new-chat'; language: 'en' | 'es' }
  | { kind: 'switch-model'; target: 'small' | 'large'; language: 'en' | 'es' }
  | { kind: 'status'; language: 'en' | 'es' };

const SMALL_MODEL = 'qwen3.5:0.8b';
const LARGE_MODEL = 'qwen3.5:latest';

// Each pattern set is anchored on the verb/noun of intent. Loose phrasing
// that a user might wrap the command in (please, could you, etc.) is
// absorbed by the broader regex. Language tags are kept separate so we
// can respond in the same language the user spoke.

// Each pattern uses `^` anchoring (with politeness prefix) for command
// phrases and a separate strict form for "bare noun phrase" commands
// ("big model please") so descriptive sentences that MENTION the noun
// ("tell me about the big model we use for production") don't hijack.

const NEW_CHAT_PATTERNS: Array<{ re: RegExp; lang: 'en' | 'es' }> = [
  { re: /\b(new\s+chat|start\s+over|reset\s+(the\s+)?(conversation|chat|session)|clear\s+(the\s+)?(conversation|chat|session)|forget\s+(everything|this)|fresh\s+start)\b/i, lang: 'en' },
  // Spanish: empezar conjugations (empieza 3sg imperative, empecemos 1pl subjunctive, comencemos 1pl subjunctive of comenzar) must each be spelled literally — they don't share a stem.
  { re: /\b(nuevo\s+chat|nueva\s+conversaci[oó]n|(empieza|empecemos|comencemos)\s+de\s+nuevo|reinicia(?:r)?\s+(la\s+)?(conversaci[oó]n|chat|sesi[oó]n)|olvida\s+todo|borra\s+(la\s+)?(conversaci[oó]n|sesi[oó]n))\b/i, lang: 'es' },
];

// Verb-anchored command forms. Either the utterance starts with a command
// verb ("switch/use/change") OR the entire utterance is the bare noun
// phrase ("the big model please"). Mere MENTION inside a descriptive
// sentence must not match.
const SMALL_MODEL_PATTERNS: Array<{ re: RegExp; lang: 'en' | 'es' }> = [
  { re: /^(please\s+)?(switch|change|go|move)\s+(to\s+)?(the\s+)?small(\s+model)?\b/i, lang: 'en' },
  { re: /^(please\s+)?use\s+(the\s+)?small\s+model\b/i, lang: 'en' },
  { re: /^(the\s+)?small\s+model(\s+please)?\s*[.!?]?$/i, lang: 'en' },
  { re: /^(por\s+favor\s+)?(cambia(r)?|cambiemos|pasa)\s+(al\s+)?modelo\s+(peque[ñn]o|chico)\b/i, lang: 'es' },
  { re: /^(por\s+favor\s+)?usa(r)?\s+(el\s+)?modelo\s+(peque[ñn]o|chico)\b/i, lang: 'es' },
  { re: /^(el\s+)?modelo\s+(peque[ñn]o|chico)(\s+por\s+favor)?\s*[.!?]?$/i, lang: 'es' },
];

const LARGE_MODEL_PATTERNS: Array<{ re: RegExp; lang: 'en' | 'es' }> = [
  { re: /^(please\s+)?(switch|change|go|move)\s+(to\s+)?(the\s+)?(big|large|full)(\s+model)?\b/i, lang: 'en' },
  { re: /^(please\s+)?use\s+(the\s+)?(big|large|full)\s+model\b/i, lang: 'en' },
  { re: /^(the\s+)?(big|large|full)\s+model(\s+please)?\s*[.!?]?$/i, lang: 'en' },
  { re: /^(por\s+favor\s+)?(cambia(r)?|cambiemos|pasa)\s+(al\s+)?modelo\s+(grande|completo)\b/i, lang: 'es' },
  { re: /^(por\s+favor\s+)?usa(r)?\s+(el\s+)?modelo\s+(grande|completo)\b/i, lang: 'es' },
  { re: /^(el\s+)?modelo\s+(grande|completo)(\s+por\s+favor)?\s*[.!?]?$/i, lang: 'es' },
];

const STATUS_PATTERNS: Array<{ re: RegExp; lang: 'en' | 'es' }> = [
  { re: /\b(which\s+model|what\s+model|current\s+model|what.?s\s+the\s+(current\s+)?model|status\s+check)\b/i, lang: 'en' },
  { re: /\b(qu[eé]\s+modelo|cu[aá]l\s+(es\s+)?(el\s+)?modelo|modelo\s+actual|estado\s+actual)\b/i, lang: 'es' },
];

/**
 * Parse a transcript looking for a voice command. Returns null if no
 * command was unambiguously detected — caller should pass the transcript
 * through to the normal AI chat flow.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const text = transcript.trim();
  if (!text) return null;

  for (const p of NEW_CHAT_PATTERNS) {
    if (p.re.test(text)) return { kind: 'new-chat', language: p.lang };
  }
  for (const p of SMALL_MODEL_PATTERNS) {
    if (p.re.test(text)) return { kind: 'switch-model', target: 'small', language: p.lang };
  }
  for (const p of LARGE_MODEL_PATTERNS) {
    if (p.re.test(text)) return { kind: 'switch-model', target: 'large', language: p.lang };
  }
  for (const p of STATUS_PATTERNS) {
    if (p.re.test(text)) return { kind: 'status', language: p.lang };
  }
  return null;
}

/**
 * Execute a parsed voice command. Returns the spoken acknowledgment — the
 * caller synthesizes and sends this back to the user.
 *
 * Failures are caught and converted to a short spoken error so the voice
 * loop doesn't die on a DB hiccup.
 */
export async function executeVoiceCommand(
  cmd: VoiceCommand,
  chatId: string,
  router: ProviderRouter,
): Promise<string> {
  try {
    switch (cmd.kind) {
      case 'new-chat': {
        await clearSession(chatId);
        logger.info({ chatId }, 'Voice command: new chat');
        return cmd.language === 'es'
          ? 'Listo, empezamos una nueva conversación.'
          : 'Okay, starting a new conversation.';
      }
      case 'switch-model': {
        const target = cmd.target === 'small' ? SMALL_MODEL : LARGE_MODEL;
        const result = await router.switchOllamaModel(chatId, target);
        logger.info({ chatId, target, result }, 'Voice command: switch model');
        if (result !== target) {
          // switchOllamaModel returns an error string if the model is missing
          return cmd.language === 'es'
            ? `No pude cambiar el modelo: ${result}`
            : `Could not switch model: ${result}`;
        }
        const label = cmd.target === 'small'
          ? (cmd.language === 'es' ? 'pequeño' : 'small')
          : (cmd.language === 'es' ? 'grande' : 'large');
        return cmd.language === 'es'
          ? `Cambié al modelo ${label}.`
          : `Switched to the ${label} model.`;
      }
      case 'status': {
        const model = await router.getOllamaModel(chatId);
        logger.info({ chatId, model }, 'Voice command: status');
        return cmd.language === 'es'
          ? `Estoy usando el modelo ${model}.`
          : `I'm using the ${model} model.`;
      }
    }
  } catch (err) {
    logger.warn({ err, chatId, cmd }, 'Voice command execution failed');
    return cmd.language === 'es'
      ? 'Algo falló ejecutando ese comando.'
      : 'Something went wrong running that command.';
  }
}

/**
 * Pick the greeting language based on the last few user turns on this
 * chat. Uses a Spanish-first bias when history is empty OR evenly split
 * — fits the Mexican manufacturing context this bot lives in; pure-English
 * users get English as soon as any Whisper-transcribed turn tilts the
 * count.
 */
export function pickGreetingLanguage(
  recentUserMessages: string[],
  defaultLang: 'en' | 'es' = 'es',
): 'en' | 'es' {
  if (recentUserMessages.length === 0) return defaultLang;
  let en = 0, es = 0;
  for (const msg of recentUserMessages) {
    // Reuse the router heuristic so this matches the override detection.
    // Imported lazily to avoid a cycle — router imports this indirectly
    // via voice-session.
    const trimmed = msg.trim();
    if (!trimmed) continue;
    const enMatches = (trimmed.match(/\b(the|is|are|was|were|this|that|with|for|and|or|but|not|have|has|had|can|could|should|would|will|do|does|did|you|your|we|our|they|their|please|need|want|use|based|report)\b/gi) || []).length;
    const esMatches = (trimmed.match(/\b(el|la|los|las|un|una|de|del|que|con|para|por|como|pero|este|esta|eso|esa|ese|y|o|ya|no|se|su|sus|tu|tus|yo|mi|es|son|era|fue|ser|estar|tiene|hacer|necesito|quiero|genera|crea|haz|usa|basado|reporte)\b/gi) || []).length;
    if (enMatches > esMatches) en++;
    else if (esMatches > enMatches) es++;
  }
  if (en > es) return 'en';
  if (es > en) return 'es';
  return defaultLang;
}

/** Spoken greeting text — kept short so it plays fast after warmup. */
export function greetingText(lang: 'en' | 'es'): string {
  return lang === 'es'
    ? 'Hola, estoy listo. ¿En qué te puedo ayudar?'
    : "Hi, I'm ready. What can I help you with?";
}
