import { randomBytes } from 'node:crypto';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Response-Format Kanban Action Detection ─────────────────
// Same pattern as docgen: AI outputs a JSON block, platform handler detects and executes it.
// This allows BOTH providers (Claude and Ollama) to manage the board.

/**
 * Regex to detect kanban action JSON blocks in AI responses.
 * Matches: ```json\n{"kanban_action": "create", ...}\n```
 */
const KANBAN_ACTION_REGEX = /```(?:json)?\s*\n?\s*(\{[\s\S]*?"kanban_action"\s*:[\s\S]*?\})\s*\n?\s*```/;

export interface KanbanActionRequest {
  kanban_action: 'create' | 'move' | 'assign' | 'update';
  title?: string;
  description?: string;
  assignee?: CardAssignee;
  priority?: number;
  labels?: string[];
  card_id?: string;
  status?: CardStatus;
  due_date?: string; // ISO date or natural language
  scheduled_for?: string; // ISO datetime or "tonight", "tomorrow morning"
}

/**
 * Parse a natural language or ISO date string to epoch ms.
 * Handles: "tonight", "tomorrow", "tomorrow morning", ISO dates.
 * Exported for testing.
 */
export function parseDateHint(hint: string): number | null {
  if (!hint) return null;
  const lower = hint.toLowerCase().trim();
  const now = new Date();

  if (lower === 'tonight') {
    const d = new Date(now); d.setHours(22, 0, 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (lower === 'tomorrow' || lower === 'tomorrow morning') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  if (lower === 'tomorrow evening' || lower === 'tomorrow night') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(22, 0, 0, 0);
    return d.getTime();
  }
  if (lower === 'now' || lower === 'immediately') {
    return now.getTime();
  }
  // Try ISO date parsing
  const parsed = new Date(hint);
  if (!isNaN(parsed.getTime())) return parsed.getTime();

  return null;
}

/**
 * Detect if an AI response contains a kanban action JSON block.
 * Works for BOTH Claude and Ollama responses.
 * Exported for testing.
 */
export function isKanbanAction(text: string): boolean {
  return KANBAN_ACTION_REGEX.test(text);
}

/**
 * Parse a kanban action from AI response text.
 * Exported for testing.
 */
export function parseKanbanAction(text: string): KanbanActionRequest | null {
  const match = text.match(KANBAN_ACTION_REGEX);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.kanban_action) return null;
    if (!['create', 'move', 'assign', 'update'].includes(parsed.kanban_action)) return null;
    return parsed as KanbanActionRequest;
  } catch {
    return null;
  }
}

/**
 * Execute a kanban action from an AI response and return a user-facing message.
 * Exported for testing.
 */
