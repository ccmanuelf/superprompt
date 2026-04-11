/**
 * Event-driven triggers — reactive agent autonomy.
 *
 * Instead of only time-based (cron) scheduling, events from the database
 * can trigger agent actions automatically:
 *
 * - "When a new card is created with priority 1, notify the team"
 * - "When a card moves to 'done', run a quality check"
 * - "When a new order arrives in /hub, run shortage analysis"
 *
 * Architecture:
 * - event_triggers table stores trigger rules
 * - Modules emit events via emitEvent()
 * - EventProcessor matches events against rules and executes actions
 * - Actions are executed via the router (same as scheduled tasks)
 */

import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';
import type { ProviderRouter } from './providers/router.js';

// ── Types ──────────────────────────────────────────────────

export interface EventTrigger {
  id: string;
  chat_id: string;
  event_type: string;         // e.g. 'card.created', 'card.moved', 'order.created'
  condition: string;          // JSON condition: {"priority": 1} or {"status": "done"}
  action_prompt: string;      // What to tell the AI when the trigger fires
  enabled: number;
  cooldown_ms: number;        // Minimum time between trigger fires (prevent loops)
  last_fired_at: number | null;
  created_at: number;
}

export interface EventPayload {
  type: string;               // e.g. 'card.created'
  chatId: string;
  data: Record<string, unknown>; // Event-specific data
  timestamp: number;
}

// ── Table ──────────────────────────────────────────────────

async function initEventTriggerTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('event_triggers'))) {
    await db.schema.createTable('event_triggers', (t) => {
      t.string('id').primary();
      t.string('chat_id').notNullable();
      t.string('event_type').notNullable();
      t.text('condition').notNullable().defaultTo('{}');
      t.text('action_prompt').notNullable();
      t.integer('enabled').notNullable().defaultTo(1);
      t.integer('cooldown_ms').notNullable().defaultTo(60000); // 1 minute default
      t.bigInteger('last_fired_at').nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['chat_id', 'event_type']);
      t.index(['enabled']);
    });
  }

  if (!(await db.schema.hasTable('event_log'))) {
    await db.schema.createTable('event_log', (t) => {
      t.increments('id').primary();
      t.string('trigger_id').notNullable();
      t.string('event_type').notNullable();
      t.text('event_data').nullable();
      t.text('result').nullable();
      t.integer('success').notNullable().defaultTo(1);
      t.bigInteger('fired_at').notNullable();
      t.index(['trigger_id', 'fired_at']);
    });
  }
}

export const eventTriggerTableInit: TableInitializer = {
  name: 'event-triggers',
  initTables: initEventTriggerTables,
};

// ── CRUD ───────────────────────────────────────────────────

export async function createEventTrigger(
  chatId: string,
  eventType: string,
  condition: Record<string, unknown>,
  actionPrompt: string,
  cooldownMs: number = 60000,
): Promise<EventTrigger> {
  const db = getKnex();
  const { randomBytes } = await import('node:crypto');
  const id = randomBytes(16).toString('hex');
  const now = Date.now();

  const trigger: EventTrigger = {
    id,
    chat_id: chatId,
    event_type: eventType,
    condition: JSON.stringify(condition),
    action_prompt: actionPrompt,
    enabled: 1,
    cooldown_ms: cooldownMs,
    last_fired_at: null,
    created_at: now,
  };

  await db('event_triggers').insert(trigger);
  logger.info({ chatId, eventType, id }, 'Event trigger created');
  return trigger;
}

export async function listEventTriggers(chatId: string): Promise<EventTrigger[]> {
  const db = getKnex();
  return db('event_triggers').where({ chat_id: chatId }).orderBy('created_at', 'desc');
}

export async function deleteEventTrigger(chatId: string, triggerId: string): Promise<boolean> {
  const db = getKnex();
  const count = await db('event_triggers').where({ id: triggerId, chat_id: chatId }).del();
  return count > 0;
}

export async function enableEventTrigger(triggerId: string): Promise<void> {
  await getKnex()('event_triggers').where({ id: triggerId }).update({ enabled: 1 });
}

export async function disableEventTrigger(triggerId: string): Promise<void> {
  await getKnex()('event_triggers').where({ id: triggerId }).update({ enabled: 0 });
}

// ── Event Processing ───────────────────────────────────────

/**
 * Check if event data matches a trigger's condition.
 * Condition is a JSON object — all keys must match the event data.
 * Supports simple equality matching.
 */
export function matchesCondition(condition: Record<string, unknown>, data: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(condition)) {
    if (data[key] !== value) return false;
  }
  return true;
}

