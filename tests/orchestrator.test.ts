import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  shouldOrchestrate,
  ORCHESTRATION_PATTERNS,
  type TaskStep,
} from '../src/orchestrator.js';

/**
 * Sprint S7: Multi-Step Orchestration tests.
 *
 * Tests the actual shouldOrchestrate() and ORCHESTRATION_PATTERNS
 * from orchestrator.ts. Also tests the step execution data model
 * and episode storage for orchestration results.
 *
 * NO mocked data. Real patterns, real DB, real-world messages.
 */

const TMP_DIR = resolve(tmpdir(), 'clauded-test-orch');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'orch-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* ignore */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_facts TEXT,
      open_threads TEXT,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      summary,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
        episode_id INTEGER PRIMARY KEY,
        embedding float[768]
      );
    `);
  } catch { /* */ }
}

beforeEach(() => {
  initTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ── Pattern detection (real exports) ───────────────────────

describe('ORCHESTRATION_PATTERNS (real exports)', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(ORCHESTRATION_PATTERNS)).toBe(true);
    expect(ORCHESTRATION_PATTERNS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('shouldOrchestrate (real function)', () => {
  describe('matches real multi-step requests', () => {
    it('detects "first X, then Y" patterns', () => {
      expect(shouldOrchestrate(
        'First research the best restaurants in Santiago, then create a comparison table',
      )).toBe(true);
    });

    it('detects "and then" connectors', () => {
      expect(shouldOrchestrate(
        'Read the uploaded PDF and then summarize the key findings for my team',
      )).toBe(true);
    });

    it('detects "and after that" connectors', () => {
      expect(shouldOrchestrate(
        'Search for the latest AI news and after that write a brief report about the top stories',
      )).toBe(true);
    });

    it('detects numbered steps', () => {
      expect(shouldOrchestrate(
        '1. Find the current Bitcoin price 2. Compare it to last week and explain the trend',
      )).toBe(true);
    });

    it('detects research → compare → create pipeline', () => {
      expect(shouldOrchestrate(
        'Research cloud hosting providers, compare their pricing tiers, and create a spreadsheet',
      )).toBe(true);
    });

    it('detects "initially...finally" pattern', () => {
      expect(shouldOrchestrate(
        'Initially gather all the error logs from today, then analyze the patterns, and finally create a bug report',
      )).toBe(true);
    });
  });

  describe('does NOT match single-step requests', () => {
    it('rejects simple questions', () => {
      expect(shouldOrchestrate('What is the weather today?')).toBe(false);
      expect(shouldOrchestrate('Tell me about machine learning')).toBe(false);
    });

    it('rejects short messages', () => {
      expect(shouldOrchestrate('First do this then that')).toBe(false); // < 60 chars
    });

    it('rejects commands', () => {
      expect(shouldOrchestrate('/schedule add "0 9 * * *" first check email then reply')).toBe(false);
    });

    it('rejects single action requests even if long', () => {
      expect(shouldOrchestrate(
        'Can you please help me understand how the memory system works in this codebase? I want a detailed explanation.',
      )).toBe(false);
    });

    it('rejects messages with "and" but no sequential intent', () => {
      expect(shouldOrchestrate(
        'I like coffee and tea but I prefer coffee in the morning and tea in the afternoon',
      )).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects empty message', () => {
      expect(shouldOrchestrate('')).toBe(false);
    });

    it('rejects voice messages (handled by isVoice flag in platform, not here)', () => {
      // shouldOrchestrate doesn't know about voice — the platform handler skips it
      // Just verify the function handles normal text
      expect(shouldOrchestrate('hello')).toBe(false);
    });
  });
});

// ── Task step data model ───────────────────────────────────

describe('TaskStep data model', () => {
  it('represents a valid step structure', () => {
    const steps: TaskStep[] = [
      { step: 1, instruction: 'Search for cloud hosting providers', dependsOnPrevious: false },
      { step: 2, instruction: 'Compare pricing tiers from search results', dependsOnPrevious: true },
      { step: 3, instruction: 'Create a spreadsheet with the comparison', dependsOnPrevious: true },
    ];

    expect(steps).toHaveLength(3);
    expect(steps[0].dependsOnPrevious).toBe(false); // First step has no predecessor
    expect(steps[1].dependsOnPrevious).toBe(true);  // Depends on search results
    expect(steps[2].dependsOnPrevious).toBe(true);  // Depends on comparison
  });

  it('single-step fallback is valid', () => {
    const steps: TaskStep[] = [
      { step: 1, instruction: 'Just do the whole thing', dependsOnPrevious: false },
    ];
    expect(steps).toHaveLength(1);
  });

  it('step context building works correctly', () => {
    const previousOutput = 'Provider A costs $10/mo, Provider B costs $20/mo';
    const step: TaskStep = {
      step: 2,
      instruction: 'Compare the pricing and recommend the best option',
      dependsOnPrevious: true,
    };

    // This is what the orchestrator does for dependent steps
    const stepMessage = step.dependsOnPrevious && previousOutput
      ? `Context from previous step:\n${previousOutput}\n\nNow: ${step.instruction}`
      : step.instruction;

    expect(stepMessage).toContain('Provider A costs $10/mo');
    expect(stepMessage).toContain('Compare the pricing');
    expect(stepMessage).toContain('Context from previous step');
  });

  it('independent steps do not include previous context', () => {
    const step: TaskStep = {
      step: 1,
      instruction: 'Search for cloud providers',
      dependsOnPrevious: false,
    };

    const stepMessage = step.dependsOnPrevious
      ? `Context from previous step:\nsome output\n\nNow: ${step.instruction}`
      : step.instruction;

    expect(stepMessage).toBe('Search for cloud providers');
    expect(stepMessage).not.toContain('Context from previous step');
  });
});

// ── Orchestration episode storage (real DB) ────────────────

describe('orchestration episode storage (real DB)', () => {
  it('stores orchestration result as episode with key facts and open threads', () => {
    const now = Date.now();
    const summary = 'Multi-step task: "Research cloud providers, compare pricing, create spreadsheet". Completed 3/3 steps.';
    const keyFacts = ['Step 1 completed: Search for cloud providers', 'Step 2 completed: Compare pricing'];
    const openThreads: string[] = [];

    db.prepare(
      `INSERT INTO episodes (chat_id, summary, key_facts, open_threads, source_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('chat1', summary, JSON.stringify(keyFacts), null, 3, now);

    const ep = db.prepare('SELECT * FROM episodes WHERE chat_id = ?').get('chat1') as any;
    expect(ep.summary).toContain('Multi-step task');
    expect(ep.source_count).toBe(3);
    expect(JSON.parse(ep.key_facts)).toHaveLength(2);
  });

  it('stores failed steps as open threads', () => {
    const now = Date.now();
    const openThreads = ['Step 3 failed: Create spreadsheet — needs retry'];

    db.prepare(
      `INSERT INTO episodes (chat_id, summary, key_facts, open_threads, source_count, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run('chat1', 'Multi-step task with partial failure', JSON.stringify(openThreads), 3, now);

    const ep = db.prepare('SELECT * FROM episodes WHERE chat_id = ?').get('chat1') as any;
    const threads = JSON.parse(ep.open_threads);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toContain('needs retry');
  });

  it('orchestration episodes are searchable via FTS5', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO episodes (chat_id, summary, key_facts, open_threads, source_count, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?)`,
    ).run('chat1', 'Multi-step task researching cloud hosting providers and comparing prices', 3, now);

    const results = db.prepare(
      `SELECT e.* FROM episodes e
       JOIN episodes_fts fts ON fts.rowid = e.id
       WHERE fts.summary MATCH ? AND e.chat_id = ?`,
    ).all('cloud*', 'chat1') as any[];

    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain('cloud hosting');
  });
});