export async function executeKanbanAction(chatId: string, action: KanbanActionRequest): Promise<string> {
  switch (action.kanban_action) {
    case 'create': {
      if (!action.title) return 'Kanban action error: title required for create.';
      const dueDate = action.due_date ? parseDateHint(action.due_date) : undefined;
      const scheduledFor = action.scheduled_for ? parseDateHint(action.scheduled_for) : undefined;
      const card = await createCard(chatId, action.title, {
        description: action.description,
        assignee: action.assignee || 'noted',
        priority: action.priority || 3,
        labels: action.labels,
        dueDate: dueDate ?? undefined,
        scheduledFor: scheduledFor ?? undefined,
        source: 'bot',
      });
      let msg = `📋 Added to board: **${card.title}** [${card.assignee}] — ID: \`${card.id.slice(0, 8)}\``;
      if (card.due_date) msg += `\nDue: ${new Date(card.due_date).toLocaleDateString()}`;
      if (card.scheduled_for) msg += `\nScheduled: ${new Date(card.scheduled_for).toLocaleString()}`;
      return msg;
    }
    case 'move': {
      if (!action.card_id || !action.status) return 'Kanban action error: card_id and status required.';
      const card = await getCardByPrefix(chatId, action.card_id);
      if (!card) return `Card "${action.card_id}" not found.`;
      const moved = await moveCard(card.id, action.status, chatId);
      if (!moved) return `Invalid status: ${action.status}`;
      return `Moved **${moved.title}** → ${moved.status}`;
    }
    case 'assign': {
      if (!action.card_id || !action.assignee) return 'Kanban action error: card_id and assignee required.';
      const card = await getCardByPrefix(chatId, action.card_id);
      if (!card) return `Card "${action.card_id}" not found.`;
      const assigned = await assignCard(card.id, action.assignee, chatId);
      if (!assigned) return `Invalid assignee: ${action.assignee}`;
      return `Assigned **${assigned.title}** → ${assigned.assignee}`;
    }
    case 'update': {
      if (!action.card_id) return 'Kanban action error: card_id required for update.';
      const card = await getCardByPrefix(chatId, action.card_id);
      if (!card) return `Card "${action.card_id}" not found.`;

      const updates: Record<string, unknown> = {};
      if (action.priority !== undefined) updates.priority = action.priority;
      if (action.due_date) updates.due_date = parseDateHint(action.due_date);
      if (action.scheduled_for) updates.scheduled_for = parseDateHint(action.scheduled_for);

      if (Object.keys(updates).length === 0) return 'Nothing to update.';

      const updated = await updateCard(card.id, updates);
      if (!updated) return 'Update failed.';

      const changes: string[] = [];
      if (action.priority !== undefined) changes.push(`priority → ${action.priority}`);
      if (action.due_date) changes.push(`due → ${new Date(updated.due_date!).toLocaleDateString()}`);
      if (action.scheduled_for) changes.push(`scheduled → ${new Date(updated.scheduled_for!).toLocaleString()}`);
      return `Updated **${updated.title}**: ${changes.join(', ')}`;
    }
    default:
      return `Unknown kanban action: ${action.kanban_action}`;
  }
}

/**
 * Strip the kanban action JSON block from the response text.
 */
export function stripKanbanBlock(text: string): string {
  return text.replace(KANBAN_ACTION_REGEX, '').trim();
}

/**
 * Kanban board — shared task tracking between user and bot.
 *
 * Cards flow through: Backlog → In Progress → Review → Done
 * Additional columns: Deferred, Cancelled
 *
 * Assignee types:
 * - 'me'            — user handles this
 * - 'bot'           — clauded works on it autonomously
 * - 'collaborative' — both work together
 * - 'noted'         — reference only, no action needed
 */

export type CardStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'deferred' | 'cancelled';
export type CardAssignee = 'me' | 'bot' | 'collaborative' | 'noted';

export interface KanbanCard {
  id: string;
  chat_id: string;
  title: string;
  description: string;
  status: CardStatus;
  assignee: CardAssignee;
  priority: number; // 1 = highest, 5 = lowest
  labels: string | null; // JSON array
  due_date: number | null; // epoch ms — deadline (when it should be DONE)
  scheduled_for: number | null; // epoch ms — when to START (bot tasks)
  source: 'user' | 'bot'; // who created it
  created_at: number;
  updated_at: number;
}

const VALID_STATUSES: CardStatus[] = ['backlog', 'in_progress', 'review', 'done', 'deferred', 'cancelled'];
const VALID_ASSIGNEES: CardAssignee[] = ['me', 'bot', 'collaborative', 'noted'];

/**
 * Initialize the kanban table. Called during DB init.
 */
export async function initKanbanTable(): Promise<void> {
  const db = getKnex();

  const exists = await db.schema.hasTable('kanban_cards');
  if (!exists) {
    await db.schema.createTable('kanban_cards', (table) => {
      table.string('id').primary();
      table.string('chat_id').notNullable();
      table.string('title').notNullable();
      table.text('description').notNullable().defaultTo('');
      table.string('status').notNullable().defaultTo('backlog');
      table.string('assignee').notNullable().defaultTo('noted');
      table.integer('priority').notNullable().defaultTo(3);
      table.text('labels').nullable();
      table.bigInteger('due_date').nullable();
      table.bigInteger('scheduled_for').nullable();
      table.string('source').notNullable().defaultTo('user');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['chat_id', 'status'], 'idx_kanban_chat_status');
    });
  }

  // Migration: add scheduled_for column if not exists
  const hasScheduledFor = await db.schema.hasColumn('kanban_cards', 'scheduled_for');
  if (!hasScheduledFor) {
    await db.schema.alterTable('kanban_cards', (table) => {
      table.bigInteger('scheduled_for').nullable();
    });
  }
}

