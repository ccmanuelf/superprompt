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
});
