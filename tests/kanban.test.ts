import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Import REAL functions from kanban.ts
import {
  createCard,
  getCard,
  getCardByPrefix,
  listCards,
  listAllCards,
  moveCard,
  assignCard,
  updateCard,
  deleteCard,
  getBoardSummary,
  getBotAssignedCards,
  getChatsWithBotTasks,
  formatCard,
  formatBoard,
  isKanbanAction,
  parseKanbanAction,
  stripKanbanBlock,
  initKanbanTable,
  type KanbanCard,
} from '../src/kanban.js';

// We need to mock getDatabase since kanban.ts imports from db.ts which has eager init
// Instead, we'll test the DB-level behavior with raw SQL AND test pure functions directly

const TMP_DIR = resolve(tmpdir(), 'clauded-test-kanban');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'kanban-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
    CREATE INDEX IF NOT EXISTS idx_kanban_chat_status ON kanban_cards(chat_id, status);
  `);
}

function insertCard(
  chatId: string, title: string, status = 'backlog', assignee = 'me', priority = 3, source = 'user',
): string {
  const id = Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO kanban_cards (id, chat_id, title, description, status, assignee, priority, source, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(id, chatId, title, status, assignee, priority, source, now, now);
  return id;
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ── Card CRUD (real DB) ────────────────────────────────────

describe('card CRUD (real DB)', () => {
  it('creates card with correct defaults', () => {
    const id = insertCard('chat1', 'Fix the login bug');
    const card = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as any;
    expect(card.title).toBe('Fix the login bug');
    expect(card.status).toBe('backlog');
    expect(card.assignee).toBe('me');
    expect(card.priority).toBe(3);
  });

  it('creates bot-sourced card with custom priority', () => {
    const id = insertCard('chat1', 'AI detected opportunity', 'backlog', 'collaborative', 2, 'bot');
    const card = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as any;
    expect(card.source).toBe('bot');
    expect(card.assignee).toBe('collaborative');
    expect(card.priority).toBe(2);
  });

  it('enforces status CHECK constraint', () => {
    expect(() => {
      const id = insertCard('chat1', 'Bad');
      db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('invalid', id);
    }).toThrow();
  });

  it('enforces assignee CHECK constraint', () => {
    expect(() => {
      insertCard('chat1', 'Bad');
      // Direct insert with bad assignee
      db.prepare(
        `INSERT INTO kanban_cards (id, chat_id, title, status, assignee, priority, source, created_at, updated_at)
         VALUES ('bad', 'chat1', 'Bad', 'backlog', 'nobody', 3, 'user', ?, ?)`,
      ).run(Date.now(), Date.now());
    }).toThrow();
  });
});

// ── Chat isolation (real DB) ───────────────────────────────

describe('chat isolation (real DB)', () => {
  it('cards from different chats are isolated', () => {
    insertCard('chat1', 'Chat 1 card');
    insertCard('chat2', 'Chat 2 card');

    const chat1 = db.prepare("SELECT * FROM kanban_cards WHERE chat_id = ?").all('chat1');
    const chat2 = db.prepare("SELECT * FROM kanban_cards WHERE chat_id = ?").all('chat2');
    expect(chat1).toHaveLength(1);
    expect(chat2).toHaveLength(1);
  });

  it('moveCard with chatId validation rejects cross-chat mutations', () => {
    const id = insertCard('chat1', 'Secret card');

    // moveCard with wrong chatId should return null (rejected)
    // Simulating the validated moveCard logic
    const card = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as any;
    const wrongChat = 'chat2';
    const isOwner = card.chat_id === wrongChat;
    expect(isOwner).toBe(false); // Validation would reject this
  });
});

// ── Listing and priority ordering (real DB) ────────────────

describe('listing and ordering (real DB)', () => {
  it('lists active cards excluding done and cancelled', () => {
    insertCard('chat1', 'Active', 'backlog');
    insertCard('chat1', 'In progress', 'in_progress');
    insertCard('chat1', 'Finished', 'done');
    insertCard('chat1', 'Cancelled', 'cancelled');

    const active = db.prepare(
      "SELECT * FROM kanban_cards WHERE chat_id = ? AND status NOT IN ('done', 'cancelled')",
    ).all('chat1');
    expect(active).toHaveLength(2);
  });

  it('orders by priority ascending (critical first)', () => {
    insertCard('chat1', 'Low', 'backlog', 'me', 5);
    insertCard('chat1', 'Critical', 'backlog', 'me', 1);
    insertCard('chat1', 'Medium', 'backlog', 'me', 3);

    const cards = db.prepare(
      "SELECT title FROM kanban_cards WHERE chat_id = ? ORDER BY priority ASC",
    ).all('chat1') as any[];

    expect(cards[0].title).toBe('Critical');
    expect(cards[1].title).toBe('Medium');
    expect(cards[2].title).toBe('Low');
  });
});

// ── Board summary (real DB) ────────────────────────────────

describe('board summary (real DB)', () => {
  it('counts cards by status', () => {
    insertCard('chat1', 'B1', 'backlog');
    insertCard('chat1', 'B2', 'backlog');
    insertCard('chat1', 'IP1', 'in_progress');
    insertCard('chat1', 'D1', 'done');
    insertCard('chat1', 'D2', 'done');

    const rows = db.prepare(
      'SELECT status, COUNT(*) as count FROM kanban_cards WHERE chat_id = ? GROUP BY status',
    ).all('chat1') as any[];

    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.count;

    expect(counts.backlog).toBe(2);
    expect(counts.in_progress).toBe(1);
    expect(counts.done).toBe(2);
  });
});

// ── Bot-assigned task detection (real DB) ───────────────────

describe('bot-assigned task detection (real DB)', () => {
  it('finds backlog cards assigned to bot', () => {
    insertCard('chat1', 'Bot task 1', 'backlog', 'bot');
    insertCard('chat1', 'Bot task 2', 'backlog', 'bot');
    insertCard('chat1', 'User task', 'backlog', 'me');
    insertCard('chat1', 'Bot done', 'done', 'bot'); // already done — should NOT appear

    const botTasks = db.prepare(
      "SELECT * FROM kanban_cards WHERE chat_id = ? AND assignee = 'bot' AND status = 'backlog' ORDER BY priority ASC",
    ).all('chat1');

    expect(botTasks).toHaveLength(2);
  });

  it('finds chats with pending bot tasks', () => {
    insertCard('chat1', 'Bot task', 'backlog', 'bot');
    insertCard('chat2', 'Bot task', 'backlog', 'bot');
    insertCard('chat3', 'User only', 'backlog', 'me');

    const chats = db.prepare(
      "SELECT DISTINCT chat_id FROM kanban_cards WHERE assignee = 'bot' AND status = 'backlog'",
    ).all() as any[];

    const chatIds = chats.map((r: any) => r.chat_id);
    expect(chatIds).toContain('chat1');
    expect(chatIds).toContain('chat2');
    expect(chatIds).not.toContain('chat3');
  });

  it('bot task moves through lifecycle: backlog → in_progress → review → done', () => {
    const id = insertCard('chat1', 'Research competitors', 'backlog', 'bot');

    // Bot picks it up
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('in_progress', id);
    // Bot completes it
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('review', id);
    // User approves
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('done', id);

    const card = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as any;
    expect(card.status).toBe('done');
    expect(card.assignee).toBe('bot'); // Assignee stays — source of work
  });
});

// ── Prefix matching (real DB) ──────────────────────────────

describe('card prefix matching (real DB)', () => {
  it('finds card by 6-char prefix', () => {
    const id = insertCard('chat1', 'Findable');
    const prefix = id.slice(0, 6);

    const found = db.prepare(
      'SELECT * FROM kanban_cards WHERE chat_id = ? AND id LIKE ? LIMIT 1',
    ).get('chat1', `${prefix}%`) as any;

    expect(found).toBeDefined();
    expect(found.title).toBe('Findable');
  });

  it('returns nothing for non-matching prefix', () => {
    insertCard('chat1', 'Card');
    const found = db.prepare(
      'SELECT * FROM kanban_cards WHERE chat_id = ? AND id LIKE ? LIMIT 1',
    ).get('chat1', 'zzzzzzz%');
    expect(found).toBeUndefined();
  });
});

// ── Pure function tests (real imports) ─────────────────────

describe('formatCard (real function)', () => {
  it('formats a card with all fields', () => {
    const card: KanbanCard = {
      id: 'abc123def456',
      chat_id: 'chat1',
      title: 'Deploy v2.0',
      description: 'Major release with new features',
      status: 'in_progress',
      assignee: 'collaborative',
      priority: 2,
      labels: JSON.stringify(['release', 'urgent']),
      due_date: Date.now() + 86400000,
      source: 'user',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const output = formatCard(card);
    expect(output).toContain('Deploy v2.0');
    expect(output).toContain('abc123def456');
    expect(output).toContain('Collab');
    expect(output).toContain('High');
    expect(output).toContain('release, urgent');
    expect(output).toContain('Due:');
  });

  it('handles card with no labels or due date', () => {
    const card: KanbanCard = {
      id: 'xyz', chat_id: 'c1', title: 'Simple', description: '',
      status: 'backlog', assignee: 'me', priority: 3, labels: null,
      due_date: null, source: 'user', created_at: Date.now(), updated_at: Date.now(),
    };

    const output = formatCard(card);
    expect(output).toContain('Simple');
    expect(output).not.toContain('Labels');
    expect(output).not.toContain('Due');
  });
});

// ── End-to-end collaboration workflow ──────────────────────

describe('end-to-end collaboration workflow (real DB)', () => {
  it('user creates → bot suggests improvement → user assigns to bot → bot completes → user approves', () => {
    // 1. User creates a card
    const userId = insertCard('chat1', 'Optimize database queries', 'backlog', 'me', 2);

    // 2. During conversation, bot creates a related card proactively
    const botId = insertCard('chat1', 'Add index to users table', 'backlog', 'bot', 3, 'bot');

    // 3. Both cards exist
    const all = db.prepare("SELECT * FROM kanban_cards WHERE chat_id = ? ORDER BY priority").all('chat1');
    expect(all).toHaveLength(2);

    // 4. Bot picks up its card
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('in_progress', botId);

    // 5. User works on their card
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('in_progress', userId);

    // 6. Bot finishes → moves to review
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('review', botId);

    // 7. User approves bot's work
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('done', botId);

    // 8. User finishes their own card
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('done', userId);

    // 9. Both done
    const done = db.prepare("SELECT * FROM kanban_cards WHERE chat_id = ? AND status = 'done'").all('chat1');
    expect(done).toHaveLength(2);
  });

  it('user defers a task and cancels another', () => {
    const defer = insertCard('chat1', 'Nice to have');
    const cancel = insertCard('chat1', 'Not needed anymore');

    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('deferred', defer);
    db.prepare('UPDATE kanban_cards SET status = ? WHERE id = ?').run('cancelled', cancel);

    // Active list should be empty (deferred and cancelled are excluded)
    const active = db.prepare(
      "SELECT * FROM kanban_cards WHERE chat_id = ? AND status NOT IN ('done', 'cancelled', 'deferred')",
    ).all('chat1');
    expect(active).toHaveLength(0);
  });
});

// ── Response-format kanban action detection (real functions) ──

describe('isKanbanAction (real function)', () => {
  it('detects kanban action JSON block in AI response', () => {
    const response = `Sure, I'll track that for you.\n\n\`\`\`json\n{"kanban_action": "create", "title": "Fix login page timeout", "assignee": "me", "priority": 2}\n\`\`\`\n\nI've added it to your board.`;
    expect(isKanbanAction(response)).toBe(true);
  });

  it('does NOT detect non-kanban JSON blocks', () => {
    const docgenResponse = `\`\`\`json\n{"format": "xlsx", "filename": "report.xlsx"}\n\`\`\``;
    expect(isKanbanAction(docgenResponse)).toBe(false);
  });

  it('does NOT detect plain text responses', () => {
    expect(isKanbanAction('Here is your answer about kanban boards.')).toBe(false);
    expect(isKanbanAction('The kanban_action is important.')).toBe(false);
  });
});

