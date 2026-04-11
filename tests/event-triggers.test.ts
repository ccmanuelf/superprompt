import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  createEventTrigger,
  listEventTriggers,
  deleteEventTrigger,
  enableEventTrigger,
  disableEventTrigger,
  matchesCondition,
  processEvent,
  eventTriggerTableInit,
  EVENT_TYPES,
  type EventPayload,
} from '../src/event-triggers.js';

describe('event-triggers', () => {
  const CHAT_A = '111111';

  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await eventTriggerTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  describe('CRUD', () => {
    it('creates a trigger', async () => {
      const trigger = await createEventTrigger(
        CHAT_A,
        EVENT_TYPES.CARD_CREATED,
        { priority: 1 },
        'Alert: critical card created!',
      );
      expect(trigger.id).toHaveLength(32);
      expect(trigger.event_type).toBe('card.created');
      expect(trigger.enabled).toBe(1);
    });

    it('lists triggers for a chat', async () => {
      await createEventTrigger(CHAT_A, 'card.created', {}, 'action1');
      await createEventTrigger(CHAT_A, 'card.moved', {}, 'action2');
      await createEventTrigger('other', 'card.created', {}, 'action3');

      const triggers = await listEventTriggers(CHAT_A);
      expect(triggers).toHaveLength(2);
    });

    it('deletes a trigger', async () => {
      const trigger = await createEventTrigger(CHAT_A, 'card.created', {}, 'action');
      expect(await deleteEventTrigger(CHAT_A, trigger.id)).toBe(true);
      expect(await listEventTriggers(CHAT_A)).toHaveLength(0);
    });

    it('cannot delete another user\'s trigger', async () => {
      const trigger = await createEventTrigger(CHAT_A, 'card.created', {}, 'action');
      expect(await deleteEventTrigger('other', trigger.id)).toBe(false);
    });

    it('enables and disables triggers', async () => {
      const trigger = await createEventTrigger(CHAT_A, 'card.created', {}, 'action');
      await disableEventTrigger(trigger.id);
      let triggers = await listEventTriggers(CHAT_A);
      expect(triggers[0].enabled).toBe(0);

      await enableEventTrigger(trigger.id);
      triggers = await listEventTriggers(CHAT_A);
      expect(triggers[0].enabled).toBe(1);
    });
  });

  describe('matchesCondition', () => {
    it('matches when all keys match', () => {
      expect(matchesCondition({ priority: 1 }, { priority: 1, title: 'Test' })).toBe(true);
    });

    it('fails when key does not match', () => {
      expect(matchesCondition({ priority: 1 }, { priority: 2 })).toBe(false);
    });

    it('fails when key is missing', () => {
      expect(matchesCondition({ priority: 1 }, { title: 'Test' })).toBe(false);
    });

    it('matches empty condition against anything', () => {
      expect(matchesCondition({}, { whatever: 'value' })).toBe(true);
    });

    it('matches multiple conditions', () => {
      expect(matchesCondition(
        { priority: 1, status: 'backlog' },
        { priority: 1, status: 'backlog', title: 'Test' },
      )).toBe(true);
    });
  });

  describe('processEvent', () => {
    it('fires matching trigger', async () => {
      await createEventTrigger(CHAT_A, 'card.created', { priority: 1 }, 'Critical card alert!');

      const mockRouter = {
        sendMessage: vi.fn().mockResolvedValue({ text: 'Alert sent', provider: 'claude' as const }),
      };

      const event: EventPayload = {
        type: 'card.created',
        chatId: CHAT_A,
        data: { priority: 1, title: 'Urgent fix' },
        timestamp: Date.now(),
      };

      const fired = await processEvent(event, mockRouter as any);
      expect(fired).toBe(1);
      expect(mockRouter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not fire when condition does not match', async () => {
      await createEventTrigger(CHAT_A, 'card.created', { priority: 1 }, 'Critical only');

      const mockRouter = {
        sendMessage: vi.fn().mockResolvedValue({ text: 'ok', provider: 'claude' as const }),
      };

      const event: EventPayload = {
        type: 'card.created',
        chatId: CHAT_A,
        data: { priority: 3, title: 'Low priority' },
        timestamp: Date.now(),
      };

      const fired = await processEvent(event, mockRouter as any);
      expect(fired).toBe(0);
      expect(mockRouter.sendMessage).not.toHaveBeenCalled();
    });

    it('does not fire disabled triggers', async () => {
      const trigger = await createEventTrigger(CHAT_A, 'card.created', {}, 'action');
      await disableEventTrigger(trigger.id);

      const mockRouter = {
        sendMessage: vi.fn().mockResolvedValue({ text: 'ok', provider: 'claude' as const }),
      };

      const event: EventPayload = {
        type: 'card.created',
        chatId: CHAT_A,
        data: { title: 'Test' },
        timestamp: Date.now(),
      };

      const fired = await processEvent(event, mockRouter as any);
      expect(fired).toBe(0);
    });

    it('respects cooldown period', async () => {
      const trigger = await createEventTrigger(CHAT_A, 'card.created', {}, 'action', 60000);

      const mockRouter = {
        sendMessage: vi.fn().mockResolvedValue({ text: 'ok', provider: 'claude' as const }),
      };

      const event: EventPayload = {
        type: 'card.created',
        chatId: CHAT_A,
        data: { title: 'Test' },
        timestamp: Date.now(),
      };

      // First fire should succeed
      expect(await processEvent(event, mockRouter as any)).toBe(1);

      // Second fire within cooldown should be skipped
      expect(await processEvent(event, mockRouter as any)).toBe(0);
      expect(mockRouter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('logs events in event_log', async () => {
      await createEventTrigger(CHAT_A, 'card.created', {}, 'action');

      const mockRouter = {
        sendMessage: vi.fn().mockResolvedValue({ text: 'Done', provider: 'claude' as const }),
      };

      await processEvent({
        type: 'card.created',
        chatId: CHAT_A,
        data: { title: 'Test' },
        timestamp: Date.now(),
      }, mockRouter as any);

      const logs = await testKnex('event_log').select('*');
      expect(logs).toHaveLength(1);
      expect(logs[0].success).toBe(1);
      expect(logs[0].event_type).toBe('card.created');
    });
  });
});
