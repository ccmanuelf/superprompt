import { randomBytes } from 'node:crypto';
import { getDatabase } from './db.js';
import { logger } from './logger.js';

// ── Response-Format Kanban Action Detection ─────────────────
// Same pattern as docgen: AI outputs a JSON block, platform handler detects and executes it.
// This allows BOTH providers (Claude and Ollama) to manage the board.

/**
 * Regex to detect kanban action JSON blocks in AI responses.
 * Matches: ```json\n{"kanban_action": "create", ...}\n```
 */
const KANBAN_ACTION_REGEX = /```(?:json)?\s*\n?\s*(\{[\s\S]*?"kanban_action"\s*:[\s\S]*?\})\s*\n?\s*```/;

export interface KanbanActionRequest {
  kanban_action: 'create' | 'move' | 'assign';
  title?: string;
  description?: string;
  assignee?: CardAssignee;
  priority?: number;
  labels?: string[];
  card_id?: string;
  status?: CardStatus;
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
    if (!['create', 'move', 'assign'].includes(parsed.kanban_action)) return null;
    return parsed as KanbanActionRequest;
  } catch {
    return null;
  }
}

/**
 * Execute a kanban action from an AI response and return a user-facing message.
 * Exported for testing.
 */
export function executeKanbanAction(chatId: string, action: KanbanActionRequest): string {
  switch (action.kanban_action) {
    case 'create': {
      if (!action.title) return 'Kanban action error: title required for create.';
      const card = createCard(chatId, action.title, {
        description: action.description,
        assignee: action.assignee || 'me',
        priority: action.priority || 3,
        labels: action.labels,
        source: 'bot',
      });
      return `📋 Added to board: **${card.title}** [${card.assignee}] — ID: \`${card.id.slice(0, 8)}\``;
    }
    case 'move': {
      if (!action.card_id || !action.status) return 'Kanban action error: card_id and status required.';
      const card = getCardByPrefix(chatId, action.card_id);
      if (!card) return `Card "${action.card_id}" not found.`;
      const moved = moveCard(card.id, action.status, chatId);
      if (!moved) return `Invalid status: ${action.status}`;
      return `Moved **${moved.title}** → ${moved.status}`;
    }
    case 'assign': {
      if (!action.card_id || !action.assignee) return 'Kanban action error: card_id and assignee required.';
      const card = getCardByPrefix(chatId, action.card_id);
      if (!card) return `Card "${action.card_id}" not found.`;
      const assigned = assignCard(card.id, action.assignee, chatId);
      if (!assigned) return `Invalid assignee: ${action.assignee}`;
      return `Assigned **${assigned.title}** → ${assigned.assignee}`;
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
  due_date: number | null; // epoch ms
  source: 'user' | 'bot'; // who created it
  created_at: number;
  updated_at: number;
}

const VALID_STATUSES: CardStatus[] = ['backlog', 'in_progress', 'review', 'done', 'deferred', 'cancelled'];
const VALID_ASSIGNEES: CardAssignee[] = ['me', 'bot', 'collaborative', 'noted'];

/**
 * Initialize the kanban table. Called during DB init.
 */
export function initKanbanTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'in_progress', 'review', 'done', 'deferred', 'cancelled')),
      assignee TEXT NOT NULL DEFAULT 'me' CHECK(assignee IN ('me', 'bot', 'collaborative', 'noted')),
      priority INTEGER NOT NULL DEFAULT 3,
      labels TEXT,
      due_date INTEGER,
      source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'bot')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_chat_status
      ON kanban_cards(chat_id, status);
  `);
}

// ── CRUD Operations ─────────────────────────────────────────

export function createCard(
  chatId: string,
  title: string,
  options?: {
    description?: string;
    assignee?: CardAssignee;
    priority?: number;
    labels?: string[];
    dueDate?: number;
    source?: 'user' | 'bot';
  },
): KanbanCard {
  const db = getDatabase();
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
    source: options?.source || 'user',
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO kanban_cards (id, chat_id, title, description, status, assignee, priority, labels, due_date, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(card.id, card.chat_id, card.title, card.description, card.status, card.assignee, card.priority, card.labels, card.due_date, card.source, card.created_at, card.updated_at);

  logger.debug({ cardId: id, chatId, title }, 'Kanban card created');
  return card;
}

export function getCard(id: string): KanbanCard | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined;
}

export function getCardByPrefix(chatId: string, prefix: string): KanbanCard | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM kanban_cards WHERE chat_id = ? AND id LIKE ? LIMIT 1',
  ).get(chatId, `${prefix}%`) as KanbanCard | undefined;
}

export function listCards(chatId: string, status?: CardStatus): KanbanCard[] {
  const db = getDatabase();
  if (status) {
    return db.prepare(
      'SELECT * FROM kanban_cards WHERE chat_id = ? AND status = ? ORDER BY priority ASC, updated_at DESC',
    ).all(chatId, status) as KanbanCard[];
  }
  return db.prepare(
    'SELECT * FROM kanban_cards WHERE chat_id = ? AND status NOT IN (?, ?) ORDER BY priority ASC, updated_at DESC',
  ).all(chatId, 'done', 'cancelled') as KanbanCard[];
}

export function listAllCards(chatId: string): KanbanCard[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM kanban_cards WHERE chat_id = ? ORDER BY status, priority ASC, updated_at DESC',
  ).all(chatId) as KanbanCard[];
}

export function moveCard(id: string, newStatus: CardStatus, chatId?: string): KanbanCard | null {
  if (!VALID_STATUSES.includes(newStatus)) return null;

  const db = getDatabase();
  // If chatId provided, enforce ownership
  if (chatId) {
    const card = getCard(id);
    if (!card || card.chat_id !== chatId) return null;
  }

  db.prepare(
    'UPDATE kanban_cards SET status = ?, updated_at = ? WHERE id = ?',
  ).run(newStatus, Date.now(), id);

  return getCard(id) || null;
}

export function assignCard(id: string, assignee: CardAssignee, chatId?: string): KanbanCard | null {
  if (!VALID_ASSIGNEES.includes(assignee)) return null;

  const db = getDatabase();
  if (chatId) {
    const card = getCard(id);
    if (!card || card.chat_id !== chatId) return null;
  }

  db.prepare(
    'UPDATE kanban_cards SET assignee = ?, updated_at = ? WHERE id = ?',
  ).run(assignee, Date.now(), id);

  return getCard(id) || null;
}

export function updateCard(
  id: string,
  updates: Partial<Pick<KanbanCard, 'title' | 'description' | 'priority' | 'due_date'>>,
): KanbanCard | null {
  const db = getDatabase();
  const card = getCard(id);
  if (!card) return null;

  db.prepare(
    `UPDATE kanban_cards SET
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       priority = COALESCE(?, priority),
       due_date = COALESCE(?, due_date),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    updates.title ?? null,
    updates.description ?? null,
    updates.priority ?? null,
    updates.due_date ?? null,
    Date.now(),
    id,
  );

  return getCard(id) || null;
}

