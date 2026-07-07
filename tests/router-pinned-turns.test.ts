/**
 * Pipeline surgery Task 9 fix pass — pinned-turn lifecycle.
 *
 * `pinnedTurns` (per-turn NovaLink-data pin state) was only cleared inside
 * `if (session?.auto_route && message)`. A chat that pinned once while
 * auto_route was on, then had auto_route disabled, kept a stale pin forever
 * — every later (unrelated, non-pinned) failed local turn would then
 * over-fire the soft Claude governance fallback in `sendMessage`, because
 * that check reads `pinnedTurns.has(chatId)` unconditionally.
 *
 * Real Knex (in-memory sqlite) via the same mocking pattern as
 * tests/db-core.test.ts — `getProviderForChat` reads/writes the real
 * `sessions` table through `getSession`/`setAutoRoute`. `getProviderForChat`
 * and `pinnedTurns` are TS-`private`, not JS `#private`, so they're reached
 * directly off the instance (cast to `any`) rather than through the much
 * heavier `sendMessage` (rate limiter, usage counters, skills, etc).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { coreTableInit, setSession, setAutoRoute } from '../src/db-core.js';
import { ProviderRouter } from '../src/providers/router.js';

describe('pinned-turn lifecycle across auto_route toggling', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  it('clears a stale pin once auto_route is disabled, even on a later non-pinned turn', async () => {
    const chatId = 'chat-pin-lifecycle';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;

    // Turn 1: auto_route on, NovaLink-data message -> pins to local.
    await router.getProviderForChat(chatId, 'how many open shortages does company 1054 have?');
    expect(router.pinnedTurns.has(chatId)).toBe(true);

    // User disables auto_route between turns (e.g. /autoroute off).
    await setAutoRoute(chatId, false);

    // Turn 2: auto_route off, ordinary unrelated message — no reason to pin.
    await router.getProviderForChat(chatId, 'hello there');

    // The stale pin from turn 1 must not survive into turn 2's bookkeeping.
    expect(router.pinnedTurns.has(chatId)).toBe(false);
  });

  it('does not pin on a non-NovaLink-data turn even while auto_route is on', async () => {
    const chatId = 'chat-no-pin';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;
    await router.getProviderForChat(chatId, 'tell me a joke');
    expect(router.pinnedTurns.has(chatId)).toBe(false);
  });

  // Final-review fix wave: the pin must classify RAW user text, not the
  // memory-enriched `message` (memoryContext + '\n\n' + rawText). Recalled
  // memory content about past NovaLink data (shortages/companies) must not
  // pin an otherwise-innocent turn — every other new classifier on this
  // branch already prefers rawUserMessage; the pin was the odd one out.
  it('does NOT pin when only the memory-enriched message contains NovaLink content but the raw text is innocent', async () => {
    const chatId = 'chat-memory-enriched-no-pin';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;
    const rawMessage = 'thanks, sounds good';
    const enrichedMessage = `MEMORY: company 1054 shortage discussed last week\n\n${rawMessage}`;

    await router.getProviderForChat(chatId, enrichedMessage, rawMessage);
    expect(router.pinnedTurns.has(chatId)).toBe(false);
  });

  it('still pins when the raw text itself contains NovaLink content, memory prefix or not', async () => {
    const chatId = 'chat-raw-pins';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;
    const rawMessage = 'how many open shortages does company 1054 have?';
    const enrichedMessage = `MEMORY: unrelated prior chat about vacation plans\n\n${rawMessage}`;

    await router.getProviderForChat(chatId, enrichedMessage, rawMessage);
    expect(router.pinnedTurns.has(chatId)).toBe(true);
  });
});

describe('auto-route classifyMessage reads rawMessage, not the memory-enriched message', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // Live-verified bug: getProviderForChat classified the memory-enriched
  // `message` (memoryContext + '\n\n' + rawText). Memory recall routinely
  // adds ~1500 tokens, pushing nearly every turn past LONG_MESSAGE_THRESHOLD
  // (500 chars) regardless of what the user actually typed — a 47-char
  // question was observed routing to Claude in prod. The pin (Gap fixed
  // earlier on this file) already classifies `rawMessage ?? message`;
  // classifyMessage must get the same treatment so the length heuristic
  // judges what the user wrote, not the recalled context prepended to it.
  it('routes a short raw message with a long memory prefix to ollama', async () => {
    const chatId = 'chat-classify-raw-short';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;
    const rawMessage = 'thanks, that clears it up, appreciate the help!'; // 48 chars
    const memoryPadding = 'lorem ipsum recalled memory context filler text. '.repeat(15); // >500 chars
    const enrichedMessage = `${memoryPadding}\n\n${rawMessage}`;
    expect(enrichedMessage.length).toBeGreaterThan(500);

    await router.getProviderForChat(chatId, enrichedMessage, rawMessage);
    expect(router.lastUsedProvider.get(chatId)).toBe('ollama');
  });

  it('still routes a genuinely long raw message to claude', async () => {
    const chatId = 'chat-classify-raw-long';
    await setSession(chatId, '', 'ollama');
    await setAutoRoute(chatId, true);

    const router = new ProviderRouter() as any;
    const rawMessage = 'please walk me through this in as much depth as possible: '.repeat(15); // >500 chars, no tool/reasoning patterns
    expect(rawMessage.length).toBeGreaterThan(500);

    await router.getProviderForChat(chatId, `${rawMessage}\n\nextra memory context`, rawMessage);
    expect(router.lastUsedProvider.get(chatId)).toBe('claude');
  });
});

describe('newChat clears bucket hysteresis', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  it('clears chatBuckets so a new conversation starts in core, not the last active bucket', async () => {
    const chatId = 'chat-newchat-buckets';
    await setSession(chatId, '', 'ollama');

    const router = new ProviderRouter() as any;
    router.chatBuckets.set(chatId, 'docs');
    expect(router.chatBuckets.has(chatId)).toBe(true);

    await router.newChat(chatId);

    expect(router.chatBuckets.has(chatId)).toBe(false);
  });
});
