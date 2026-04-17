/**
 * rc.69 — chat_log table: cross-provider conversation continuity.
 *
 * Guards the bridge's ground truth: the DB layer that keeps verbatim
 * turns and supports bounded retention. If this table or its
 * accessors silently misbehave, provider switches will either lose
 * context (nothing to seed) or degrade into unbounded growth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getKnex: () => testKnex,
    getDbDriver: () => 'sqlite',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  appendChatLog,
  getRecentChatLog,
  pruneChatLog,
  pruneAllChatLogs,
} from '../src/db-core.js';

async function createChatLogTable(): Promise<void> {
  await testKnex.schema.createTable('chat_log', (t) => {
    t.increments('id').primary();
    t.string('chat_id').notNullable();
    t.string('role').notNullable();
    t.string('provider').notNullable();
    t.text('content').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['chat_id', 'created_at']);
  });
}

describe('chat_log (rc.69)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await createChatLogTable();
  });

  afterEach(async () => {
    if (testKnex) await testKnex.destroy();
  });

  describe('appendChatLog + getRecentChatLog', () => {
    it('roundtrips turns in chronological order', async () => {
      await appendChatLog('chat-A', 'user', 'claude', 'Hello there');
      await appendChatLog('chat-A', 'assistant', 'claude', 'Hi! How can I help?');
      await appendChatLog('chat-A', 'user', 'ollama', 'Switching providers now');
      await appendChatLog('chat-A', 'assistant', 'ollama', 'Got it');

      const recent = await getRecentChatLog('chat-A', 10);

      expect(recent).toHaveLength(4);
      expect(recent.map((r) => r.content)).toEqual([
        'Hello there',
        'Hi! How can I help?',
        'Switching providers now',
        'Got it',
      ]);
      expect(recent.map((r) => r.provider)).toEqual(['claude', 'claude', 'ollama', 'ollama']);
      expect(recent.map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('returns the last N turns in chronological order when limit < total', async () => {
      for (let i = 1; i <= 6; i++) {
        await appendChatLog('chat-A', 'user', 'ollama', `msg-${i}`);
      }
      const recent = await getRecentChatLog('chat-A', 3);
      expect(recent.map((r) => r.content)).toEqual(['msg-4', 'msg-5', 'msg-6']);
    });

    it('isolates turns per chat_id', async () => {
      await appendChatLog('chat-A', 'user', 'claude', 'from A');
      await appendChatLog('chat-B', 'user', 'claude', 'from B');

      const a = await getRecentChatLog('chat-A', 10);
      const b = await getRecentChatLog('chat-B', 10);
      expect(a.map((r) => r.content)).toEqual(['from A']);
      expect(b.map((r) => r.content)).toEqual(['from B']);
    });
  });

  describe('pruneChatLog', () => {
    it('keeps the latest N, deletes older', async () => {
      for (let i = 1; i <= 10; i++) {
        await appendChatLog('chat-A', 'user', 'ollama', `msg-${i}`);
      }

      const deleted = await pruneChatLog('chat-A', 4);
      expect(deleted).toBe(6);

      const remaining = await getRecentChatLog('chat-A', 10);
      expect(remaining.map((r) => r.content)).toEqual(['msg-7', 'msg-8', 'msg-9', 'msg-10']);
    });

    it('is a no-op when row count is already <= keepLatest', async () => {
      await appendChatLog('chat-A', 'user', 'ollama', 'only one');
      const deleted = await pruneChatLog('chat-A', 5);
      expect(deleted).toBe(0);
      const remaining = await getRecentChatLog('chat-A', 10);
      expect(remaining).toHaveLength(1);
    });
  });

  describe('pruneAllChatLogs', () => {
    it('prunes every chat down to keepPerChat', async () => {
      for (let i = 1; i <= 5; i++) await appendChatLog('chat-A', 'user', 'claude', `A-${i}`);
      for (let i = 1; i <= 3; i++) await appendChatLog('chat-B', 'user', 'ollama', `B-${i}`);
      for (let i = 1; i <= 7; i++) await appendChatLog('chat-C', 'user', 'ollama', `C-${i}`);

      const totalDeleted = await pruneAllChatLogs(2);
      // A: 5 -> 2 (deleted 3), B: 3 -> 2 (deleted 1), C: 7 -> 2 (deleted 5)
      expect(totalDeleted).toBe(9);

      expect((await getRecentChatLog('chat-A', 10)).map((r) => r.content))
        .toEqual(['A-4', 'A-5']);
      expect((await getRecentChatLog('chat-B', 10)).map((r) => r.content))
        .toEqual(['B-2', 'B-3']);
      expect((await getRecentChatLog('chat-C', 10)).map((r) => r.content))
        .toEqual(['C-6', 'C-7']);
    });
  });

  // rc.70 — cleanup sweep for rows polluted before rawUserMessage/skipTurnLog
  // were wired up. These patterns represent the two known pollution sources:
  //  1. memory-prefixed user messages (platform-layer leak)
  //  2. internal auto-skill drafter/healer metaprompts
  describe('polluted-row cleanup (rc.70 startup sweep)', () => {
    it('deletes [RETRIEVED MEMORY ... and skill metaprompt rows, preserves clean turns', async () => {
      await appendChatLog('chat-X', 'user', 'ollama', '[RETRIEVED MEMORY — stored context] - User: hello');
      await appendChatLog('chat-X', 'assistant', 'ollama', 'Hi there (clean response)');
      await appendChatLog('chat-X', 'user', 'ollama', 'You are creating a reusable skill definition based on a successful workflow. ORIGINAL USER REQUEST: ...');
      await appendChatLog('chat-X', 'assistant', 'ollama', '{ "name": "some-skill", ... }');
      await appendChatLog('chat-X', 'user', 'claude', 'A genuinely clean user message');
      await appendChatLog('chat-X', 'assistant', 'claude', 'A genuinely clean reply');
      await appendChatLog('chat-X', 'user', 'ollama', 'You are improving an existing skill that had an issue during use.');

      // Mirror the cleanup query from db-core.ts createCoreTables
      const deleted = await testKnex('chat_log')
        .where('content', 'like', '[RETRIEVED MEMORY%')
        .orWhere('content', 'like', 'You are creating a reusable skill definition%')
        .orWhere('content', 'like', 'You are improving an existing skill%')
        .del();

      expect(deleted).toBe(3);

      const remaining = await getRecentChatLog('chat-X', 20);
      expect(remaining.map((r) => r.content)).toEqual([
        'Hi there (clean response)',
        '{ "name": "some-skill", ... }',
        'A genuinely clean user message',
        'A genuinely clean reply',
      ]);
    });

    it('is idempotent — second run deletes 0', async () => {
      await appendChatLog('chat-Y', 'user', 'ollama', '[RETRIEVED MEMORY — bad]');
      await appendChatLog('chat-Y', 'assistant', 'ollama', 'ok');

      const first = await testKnex('chat_log')
        .where('content', 'like', '[RETRIEVED MEMORY%')
        .del();
      const second = await testKnex('chat_log')
        .where('content', 'like', '[RETRIEVED MEMORY%')
        .del();

      expect(first).toBe(1);
      expect(second).toBe(0);
    });
  });
});