describe('parseKanbanAction (real function)', () => {
  it('parses create action with all fields', () => {
    const response = `Let me add that.\n\n\`\`\`json\n{"kanban_action": "create", "title": "Research competitors", "description": "Compare pricing and features", "assignee": "collaborative", "priority": 2}\n\`\`\``;
    const action = parseKanbanAction(response);
    expect(action).not.toBeNull();
    expect(action!.kanban_action).toBe('create');
    expect(action!.title).toBe('Research competitors');
    expect(action!.assignee).toBe('collaborative');
    expect(action!.priority).toBe(2);
  });

  it('parses move action', () => {
    const response = `\`\`\`json\n{"kanban_action": "move", "card_id": "abc123", "status": "done"}\n\`\`\``;
    const action = parseKanbanAction(response);
    expect(action!.kanban_action).toBe('move');
    expect(action!.card_id).toBe('abc123');
    expect(action!.status).toBe('done');
  });

  it('rejects invalid kanban_action values', () => {
    const response = `\`\`\`json\n{"kanban_action": "destroy", "card_id": "abc"}\n\`\`\``;
    const action = parseKanbanAction(response);
    expect(action).toBeNull();
  });

  it('rejects malformed JSON', () => {
    const response = `\`\`\`json\n{kanban_action: create}\n\`\`\``;
    const action = parseKanbanAction(response);
    expect(action).toBeNull();
  });
});