export function deleteCard(id: string, chatId?: string): boolean {
  const db = getDatabase();
  if (chatId) {
    const card = getCard(id);
    if (!card || card.chat_id !== chatId) return false;
  }
  const result = db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Bot-Assigned Task Execution ─────────────────────────────

/**
 * Get cards assigned to the bot that are in backlog (ready to work on).
 * The scheduler uses this to pick up bot-assigned tasks.
 */
export function getBotAssignedCards(chatId: string): KanbanCard[] {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM kanban_cards
     WHERE chat_id = ? AND assignee = 'bot' AND status = 'backlog'
     ORDER BY priority ASC, created_at ASC
     LIMIT 3`,
  ).all(chatId) as KanbanCard[];
}

/**
 * Get all distinct chat IDs that have bot-assigned backlog cards.
 */
export function getChatsWithBotTasks(): string[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT DISTINCT chat_id FROM kanban_cards
     WHERE assignee = 'bot' AND status = 'backlog'`,
  ).all() as Array<{ chat_id: string }>;
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

export function getBoardSummary(chatId: string): BoardSummary {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM kanban_cards WHERE chat_id = ? GROUP BY status',
  ).all(chatId) as Array<{ status: string; count: number }>;

  const summary: BoardSummary = {
    backlog: 0, in_progress: 0, review: 0, done: 0, deferred: 0, cancelled: 0, total: 0,
  };

  for (const row of rows) {
    if (row.status in summary) {
      (summary as unknown as Record<string, number>)[row.status] = row.count;
    }
    summary.total += row.count;
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
export function formatBoard(chatId: string): string {
  const summary = getBoardSummary(chatId);

  if (summary.total === 0) {
    return 'Board is empty. Use `/board add <title>` to create a card.';
  }

  const sections: string[] = [];
  const header = `📊 **Board** (${summary.total} cards)\n`;
  sections.push(header);

  for (const status of ['backlog', 'in_progress', 'review', 'done', 'deferred'] as CardStatus[]) {
    const cards = listCards(chatId, status);
    if (cards.length === 0) continue;

    const statusLabel = `${STATUS_EMOJI[status]} ${status.replace('_', ' ').toUpperCase()} (${cards.length})`;
    const cardLines = cards.slice(0, 10).map((c) =>
      `  \`${c.id.slice(0, 8)}\` ${PRIORITY_LABEL[c.priority]?.split(' ')[0] || '🟡'} ${c.title} [${ASSIGNEE_LABEL[c.assignee]}]`,
    );
    sections.push(`${statusLabel}\n${cardLines.join('\n')}`);
  }

  return sections.join('\n\n');
}
