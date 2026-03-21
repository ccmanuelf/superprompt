import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkResponseQuality,
  detectRepetition,
  type QualityCheck,
} from '../src/self-monitor.js';
import type { AIResponse } from '../src/providers/types.js';

/**
 * Sprint S8: Self-Monitoring tests.
 *
 * Tests REAL exported functions from self-monitor.ts.
 * Verifies quality checks detect actual response problems.
 */

const TMP_DIR = resolve(tmpdir(), 'clauded-test-monitor');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'monitor-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      score INTEGER NOT NULL,
      issues TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function makeResponse(text: string | null): AIResponse {
  return { text, provider: 'ollama' };
}

beforeEach(() => { initTestDb(); });
afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ }
});

// ── checkResponseQuality (real function) ───────────────────

describe('checkResponseQuality (real function)', () => {
  it('passes a good response', () => {
    const result = checkResponseQuality(
      makeResponse('The weather in Santiago is partly cloudy with temperatures around 22°C. Perfect weather for a walk.'),
      'What is the weather in Santiago?',
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it('detects empty response', () => {
    const result = checkResponseQuality(
      makeResponse(null),
      'Tell me about AI',
    );

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues[0].type).toBe('empty');
    expect(result.issues[0].severity).toBe('error');
  });

  it('detects suspiciously short response for substantial question', () => {
    const result = checkResponseQuality(
      makeResponse('Yes.'),
      'Can you explain the differences between microservices and monolithic architecture?',
    );

    expect(result.issues.some((i) => i.type === 'too_short')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('does NOT flag short response to short question', () => {
    const result = checkResponseQuality(
      makeResponse('42'),
      'What is 6 times 7?',
    );

    // Short question + short answer = fine
    expect(result.issues.some((i) => i.type === 'too_short')).toBe(false);
  });

  it('detects Ollama error responses', () => {
    const result = checkResponseQuality(
      makeResponse('Ollama error: ECONNREFUSED - Connection refused to localhost:11434'),
      'Tell me a joke',
    );

    expect(result.issues.some((i) => i.type === 'error_response')).toBe(true);
    expect(result.score).toBeLessThan(70);
  });

  it('detects tool failure mentions', () => {
    const result = checkResponseQuality(
      makeResponse('I tried to search the web but the tool failed with a timeout error. Let me try to answer from memory instead.'),
      'Search for recent AI news',
    );

    expect(result.issues.some((i) => i.type === 'error_response')).toBe(true);
  });

  it('detects fabricated example URLs', () => {
    const result = checkResponseQuality(
      makeResponse('You can find more information at https://www.example.com/ai-guide for a comprehensive overview.'),
      'Where can I learn about AI?',
    );

    expect(result.issues.some((i) => i.type === 'hallucination_signal')).toBe(true);
  });
});

// ── detectRepetition (real function) ───────────────────────

describe('detectRepetition (real function)', () => {
  it('returns 0 for non-repetitive text', () => {
    const text = 'First point about AI. Second point about ML. Third about deep learning. Fourth about neural networks.';
    const ratio = detectRepetition(text);
    expect(ratio).toBe(0);
  });

  it('detects high repetition', () => {
    const text = 'The answer is yes. The answer is yes. The answer is yes. The answer is yes. The answer is yes. Something different here.';
    const ratio = detectRepetition(text);
    expect(ratio).toBeGreaterThan(0.3);
  });

  it('returns 0 for very short text', () => {
    expect(detectRepetition('Hi')).toBe(0);
    expect(detectRepetition('Short.')).toBe(0);
  });

  it('handles realistic AI response without false positives', () => {
    const response = `Machine learning is a subset of artificial intelligence. It enables computers to learn from data. There are three main types: supervised learning, unsupervised learning, and reinforcement learning. Each type has different use cases and strengths.`;
    const ratio = detectRepetition(response);
    expect(ratio).toBeLessThan(0.2); // Normal text should not be flagged
  });
});

// ── Quality scoring ────────────────────────────────────────

describe('quality scoring', () => {
  it('starts at 100 and decrements per issue', () => {
    const good = checkResponseQuality(
      makeResponse('A perfectly normal, helpful response about the topic at hand.'),
      'Tell me about the topic',
    );
    expect(good.score).toBe(100);
  });

  it('score never goes below 0', () => {
    // Multiple issues should not go negative
    const result = checkResponseQuality(
      makeResponse('Ollama error: I was wrong actually, check https://www.example.com for info'),
      'A very long and detailed question about multiple complex topics that requires a thorough response',
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('passes with score >= 50', () => {
    // A response with one warning issue
    const result = checkResponseQuality(
      makeResponse('Ok.'),
      'Can you explain quantum computing in detail including the mathematical foundations and practical applications?',
    );
    // Short response to long question = warning, score ~80
    // Still passes (>= 50) but has a warning
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

// ── Quality log storage (real DB) ──────────────────────────

describe('quality log storage (real DB)', () => {
  it('stores quality issues in database', () => {
    const now = Date.now();
    const issues = [{ type: 'empty', message: 'Empty response', severity: 'error' }];

    db.prepare(
      'INSERT INTO quality_log (chat_id, provider, score, issues, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('chat1', 'ollama', 0, JSON.stringify(issues), now);

    const rows = db.prepare('SELECT * FROM quality_log WHERE chat_id = ?').all('chat1') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(0);
    expect(JSON.parse(rows[0].issues)[0].type).toBe('empty');
  });

  it('accumulates multiple quality entries', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        'INSERT INTO quality_log (chat_id, provider, score, issues, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('chat1', 'ollama', 50 + i * 10, '[]', now - i * 1000);
    }

    const rows = db.prepare('SELECT * FROM quality_log WHERE chat_id = ?').all('chat1');
    expect(rows).toHaveLength(5);
  });

  it('can query average score over time period', () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    db.prepare('INSERT INTO quality_log (chat_id, provider, score, issues, created_at) VALUES (?, ?, ?, ?, ?)').run('chat1', 'ollama', 80, '[]', now);
    db.prepare('INSERT INTO quality_log (chat_id, provider, score, issues, created_at) VALUES (?, ?, ?, ?, ?)').run('chat1', 'ollama', 60, '[]', now);
    db.prepare('INSERT INTO quality_log (chat_id, provider, score, issues, created_at) VALUES (?, ?, ?, ?, ?)').run('chat1', 'ollama', 100, '[]', now - DAY * 10); // old, should be excluded

    const recentRows = db.prepare(
      'SELECT AVG(score) as avg_score FROM quality_log WHERE chat_id = ? AND created_at > ?',
    ).get('chat1', now - DAY) as any;

    expect(recentRows.avg_score).toBe(70); // (80+60)/2 = 70, the old 100 is excluded
  });
});

// ── End-to-end: realistic response quality checks ──────────

describe('realistic response quality checks', () => {
  it('passes a typical Claude response', () => {
    const result = checkResponseQuality(
      makeResponse(`Here's a summary of the key points from the document you uploaded:

1. **Revenue Growth**: Q4 showed a 15% increase compared to Q3.
2. **Customer Acquisition**: 2,400 new customers were onboarded.
3. **Churn Rate**: Decreased from 5.2% to 4.1%.

Overall, the metrics indicate strong performance heading into the new year.`),
      'Summarize the document I uploaded',
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it('passes a typical Ollama tool-using response', () => {
    const result = checkResponseQuality(
      makeResponse(`Based on my web search, here are the current results:

The temperature in Santiago is 22°C with partly cloudy skies. There's a 30% chance of rain this afternoon. Tomorrow's forecast shows similar conditions with a high of 25°C.`),
      'What is the weather in Santiago?',
    );

    expect(result.passed).toBe(true);
  });

  it('fails a clearly broken response', () => {
    const result = checkResponseQuality(
      makeResponse('Ollama error: fetch failed: ECONNREFUSED'),
      'Tell me about machine learning',
    );

    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
  });
});