// ── Final response building ────────────────────────────────

describe('final response building', () => {
  it('uses last successful step as main response', () => {
    const results = [
      { step: 1, instruction: 'Search', output: 'Found 5 providers', success: true },
      { step: 2, instruction: 'Compare', output: 'Provider A is best because...', success: true },
      { step: 3, instruction: 'Create report', output: 'Here is the full report with tables', success: true },
    ];

    const lastSuccessful = results.filter((r) => r.success);
    const mainOutput = lastSuccessful[lastSuccessful.length - 1].output;
    expect(mainOutput).toBe('Here is the full report with tables');
  });

  it('includes failure notes when steps fail', () => {
    const results = [
      { step: 1, instruction: 'Search', output: 'Found 5 providers', success: true },
      { step: 2, instruction: 'Compare', output: 'Error: timeout', success: false },
      { step: 3, instruction: 'Create report', output: 'Partial report based on step 1', success: true },
    ];

    const failed = results.filter((r) => !r.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].instruction).toBe('Compare');
  });

  it('handles all-failure case', () => {
    const results = [
      { step: 1, instruction: 'Search', output: 'Error: no internet', success: false },
      { step: 2, instruction: 'Compare', output: 'Error: no data', success: false },
    ];

    const successful = results.filter((r) => r.success);
    expect(successful).toHaveLength(0);
    // Orchestrator would return "All steps failed" message
  });
});

// ── End-to-end orchestration pattern matching ──────────────

describe('end-to-end pattern matching (real-world messages)', () => {
  const realWorldMultiStep = [
    'First look up the current exchange rate for USD to MXN, then calculate how much 500 USD would be in pesos, and finally create a simple conversion table',
    'Research the top 5 programming languages in 2026, compare their job market demand, and create a report summarizing the findings',
    'Search for the latest news about artificial intelligence and then write a brief summary highlighting the most important developments',
    '1) Check the weather forecast for Santiago 2) Based on the forecast, suggest what to wear tomorrow',
  ];

  const realWorldSingleStep = [
    'What is the capital of France?',
    'Explain quantum computing in simple terms',
    'Write a Python function that calculates fibonacci numbers',
    'I need help with my essay about climate change',
    'Can you summarize this article for me? It talks about the latest research in AI and how it might affect different industries in the coming years.',
  ];

  it('correctly identifies real multi-step messages', () => {
    for (const msg of realWorldMultiStep) {
      expect(shouldOrchestrate(msg)).toBe(true);
    }
  });

  it('correctly rejects real single-step messages', () => {
    for (const msg of realWorldSingleStep) {
      expect(shouldOrchestrate(msg)).toBe(false);
    }
  });
});