export const kanbanTableInit: TableInitializer = { name: 'kanban', initTables: initKanbanTable };

// ── CRUD Operations ─────────────────────────────────────────

export async function createCard(
  chatId: string,
  title: string,
  options?: {
    description?: string;
    assignee?: CardAssignee;
    priority?: number;
    labels?: string[];
    dueDate?: number;
    scheduledFor?: number;
    source?: 'user' | 'bot';
  },
): Promise<KanbanCard> {
  const db = getKnex();
  const id = randomBytes(6).toString('hex');
  const now = Date.now();

  const card: KanbanCard = {
    id,
    chat_id: chatId,
    title,
    description: options?.description || '',
    status: 'backlog',
    assignee: options?.assignee || 'noted',
    priority: options?.priority || 3,
    labels: options?.labels ? JSON.stringify(options.labels) : null,
    due_date: options?.dueDate || null,
    scheduled_for: options?.scheduledFor || null,
    source: options?.source || 'user',
    created_at: now,
    updated_at: now,
  };

  await db('kanban_cards').insert(card);

  // Emit event for trigger system
  try {
    const { emitEvent, EVENT_TYPES } = await import('./event-triggers.js');
    emitEvent({
      type: EVENT_TYPES.CARD_CREATED,
      chatId,
      data: { cardId: id, title, priority: card.priority, assignee: card.assignee, status: card.status },
      timestamp: now,
    });
  } catch { /* event system may not be initialized */ }

  logger.debug({ cardId: id, chatId, title }, 'Kanban card created');
  return card;
}

export async function getCard(id: string): Promise<KanbanCard | undefined> {
  const db = getKnex();
  return await db('kanban_cards').where({ id }).first() as KanbanCard | undefined;
}

export async function getCardByPrefix(chatId: string, prefix: string): Promise<KanbanCard | undefined> {
  const db = getKnex();
  return await db('kanban_cards')
    .where({ chat_id: chatId })
    .andWhere('id', 'like', `${prefix}%`)
    .first() as KanbanCard | undefined;
}

export async function listCards(chatId: string, status?: CardStatus): Promise<KanbanCard[]> {
  const db = getKnex();
  if (status) {
    return await db('kanban_cards')
      .where({ chat_id: chatId, status })
      .orderBy('priority', 'asc')
      .orderBy('updated_at', 'desc') as KanbanCard[];
  }
  return await db('kanban_cards')
    .where({ chat_id: chatId })
    .whereNotIn('status', ['done', 'cancelled'])
    .orderBy('priority', 'asc')
    .orderBy('updated_at', 'desc') as KanbanCard[];
}

export async function listAllCards(chatId: string): Promise<KanbanCard[]> {
  const db = getKnex();
  return await db('kanban_cards')
    .where({ chat_id: chatId })
    .orderBy('status', 'asc')
    .orderBy('priority', 'asc')
    .orderBy('updated_at', 'desc') as KanbanCard[];
}

export async function moveCard(id: string, newStatus: CardStatus, chatId?: string): Promise<KanbanCard | null> {
  if (!VALID_STATUSES.includes(newStatus)) return null;

  const db = getKnex();
  // If chatId provided, enforce ownership
  if (chatId) {
    const card = await getCard(id);
    if (!card || card.chat_id !== chatId) return null;
  }

  await db('kanban_cards').where({ id }).update({ status: newStatus, updated_at: Date.now() });

  const movedCard = await getCard(id) || null;

  // Emit event for trigger system
  if (movedCard) {
    try {
      const { emitEvent, EVENT_TYPES } = await import('./event-triggers.js');
      emitEvent({
        type: EVENT_TYPES.CARD_MOVED,
        chatId: movedCard.chat_id,
        data: { cardId: id, newStatus, title: movedCard.title, priority: movedCard.priority },
        timestamp: Date.now(),
      });
    } catch { /* event system may not be initialized */ }
  }

  return movedCard;
}