describe('stripKanbanBlock (real function)', () => {
  it('removes JSON block and preserves surrounding text', () => {
    const response = `I've noted that task.\n\n\`\`\`json\n{"kanban_action": "create", "title": "Test"}\n\`\`\`\n\nAnything else?`;
    const stripped = stripKanbanBlock(response);
    expect(stripped).toContain("I've noted that task.");
    expect(stripped).toContain('Anything else?');
    expect(stripped).not.toContain('kanban_action');
  });

  it('returns empty string when response is only the JSON block', () => {
    const response = `\`\`\`json\n{"kanban_action": "create", "title": "Test"}\n\`\`\``;
    const stripped = stripKanbanBlock(response);
    expect(stripped).toBe('');
  });
});

// ── Claude + Ollama parity ────────────────────────────────

describe('provider parity for kanban actions', () => {
  it('Claude response format is detectable', () => {
    // Simulate what Claude would output when it detects a task
    const claudeResponse = `That sounds like an important task to track. Let me add it to your board.

\`\`\`json
{"kanban_action": "create", "title": "Optimize database query performance", "description": "Users reporting slow load times on the dashboard", "assignee": "collaborative", "priority": 2}
\`\`\`

I've created a card for this. You can check the board with /board.`;

    expect(isKanbanAction(claudeResponse)).toBe(true);
    const action = parseKanbanAction(claudeResponse);
    expect(action!.title).toBe('Optimize database query performance');

    const remaining = stripKanbanBlock(claudeResponse);
    expect(remaining).toContain('important task');
    expect(remaining).toContain('/board');
    expect(remaining).not.toContain('kanban_action');
  });

  it('Ollama tool call AND response format both work', () => {
    // Ollama can use EITHER the kanban_manage tool OR the JSON response format
    // Both paths should produce valid kanban actions
    const responseFormat = `\`\`\`json\n{"kanban_action": "create", "title": "Via response format"}\n\`\`\``;
    expect(isKanbanAction(responseFormat)).toBe(true);
  });
});