/**
 * Process an event — find matching triggers and execute their actions.
 * Returns the number of triggers that fired.
 */
export async function processEvent(
  event: EventPayload,
  router: ProviderRouter,
  notifyFn?: (chatId: string, text: string) => Promise<void>,
): Promise<number> {
  const db = getKnex();
  const now = Date.now();

  // Find enabled triggers matching this event type and chat
  const triggers = await db('event_triggers')
    .where({ event_type: event.type, enabled: 1 })
    .where(function () {
      // Match triggers for this specific chat OR global triggers (chat_id = '')
      this.where({ chat_id: event.chatId }).orWhere({ chat_id: '' });
    }) as EventTrigger[];

  let fired = 0;

  for (const trigger of triggers) {
    // Check cooldown
    if (trigger.last_fired_at && (now - trigger.last_fired_at) < trigger.cooldown_ms) {
      logger.debug({ triggerId: trigger.id, cooldownMs: trigger.cooldown_ms }, 'Event trigger skipped (cooldown)');
      continue;
    }

    // Check condition
    const condition = JSON.parse(trigger.condition) as Record<string, unknown>;
    if (Object.keys(condition).length > 0 && !matchesCondition(condition, event.data)) {
      continue;
    }

    // Fire the trigger — send action prompt to AI
    logger.info({
      triggerId: trigger.id,
      eventType: event.type,
      chatId: event.chatId,
    }, 'AUDIT: event trigger fired');

    try {
      const response = await router.sendMessage({
        chatId: trigger.chat_id || event.chatId,
        message: `[EVENT TRIGGER: ${event.type}]\n\nEvent data: ${JSON.stringify(event.data)}\n\nAction: ${trigger.action_prompt}`,
        skipAutoTrigger: true,
      });

      // Update last fired timestamp
      await db('event_triggers').where({ id: trigger.id }).update({ last_fired_at: now });

      // Log the event
      await db('event_log').insert({
        trigger_id: trigger.id,
        event_type: event.type,
        event_data: JSON.stringify(event.data),
        result: (response.text || '').slice(0, 1000),
        success: 1,
        fired_at: now,
      });

      // Notify user of the trigger result
      if (notifyFn && response.text) {
        await notifyFn(
          trigger.chat_id || event.chatId,
          `🔔 **Event Trigger / Evento**: ${event.type}\n${response.text}`,
        );
      }

      fired++;
    } catch (err) {
      logger.warn({ err, triggerId: trigger.id }, 'Event trigger action failed');

      await db('event_log').insert({
        trigger_id: trigger.id,
        event_type: event.type,
        event_data: JSON.stringify(event.data),
        result: (err as Error).message,
        success: 0,
        fired_at: now,
      });
    }
  }

  return fired;
}

// ── Event Emitter (called by modules) ─────────────────────

let routerRef: ProviderRouter | null = null;
let notifyRef: ((chatId: string, text: string) => Promise<void>) | null = null;

/**
 * Initialize the event system with router and notify function.
 * Called during application startup.
 */
export function initEventSystem(router: ProviderRouter, notifyFn?: (chatId: string, text: string) => Promise<void>): void {
  routerRef = router;
  notifyRef = notifyFn || null;
  logger.info('Event trigger system initialized');
}

/**
 * Emit an event — called by any module when something happens.
 * Non-blocking: event processing runs asynchronously.
 *
 * Usage:
 *   emitEvent({ type: 'card.created', chatId, data: { title, priority } });
 *   emitEvent({ type: 'card.moved', chatId, data: { cardId, newStatus } });
 *   emitEvent({ type: 'order.created', chatId, data: { orderId, customer } });
 */
export function emitEvent(event: EventPayload): void {
  if (!routerRef) {
    logger.debug({ event: event.type }, 'Event emitted but event system not initialized');
    return;
  }

  // Process asynchronously — don't block the caller
  processEvent(event, routerRef, notifyRef || undefined).catch((err) => {
    logger.warn({ err, eventType: event.type }, 'Event processing failed');
  });
}

// ── Pre-defined event types ───────────────────────────────

export const EVENT_TYPES = {
  CARD_CREATED: 'card.created',
  CARD_MOVED: 'card.moved',
  CARD_ASSIGNED: 'card.assigned',
  CARD_DELETED: 'card.deleted',
  MEMORY_SAVED: 'memory.saved',
  TASK_COMPLETED: 'task.completed',
  SKILL_TRIGGERED: 'skill.triggered',
  ORDER_CREATED: 'order.created',
  SHORTAGE_DETECTED: 'shortage.detected',
} as const;