export async function assignCard(id: string, assignee: CardAssignee, chatId?: string): Promise<KanbanCard | null> {
  if (!VALID_ASSIGNEES.includes(assignee)) return null;

  if (chatId) {
    const card = await getCard(id);
    if (!card || card.chat_id !== chatId) return null;
  }

  const db = getKnex();
  await db('kanban_cards').where({ id }).update({ assignee, updated_at: Date.now() });

  return await getCard(id) || null;
}

export async function updateCard(
  id: string,
  updates: Partial<Pick<KanbanCard, 'title' | 'description' | 'priority' | 'due_date' | 'scheduled_for'>>,
  chatId?: string,
): Promise<KanbanCard | null> {
  const card = await getCard(id);
  if (!card) return null;
  if (chatId && card.chat_id !== chatId) return null;

  // Build dynamic UPDATE — use explicit null to CLEAR fields
  const updateData: Record<string, unknown> = { updated_at: Date.now() };

  if ('title' in updates && updates.title !== undefined) updateData.title = updates.title;
  if ('description' in updates && updates.description !== undefined) updateData.description = updates.description;
  if ('priority' in updates && updates.priority !== undefined) updateData.priority = updates.priority;
  // For dates: allow explicit null to CLEAR the field
  if ('due_date' in updates) updateData.due_date = updates.due_date ?? null;
  if ('scheduled_for' in updates) updateData.scheduled_for = updates.scheduled_for ?? null;

  const db = getKnex();
  await db('kanban_cards').where({ id }).update(updateData);

  return await getCard(id) || null;
}

export async function deleteCard(id: string, chatId?: string): Promise<boolean> {
  if (chatId) {
    const card = await getCard(id);
    if (!card || card.chat_id !== chatId) return false;
  }
  const db = getKnex();
  const count = await db('kanban_cards').where({ id }).del();
  return count > 0;
}

// ── Bot-Assigned Task Execution ─────────────────────────────

/**
 * Get cards assigned to the bot that are ready to execute.
 *
 * Priority-based scheduling:
 * - Priority 1-2 (critical/high): execute immediately (no schedule check)
 * - Priority 3-5 (medium/low/minimal): only execute during scheduled window
 *   or if scheduled_for <= now
 *
 * Default scheduled window: 22:00-06:00 local time (nightly).
 * Cards with explicit scheduled_for override the window.
 */
export async function getBotAssignedCards(chatId: string): Promise<KanbanCard[]> {
  const db = getKnex();
  const now = Date.now();

  // Priority 1-2: always ready (immediate execution)
  const urgent = await db('kanban_cards')
    .where({ chat_id: chatId, assignee: 'bot', status: 'backlog' })
    .andWhere('priority', '<=', 2)
    .orderBy('priority', 'asc')
    .orderBy('created_at', 'asc')
    .limit(3) as KanbanCard[];

  // Priority 3-5: only during nightly window OR if scheduled_for has passed
  const hour = new Date().getHours();
  const isNightWindow = hour >= 22 || hour < 6;

  const scheduled = await db('kanban_cards')
    .where({ chat_id: chatId, assignee: 'bot', status: 'backlog' })
    .andWhere('priority', '>', 2)
    .andWhere(function () {
      this.where(function () {
        this.whereNotNull('scheduled_for').andWhere('scheduled_for', '<=', now);
      });
      if (isNightWindow) {
        this.orWhereNull('scheduled_for');
      }
    })
    .orderBy('priority', 'asc')
    .orderBy('created_at', 'asc')
    .limit(3) as KanbanCard[];

  return [...urgent, ...scheduled].slice(0, 5);
}

/**
 * Get all distinct chat IDs that have bot-assigned backlog cards.
 */
