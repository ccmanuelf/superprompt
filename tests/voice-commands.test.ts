/**
 * rc.83 — voice command shim. Parses transcripts for direct state-change
 * commands before they reach the AI. Bilingual (EN + ES). These tests
 * pin both the positive matches (each command has a variety of phrasings
 * that must work) and the negative cases (conversational utterances that
 * merely MENTION a model or "reset" must NOT trigger a command).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseVoiceCommand,
  executeVoiceCommand,
  pickGreetingLanguage,
  greetingText,
  type VoiceCommand,
} from '../src/voice-commands.js';

// ── parseVoiceCommand ──────────────────────────────────────────

describe('parseVoiceCommand: new chat', () => {
  const positive = {
    en: [
      'new chat',
      'please start a new chat',
      'start over',
      'reset the conversation',
      'reset conversation',
      'clear the session',
      'forget everything',
      'fresh start please',
    ],
    es: [
      'nuevo chat',
      'nueva conversación',
      'empieza de nuevo',
      'empecemos de nuevo',
      'reinicia la conversación',
      'reiniciar la sesión',
      'olvida todo',
      'borra la conversación',
    ],
  };
  it.each(positive.en)('EN match: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'new-chat', language: 'en' });
  });
  it.each(positive.es)('ES match: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'new-chat', language: 'es' });
  });
});

describe('parseVoiceCommand: switch model small', () => {
  const en = [
    'switch to the small model',
    'use the small model please',
    'change to the small model',
  ];
  const es = [
    'cambia al modelo pequeño',
    'usa el modelo chico',
    'cambiar al modelo pequeño',
  ];
  it.each(en)('EN small: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'switch-model', target: 'small', language: 'en' });
  });
  it.each(es)('ES small: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'switch-model', target: 'small', language: 'es' });
  });
});

describe('parseVoiceCommand: switch model large', () => {
  const en = [
    'switch to the big model',
    'use the large model',
    'change to the full model',
    'big model please',
  ];
  const es = [
    'cambia al modelo grande',
    'usa el modelo completo',
    'modelo grande por favor',
  ];
  it.each(en)('EN large: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'switch-model', target: 'large', language: 'en' });
  });
  it.each(es)('ES large: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'switch-model', target: 'large', language: 'es' });
  });
});

describe('parseVoiceCommand: status', () => {
  it.each([
    'which model are you using',
    'what model is this',
    "what's the current model",
    'current model please',
  ])('EN status: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'status', language: 'en' });
  });
  it.each([
    'qué modelo usas',
    'cuál es el modelo',
    'cuál es el modelo actual',
    'modelo actual',
  ])('ES status: %s', (t) => {
    expect(parseVoiceCommand(t)).toEqual({ kind: 'status', language: 'es' });
  });
});

describe('parseVoiceCommand: does NOT match conversational utterances', () => {
  // These all sound commandy but aren't. The shim must not hijack them —
  // the user is actually asking a substantive question.
  const nonCommands = [
    'tell me about the big model we use for production',
    'I need to reset my mental model of this project',
    'what about the small numbers in this dataset',
    'can you explain the model of computation',
    'me puedes explicar el modelo de producción',
    '',
    '   ',
  ];
  it.each(nonCommands)('no match: %s', (t) => {
    expect(parseVoiceCommand(t)).toBeNull();
  });
});

// ── executeVoiceCommand ──────────────────────────────────────────
//
// We mock the router and clearSession so the tests stay pure. The shim
// must: (1) call the right method, (2) return the right acknowledgment
// in the right language, (3) not throw on failures.

type MockRouter = {
  switchOllamaModel: ReturnType<typeof vi.fn>;
  getOllamaModel: ReturnType<typeof vi.fn>;
};

vi.mock('../src/db-core.js', () => ({
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

function mkRouter(overrides?: Partial<MockRouter>): MockRouter {
  return {
    switchOllamaModel: vi.fn().mockResolvedValue('qwen3.5:0.8b'),
    getOllamaModel: vi.fn().mockResolvedValue('qwen3.5:latest'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeVoiceCommand: new chat', () => {
  it('clears the session and acks in English', async () => {
    const router = mkRouter();
    const cmd: VoiceCommand = { kind: 'new-chat', language: 'en' };
    const { clearSession } = await import('../src/db-core.js');
    const ack = await executeVoiceCommand(cmd, 'chat1', router as never);
    expect(vi.mocked(clearSession)).toHaveBeenCalledWith('chat1');
    expect(ack).toMatch(/starting a new conversation/i);
  });

  it('acks in Spanish when the command came in Spanish', async () => {
    const router = mkRouter();
    const cmd: VoiceCommand = { kind: 'new-chat', language: 'es' };
    const ack = await executeVoiceCommand(cmd, 'chat1', router as never);
    expect(ack).toMatch(/nueva conversación/i);
  });
});

describe('executeVoiceCommand: switch model', () => {
  it('small → calls router with qwen3.5:0.8b', async () => {
    const router = mkRouter({
      switchOllamaModel: vi.fn().mockResolvedValue('qwen3.5:0.8b'),
    });
    const cmd: VoiceCommand = { kind: 'switch-model', target: 'small', language: 'en' };
    const ack = await executeVoiceCommand(cmd, 'chat1', router as never);
    expect(router.switchOllamaModel).toHaveBeenCalledWith('chat1', 'qwen3.5:0.8b');
    expect(ack).toMatch(/switched to the small model/i);
  });

  it('large → calls router with qwen3.5:latest', async () => {
    const router = mkRouter({
      switchOllamaModel: vi.fn().mockResolvedValue('qwen3.5:latest'),
    });
    const cmd: VoiceCommand = { kind: 'switch-model', target: 'large', language: 'es' };
    const ack = await executeVoiceCommand(cmd, 'chat1', router as never);
    expect(router.switchOllamaModel).toHaveBeenCalledWith('chat1', 'qwen3.5:latest');
    expect(ack).toMatch(/modelo grande/i);
  });

  it('surfaces the error when the router returns a message string', async () => {
    const router = mkRouter({
      switchOllamaModel: vi.fn().mockResolvedValue('Model "qwen3.5:0.8b" not found locally.'),
    });
    const cmd: VoiceCommand = { kind: 'switch-model', target: 'small', language: 'en' };
    const ack = await executeVoiceCommand(cmd, 'chat1', router as never);
    expect(ack).toMatch(/could not switch model/i);
    expect(ack).toMatch(/not found locally/i);
  });
});

describe('executeVoiceCommand: status', () => {
  it('reports the current model in English', async () => {
    const router = mkRouter({
      getOllamaModel: vi.fn().mockResolvedValue('qwen3.5:0.8b'),
    });
    const ack = await executeVoiceCommand({ kind: 'status', language: 'en' }, 'chat1', router as never);
    expect(ack).toMatch(/using the qwen3\.5:0\.8b model/i);
  });

  it('reports the current model in Spanish', async () => {
    const router = mkRouter({
      getOllamaModel: vi.fn().mockResolvedValue('qwen3.5:latest'),
    });
    const ack = await executeVoiceCommand({ kind: 'status', language: 'es' }, 'chat1', router as never);
    expect(ack).toMatch(/usando el modelo qwen3\.5:latest/i);
  });
});

describe('executeVoiceCommand: DB failure does not throw', () => {
  it('returns a spoken error instead of propagating', async () => {
    const router = mkRouter({
      getOllamaModel: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const ack = await executeVoiceCommand({ kind: 'status', language: 'en' }, 'chat1', router as never);
    expect(ack).toMatch(/something went wrong/i);
  });
});

// ── pickGreetingLanguage ──────────────────────────────────────────

describe('pickGreetingLanguage', () => {
  it('defaults to Spanish when history is empty (Mexican manufacturing context)', () => {
    expect(pickGreetingLanguage([])).toBe('es');
  });

  it('picks English when recent history is English-dominant', () => {
    const history = [
      'Please generate a summary of the production line status',
      'What are the bottlenecks in the current workflow',
      'Show me the capacity planning report',
    ];
    expect(pickGreetingLanguage(history)).toBe('en');
  });

  it('picks Spanish when recent history is Spanish-dominant', () => {
    const history = [
      'Por favor genera el reporte de la línea de producción',
      'Necesito el análisis de capacidad para la próxima semana',
      'Muéstrame el estado del inventario',
    ];
    expect(pickGreetingLanguage(history)).toBe('es');
  });

  it('falls back to the explicit default when the count ties at zero', () => {
    expect(pickGreetingLanguage(['...', '???'], 'en')).toBe('en');
    expect(pickGreetingLanguage(['...', '???'], 'es')).toBe('es');
  });
});

// rc.84 — voice-web must parse + execute Claude's kanban_action JSON blocks
// the same way telegram.ts and matrix.ts do. Before this fix, voice-web
// passed the raw response to TTS; ttsPlainText stripped the fenced block
// and said "code block." so reads appeared to work (model narrated from
// context) but creates silently failed. Regression test pins the contract
// by source-level assertion so future refactors can't regress the fix.
describe('voice-session must execute kanban_action blocks (rc.84)', () => {
  it('voice-session.ts imports parseKanbanAction + executeKanbanAction', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../src/web/voice-session.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toMatch(/parseKanbanAction/);
    expect(src).toMatch(/executeKanbanAction/);
    expect(src).toMatch(/isKanbanAction/);
    expect(src).toMatch(/stripKanbanBlock/);
  });

  it('voice-session.ts strips the kanban block BEFORE TTS synthesis of the main response', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../src/web/voice-session.ts', import.meta.url).pathname,
      'utf8',
    );
    // Main response TTS is the synthesizeSpeech call that also passes the
    // STT language hint (synthesizeSpeech(responseText, detectedLanguage)).
    // The kanban intercept must land BEFORE that call so the JSON block
    // is executed and removed instead of being spoken aloud.
    const kanbanIdx = src.indexOf('isKanbanAction(responseText)');
    const mainSynthIdx = src.indexOf('synthesizeSpeech(responseText, detectedLanguage)');
    expect(kanbanIdx).toBeGreaterThan(0);
    expect(mainSynthIdx).toBeGreaterThan(0);
    expect(kanbanIdx).toBeLessThan(mainSynthIdx);
  });

  it('requires the user transcript to mention a board/task keyword before executing', async () => {
    // Guard against the bug where the model spontaneously emits a kanban
    // action block in a non-board conversation and we execute it.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../src/web/voice-session.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toMatch(/userWantsKanban/);
    // Bilingual keyword list must be present in the guard regex.
    expect(src).toContain('tablero');
    expect(src).toContain('tarea');
    expect(src).toContain('kanban');
    expect(src).toContain('board');
  });
});

describe('greetingText', () => {
  it('returns the Spanish greeting for es', () => {
    expect(greetingText('es')).toMatch(/hola.*listo/i);
    expect(greetingText('es')).toMatch(/ayudar/i);
  });
  it('returns the English greeting for en', () => {
    expect(greetingText('en')).toMatch(/hi.*ready/i);
    expect(greetingText('en')).toMatch(/help/i);
  });
});
