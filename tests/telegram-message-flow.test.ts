/**
 * Characterization tests for the Telegram message pipeline (audit task 0.4).
 *
 * These tests PIN the CURRENT behavior of handleMessageInner before the
 * orchestrator-extraction refactor. They are not aspirational — if a pinned
 * behavior looks odd, that is the point: the refactor must preserve it.
 *
 * Notes on pinned reality (vs the naive reading of the branches):
 * - Pending tool confirmation (branch C): when the user CONFIRMS and the tool
 *   executes, the router IS called once (skipTools/skipTurnLog) to phrase the
 *   tool result. The router-NOT-called early return only happens for the
 *   blocked/"never" path. Both are pinned.
 * - Learning session gate (branch D): the router IS called (with the session
 *   system prompt + skipAutoTrigger), but orchestrator and selfMonitor are
 *   bypassed entirely.
 * No branches were dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { PlatformContext } from '../src/core/context.js';

// The policy-confirmation branch dynamically imports the real tool registry
// (heavy: network/DB-adjacent modules). Stub it so the branch is reachable
// without side effects.
vi.mock('../src/providers/tools/index.js', () => ({
  executeTool: vi.fn(async () => ({})),
}));

// Silence pino — a real logger.error write schedules a transport flush timer,
// which would trip the timer-leak assertions below (idiom from db-core.test.ts).
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { handleMessageInner } from '../src/platforms/telegram.js';

// ── Factories ────────────────────────────────────────────────

type ReplyFn = (text: string, opts?: { parse_mode?: string }) => Promise<unknown>;

function makeCtx(replyImpl?: ReplyFn) {
  const impl: ReplyFn = replyImpl ?? (async () => ({}));
  return {
    chat: { id: 12345 },
    message: { message_id: 1 },
    reply: vi.fn(impl),
    replyWithChatAction: vi.fn(async () => true),
    replyWithVoice: vi.fn(async () => ({})),
    replyWithDocument: vi.fn(async () => ({})),
  };
}

type Bags = Record<string, Record<string, unknown>>;

function makePc(overrides: Bags = {}) {
  const pc = {
    router: {
      sendMessage: vi.fn(async () => ({ text: 'hi', provider: 'ollama' as const })),
    },
    memory: {
      buildContext: vi.fn(async () => ''),
      saveConversationTurn: vi.fn(async () => {}),
    },
    autoSkills: {
      getPending: vi.fn(async (): Promise<unknown> => null),
      detectResponse: vi.fn((): 'approve' | 'reject' | null => null),
      handleResponse: vi.fn(async () => 'Skill created.'),
      expirePending: vi.fn(async () => {}),
      detectCorrection: vi.fn(() => false),
      shouldHeal: vi.fn(() => false),
      heal: vi.fn(async () => ({ patched: false, summary: '' })),
      enqueueHeal: vi.fn(),
      detectCandidate: vi.fn(async () => null),
      draftDefinition: vi.fn(async () => null),
      insertProposal: vi.fn(),
      proposeToUser: vi.fn(() => ''),
    },
    policyEngine: {
      getPendingConfirmation: vi.fn((): unknown => null),
      detectConfirmation: vi.fn((): 'once' | 'always' | 'never' | null => null),
      handleConfirmation: vi.fn(async () => ({ executed: false, result: null, message: '' })),
      clearPendingConfirmation: vi.fn(),
    },
    skills: {
      getActive: vi.fn(async () => null),
    },
    learning: {
      isSessionActive: vi.fn(() => false),
      getActiveSession: vi.fn((): unknown => undefined),
      touchSession: vi.fn(),
      getSessionSystemPrompt: vi.fn(async (): Promise<string | null> => null),
      processSessionResponse: vi.fn(async () => ({
        correct: 0, incorrect: 0, topicComplete: false, quizStarted: false,
      })),
      stripMarkers: vi.fn((t: string) => t),
      endSession: vi.fn(async () => ({ durationSeconds: 60, needsExpand: false })),
      formatSessionSummary: vi.fn(() => 'session summary'),
      getPlan: vi.fn(async () => null),
      buildExpandPrompt: vi.fn(async () => ''),
      parsePlanResponse: vi.fn(() => []),
      addExpansionTopics: vi.fn(),
      dismissSession: vi.fn(),
      completeTopicRemoval: vi.fn(),
      rejectTopicRemoval: vi.fn(() => ''),
    },
    orchestrator: {
      shouldOrchestrate: vi.fn(() => false),
      orchestrateTask: vi.fn(async () => ({ text: 'orchestration done', provider: 'claude' as const })),
    },
    selfMonitor: {
      checkQuality: vi.fn(() => ({ passed: true, score: 90, issues: [] })),
      logCheck: vi.fn(),
    },
    docgen: {
      isResponse: vi.fn(() => false),
      parseResponse: vi.fn(() => null),
      generate: vi.fn(),
      stripBlock: vi.fn((t: string) => t),
    },
    kanban: {
      isKanbanAction: vi.fn(() => false),
      parseKanbanAction: vi.fn(() => null),
      executeKanbanAction: vi.fn(),
      stripKanbanBlock: vi.fn((t: string) => t),
    },
    voice: {
      isVoiceMode: vi.fn(async () => false),
      capabilities: vi.fn(async () => ({ tts: false, stt: false })),
      synthesize: vi.fn(async () => Buffer.from('audio-bytes')),
    },
  };
  for (const [bag, fns] of Object.entries(overrides)) {
    Object.assign((pc as unknown as Record<string, Record<string, unknown>>)[bag], fns);
  }
  return pc;
}

type FakeCtx = ReturnType<typeof makeCtx>;
type FakePc = ReturnType<typeof makePc>;

function run(
  ctx: FakeCtx,
  rawText: string,
  pc: FakePc,
  opts: { forceVoiceReply?: boolean; skipTools?: boolean; isVoice?: boolean } = {},
): Promise<void> {
  return handleMessageInner(
    ctx as unknown as Context,
    rawText,
    pc as unknown as PlatformContext,
    opts.forceVoiceReply ?? false,
    opts.skipTools ?? false,
    opts.isVoice ?? false,
  );
}

const CHAT_ID = '12345';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────

describe('handleMessageInner — pending auto-skill proposal (branch A/B)', () => {
  it('A: approval of a pending proposal calls handleResponse(chatId, true), replies the confirmation in HTML, and never reaches the router', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      autoSkills: {
        getPending: vi.fn(async () => ({ id: 1, name: 'demo-skill' })),
        detectResponse: vi.fn(() => 'approve' as const),
        handleResponse: vi.fn(async () => 'Skill **demo-skill** created.'),
      },
    });

    await run(ctx, 'yes', pc);

    expect(pc.autoSkills.handleResponse).toHaveBeenCalledWith(CHAT_ID, true);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Skill <b>demo-skill</b> created.',
      { parse_mode: 'HTML' },
    );
    expect(pc.router.sendMessage).not.toHaveBeenCalled();
    expect(pc.autoSkills.expirePending).not.toHaveBeenCalled();
  });

  it('B: an unrelated message expires the pending proposal and the normal flow continues (router IS called)', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      autoSkills: {
        getPending: vi.fn(async () => ({ id: 1, name: 'demo-skill' })),
        detectResponse: vi.fn(() => null),
      },
    });

    await run(ctx, 'what is the weather?', pc);

    expect(pc.autoSkills.expirePending).toHaveBeenCalledWith(CHAT_ID);
    expect(pc.router.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('hi', { parse_mode: 'HTML' });
  });
});

describe('handleMessageInner — pending tool confirmation (branch C)', () => {
  it('C1: a "never" confirmation replies the status message and returns early — router and memory never touched', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      policyEngine: {
        getPendingConfirmation: vi.fn(() => ({
          toolName: 'demo_tool', args: {}, chatId: CHAT_ID, createdAt: 0,
        })),
        detectConfirmation: vi.fn(() => 'never' as const),
        handleConfirmation: vi.fn(async () => ({
          executed: false, result: null, message: 'Tool blocked.',
        })),
      },
    });

    await run(ctx, 'never', pc);

    expect(pc.policyEngine.handleConfirmation).toHaveBeenCalledWith(
      CHAT_ID, 'never', expect.any(Function),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Tool blocked.', { parse_mode: 'HTML' });
    expect(pc.router.sendMessage).not.toHaveBeenCalled();
    expect(pc.memory.buildContext).not.toHaveBeenCalled();
    expect(pc.policyEngine.clearPendingConfirmation).not.toHaveBeenCalled();
  });

  it('C2: a confirmed execution sends the tool result through the router (skipTools/skipTurnLog) and replies the AI phrasing — pinned reality: router IS called on this path', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      policyEngine: {
        getPendingConfirmation: vi.fn(() => ({
          toolName: 'demo_tool', args: {}, chatId: CHAT_ID, createdAt: 0,
        })),
        detectConfirmation: vi.fn(() => 'once' as const),
        handleConfirmation: vi.fn(async () => ({
          executed: true, result: { ok: true }, message: '',
        })),
      },
    });

    await run(ctx, 'confirm', pc);

    expect(pc.router.sendMessage).toHaveBeenCalledTimes(1);
    expect(pc.router.sendMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 'Tool "demo_tool" executed. Result: {"ok":true}',
      skipTools: true,
      skipTurnLog: true,
      platform: 'telegram',
    });
    expect(ctx.reply).toHaveBeenCalledWith('hi', { parse_mode: 'HTML' });
    // Early return: memory context is never built and no conversation turn saved
    expect(pc.memory.buildContext).not.toHaveBeenCalled();
    expect(pc.memory.saveConversationTurn).not.toHaveBeenCalled();
  });

  it('C3: a normal message while a confirmation is pending clears it and continues the normal flow', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      policyEngine: {
        getPendingConfirmation: vi.fn(() => ({
          toolName: 'demo_tool', args: {}, chatId: CHAT_ID, createdAt: 0,
        })),
        detectConfirmation: vi.fn(() => null),
      },
    });

    await run(ctx, 'tell me a joke', pc);

    expect(pc.policyEngine.clearPendingConfirmation).toHaveBeenCalledWith(CHAT_ID);
    expect(pc.policyEngine.handleConfirmation).not.toHaveBeenCalled();
    expect(pc.router.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('handleMessageInner — learning session gate (branch D)', () => {
  it('D: an active session routes through the router with the session system prompt; orchestrator and quality check are bypassed', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      learning: {
        isSessionActive: vi.fn(() => true),
        getSessionSystemPrompt: vi.fn(async () => 'TUTOR PROMPT'),
        getActiveSession: vi.fn(() => ({
          planId: 'plan-1', questionsAsked: 2, correctAnswers: 1, assessmentTarget: undefined,
        })),
        stripMarkers: vi.fn(() => 'clean answer'),
      },
      router: {
        sendMessage: vi.fn(async () => ({ text: 'raw answer [CORRECT]', provider: 'ollama' as const })),
      },
    });

    await run(ctx, 'what is recursion?', pc);

    expect(pc.learning.touchSession).toHaveBeenCalledWith(CHAT_ID);
    expect(pc.router.sendMessage).toHaveBeenCalledTimes(1);
    expect(pc.router.sendMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 'what is recursion?',
      rawUserMessage: 'what is recursion?',
      skipAutoTrigger: true,
      systemPrompt: 'TUTOR PROMPT',
      platform: 'telegram',
    });
    expect(pc.learning.processSessionResponse).toHaveBeenCalledWith(CHAT_ID, 'raw answer [CORRECT]');
    // Memory saved with the marker-stripped text
    expect(pc.memory.saveConversationTurn).toHaveBeenCalledWith(
      CHAT_ID, 'what is recursion?', 'clean answer',
    );
    expect(ctx.reply).toHaveBeenCalledWith('clean answer', { parse_mode: 'HTML' });
    // The learning path bypasses orchestration and self-monitoring entirely
    expect(pc.orchestrator.shouldOrchestrate).not.toHaveBeenCalled();
    expect(pc.selfMonitor.checkQuality).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // typing interval cleared
  });
});

describe('handleMessageInner — orchestration (branch E)', () => {
  it('E: shouldOrchestrate=true routes the memory-augmented message to orchestrateTask, saves the turn, and replies in HTML; router.sendMessage is never called', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      memory: {
        buildContext: vi.fn(async () => 'MEMORY CTX'),
        saveConversationTurn: vi.fn(async () => {}),
      },
      orchestrator: {
        shouldOrchestrate: vi.fn(() => true),
        orchestrateTask: vi.fn(async () => ({ text: 'orchestration done', provider: 'claude' as const })),
      },
    });

    await run(ctx, 'plan my week', pc);

    // shouldOrchestrate sees the RAW message; orchestrateTask gets the augmented one
    expect(pc.orchestrator.shouldOrchestrate).toHaveBeenCalledWith('plan my week');
    expect(pc.orchestrator.orchestrateTask).toHaveBeenCalledWith(
      pc.router, CHAT_ID, 'MEMORY CTX\n\nplan my week', expect.any(Function),
    );
    expect(pc.memory.saveConversationTurn).toHaveBeenCalledWith(
      CHAT_ID, 'plan my week', 'orchestration done',
    );
    expect(ctx.reply).toHaveBeenCalledWith('orchestration done', { parse_mode: 'HTML' });
    expect(pc.router.sendMessage).not.toHaveBeenCalled();
    // Post-send: quality check + auto-skill candidate detection run on the orchestrated response
    expect(pc.selfMonitor.checkQuality).toHaveBeenCalledTimes(1);
    expect(pc.autoSkills.detectCandidate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handleMessageInner — normal flow (branch F)', () => {
  it('F1: with memory context, the router receives the context-prefixed message and the raw text separately', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      memory: {
        buildContext: vi.fn(async () => 'CTX'),
        saveConversationTurn: vi.fn(async () => {}),
      },
    });

    await run(ctx, 'hello', pc);

    expect(pc.router.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: CHAT_ID,
      message: 'CTX\n\nhello',
      rawUserMessage: 'hello',
      skipTools: false,
      isVoice: false,
      platform: 'telegram',
    }));
    expect(ctx.reply).toHaveBeenCalledWith('hi', { parse_mode: 'HTML' });
    expect(pc.memory.saveConversationTurn).toHaveBeenCalledWith(CHAT_ID, 'hello', 'hi');
    expect(vi.getTimerCount()).toBe(0); // typing interval cleared in finally
  });

  it('F2: with empty memory context, the router receives the raw message unprefixed', async () => {
    const ctx = makeCtx();
    const pc = makePc(); // buildContext defaults to ''

    await run(ctx, 'hello', pc);

    expect(pc.router.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'hello',
      rawUserMessage: 'hello',
    }));
    expect(pc.memory.saveConversationTurn).toHaveBeenCalledWith(CHAT_ID, 'hello', 'hi');
  });

  it('F3: a typing chat action fires immediately and a 4s refresh interval is registered while the router is in flight', async () => {
    const ctx = makeCtx();
    let resolveRouter!: (v: { text: string; provider: 'ollama' }) => void;
    const pc = makePc({
      router: {
        sendMessage: vi.fn(() => new Promise((res) => { resolveRouter = res; })),
      },
    });

    const done = run(ctx, 'hello', pc);
    // Let the pre-router awaits (gates, buildContext) settle. Bounded drain
    // instead of a fixed tick count so the test doesn't couple to the exact
    // number of await boundaries on the path to router.sendMessage.
    for (let i = 0; i < 50 && !resolveRouter; i++) await Promise.resolve();

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
    expect(vi.getTimerCount()).toBe(1); // the 4s typing refresh interval

    resolveRouter({ text: 'hi', provider: 'ollama' });
    await done;
    expect(vi.getTimerCount()).toBe(0); // cleared after the response
  });
});

describe('handleMessageInner — voice mode (branch G)', () => {
  it('G: voice mode + TTS capability synthesizes the response, sends a voice note, and STILL sends the text afterward', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      voice: {
        isVoiceMode: vi.fn(async () => true),
        capabilities: vi.fn(async () => ({ tts: true, stt: true })),
        synthesize: vi.fn(async () => Buffer.from('audio-bytes')),
      },
    });

    await run(ctx, 'hello', pc);

    expect(pc.voice.synthesize).toHaveBeenCalledWith('hi');
    expect(ctx.replyWithVoice).toHaveBeenCalledTimes(1);
    // Text is always sent, even after a voice note
    expect(ctx.reply).toHaveBeenCalledWith('hi', { parse_mode: 'HTML' });
    // Voice note goes out before the text chunks
    expect(ctx.replyWithVoice.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.reply.mock.invocationCallOrder[0],
    );
  });
});

describe('handleMessageInner — error path (branch H)', () => {
  it('H: a router failure is swallowed and the user gets the apology message', async () => {
    const ctx = makeCtx();
    const pc = makePc({
      router: {
        sendMessage: vi.fn(async () => { throw new Error('provider down'); }),
      },
    });

    await expect(run(ctx, 'hello', pc)).resolves.toBeUndefined();

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('something went wrong'),
    );
    expect(pc.memory.saveConversationTurn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // finally clause clears the typing interval
  });
});

describe('skillHealingGate — non-blocking enqueue', () => {
  it('skillHealingGate enqueues a heal and never awaits it (non-blocking)', async () => {
    const { skillHealingGate } = await import('../src/core/message-gates.js');
    const io = { reply: vi.fn(async () => {}), replyChunks: vi.fn(async () => {}), replyPlain: vi.fn(async () => {}) };
    const pc = makePc({
      skills: { getActive: vi.fn(async () => ({ id: 's1', name: 's1', system_prompt: 'p' })) },
      autoSkills: {
        detectCorrection: vi.fn(() => true),
        // heal would hang forever if (wrongly) awaited:
        heal: vi.fn(() => new Promise(() => {})),
        enqueueHeal: vi.fn(),
      },
    });

    // Resolves promptly despite heal never resolving → proves no await on heal.
    await skillHealingGate(pc as never, CHAT_ID, 'no, that is wrong', io as never);

    expect(pc.autoSkills.enqueueHeal).toHaveBeenCalledTimes(1);
    expect(pc.autoSkills.heal).not.toHaveBeenCalled();

    // The gate wires onResult to reply only when the heal patched the skill.
    const req = (pc.autoSkills.enqueueHeal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    req.onResult({ patched: true, summary: 'improved' });
    expect(io.reply).toHaveBeenCalledWith('improved');

    io.reply.mockClear();
    req.onResult({ patched: false, summary: '' });
    expect(io.reply).not.toHaveBeenCalled();
  });
});

describe('handleMessageInner — HTML fallback (branch I)', () => {
  it('I: when Telegram rejects the HTML parse_mode, the chunk is retried as plain text', async () => {
    const ctx = makeCtx(async (_text, opts) => {
      if (opts?.parse_mode === 'HTML') throw new Error("Bad Request: can't parse entities");
      return {};
    });
    const pc = makePc();

    await run(ctx, 'hello', pc);

    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenNthCalledWith(1, 'hi', { parse_mode: 'HTML' });
    expect(ctx.reply).toHaveBeenNthCalledWith(2, 'hi');
    // The fallback handles it — the outer catch (apology) never fires
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('something went wrong'),
    );
  });
});