export async function getChatsWithBotTasks(): Promise<string[]> {
  const db = getKnex();
  const rows = await db('kanban_cards')
    .distinct('chat_id')
    .where({ assignee: 'bot', status: 'backlog' }) as Array<{ chat_id: string }>;
  return rows.map((r) => r.chat_id);
}

// ── Board Summary ───────────────────────────────────────────

export interface BoardSummary {
  backlog: number;
  in_progress: number;
  review: number;
  done: number;
  deferred: number;
  cancelled: number;
  total: number;
}

export async function getBoardSummary(chatId: string): Promise<BoardSummary> {
  const db = getKnex();
  const rows = await db('kanban_cards')
    .select('status')
    .count('* as count')
    .where({ chat_id: chatId })
    .groupBy('status') as Array<{ status: string; count: number }>;

  const summary: BoardSummary = {
    backlog: 0, in_progress: 0, review: 0, done: 0, deferred: 0, cancelled: 0, total: 0,
  };

  for (const row of rows) {
    if (row.status in summary) {
      (summary as unknown as Record<string, number>)[row.status] = Number(row.count);
    }
    summary.total += Number(row.count);
  }

  return summary;
}

// ── Formatting ──────────────────────────────────────────────

const STATUS_EMOJI: Record<CardStatus, string> = {
  backlog: '📋',
  in_progress: '🔄',
  review: '👀',
  done: '✅',
  deferred: '⏸️',
  cancelled: '🚫',
};

const ASSIGNEE_LABEL: Record<CardAssignee, string> = {
  me: '👤 Me',
  bot: '🤖 Bot',
  collaborative: '🤝 Collab',
  noted: '📝 Noted',
};

const PRIORITY_LABEL: Record<number, string> = {
  1: '🔴 Critical',
  2: '🟠 High',
  3: '🟡 Medium',
  4: '🔵 Low',
  5: '⚪ Minimal',
};

/**
 * Format a card for display in Telegram/Matrix.
 * Exported for testing.
 */
export function formatCard(card: KanbanCard): string {
  const lines = [
    `${STATUS_EMOJI[card.status]} **${card.title}**`,
    `ID: \`${card.id}\` | ${ASSIGNEE_LABEL[card.assignee]} | ${PRIORITY_LABEL[card.priority] || 'P' + card.priority}`,
  ];

  if (card.description) {
    lines.push(card.description.length > 100
      ? card.description.slice(0, 100) + '...'
      : card.description);
  }

  if (card.due_date) {
    lines.push(`Due: ${new Date(card.due_date).toLocaleDateString()}`);
  }

  if (card.labels) {
    try {
      const labels = JSON.parse(card.labels) as string[];
      if (labels.length) lines.push(`Labels: ${labels.join(', ')}`);
    } catch { /* ignore */ }
  }

  return lines.join('\n');
}

/**
 * Format the full board for Telegram/Matrix display.
 * Exported for testing.
 */
export async function formatBoard(chatId: string): Promise<string> {
  const summary = await getBoardSummary(chatId);

  if (summary.total === 0) {
    return 'Board is empty. Use `/board add <title>` to create a card.';
  }

  const sections: string[] = [];
  const header = `📊 **Board** (${summary.total} cards)\n`;
  sections.push(header);

  for (const status of ['backlog', 'in_progress', 'review', 'done', 'deferred'] as CardStatus[]) {
    const cards = await listCards(chatId, status);
    if (cards.length === 0) continue;

    const statusLabel = `${STATUS_EMOJI[status]} ${status.replace('_', ' ').toUpperCase()} (${cards.length})`;
    const cardLines = cards.slice(0, 10).map((c) =>
      `  \`${c.id.slice(0, 8)}\` ${PRIORITY_LABEL[c.priority]?.split(' ')[0] || '🟡'} ${c.title} [${ASSIGNEE_LABEL[c.assignee]}]`,
    );
    sections.push(`${statusLabel}\n${cardLines.join('\n')}`);
  }

  return sections.join('\n\n');
}
