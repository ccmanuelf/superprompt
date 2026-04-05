/**
 * Self-Tuning Pack Weights — Real Execution Tests
 *
 * No mocks. Real SQLite, real weight adjustment, real per-user isolation.
 * Provider-agnostic: tuning is based on tool outcomes, not AI provider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
vi.mock('../src/db.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return { ...original, getDatabase: () => db };
});

import {
  recordPackToolOutcome,
  getPackWeight,
  getAllPackWeights,
  applyTunedWeight,
  resetPackWeights,
  formatPackWeights,
  getToolPackName,
  initPackTunerTables,
} from '../src/pack-tuner.js';

function setupDb(): void {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Create user_tools table for getToolPackName
  db.exec(`CREATE TABLE IF NOT EXISTS user_tools (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    tool_type TEXT, config TEXT, enabled INTEGER DEFAULT 1, locked INTEGER DEFAULT 0,
    source_file TEXT, created_at INTEGER, updated_at INTEGER
  )`);
  initPackTunerTables();
}

describe('pack-tuner — real execution', () => {
  beforeEach(() => setupDb());
  afterEach(() => db.close());

  // ── Weight adjustment ──────────────────────────────────────

  describe('weight adjustment', () => {
    it('starts at default weight 1.0', () => {
      expect(getPackWeight('manufacturing', 'chat-1')).toBe(1.0);
    });

    it('weight stays at 1.0 below minimum calls threshold', () => {
      for (let i = 0; i < 4; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      expect(getPackWeight('manufacturing', 'chat-1')).toBe(1.0); // 4 < 5 minimum
    });

    it('weight increases after successful calls above threshold', () => {
      for (let i = 0; i < 6; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      const weight = getPackWeight('manufacturing', 'chat-1');
      expect(weight).toBeGreaterThan(1.0);
    });

    it('weight decreases after failed calls above threshold', () => {
      // 5 successes to reach threshold, then failures
      for (let i = 0; i < 5; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      for (let i = 0; i < 5; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', false);
      }
      const weight = getPackWeight('manufacturing', 'chat-1');
      expect(weight).toBeLessThan(1.0);
    });

    it('weight never goes below 0.5', () => {
      for (let i = 0; i < 5; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      // Many failures
      for (let i = 0; i < 50; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', false);
      }
      expect(getPackWeight('manufacturing', 'chat-1')).toBeGreaterThanOrEqual(0.5);
    });

    it('weight never goes above 2.0', () => {
      for (let i = 0; i < 100; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      expect(getPackWeight('manufacturing', 'chat-1')).toBeLessThanOrEqual(2.0);
    });
  });

  // ── Per-user isolation ─────────────────────────────────────

  describe('per-user isolation', () => {
    it('different chats have independent weights', () => {
      // Chat A: all successes
      for (let i = 0; i < 10; i++) {
        recordPackToolOutcome('manufacturing', 'chat-a', true);
      }
      // Chat B: all failures
      for (let i = 0; i < 10; i++) {
        recordPackToolOutcome('manufacturing', 'chat-b', false);
      }

      expect(getPackWeight('manufacturing', 'chat-a')).toBeGreaterThan(1.0);
      expect(getPackWeight('manufacturing', 'chat-b')).toBeLessThan(1.0);
    });

    it('different packs have independent weights', () => {
      for (let i = 0; i < 10; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
        recordPackToolOutcome('finance', 'chat-1', false);
      }

      expect(getPackWeight('manufacturing', 'chat-1')).toBeGreaterThan(1.0);
      expect(getPackWeight('finance', 'chat-1')).toBeLessThan(1.0);
    });
  });

  // ── applyTunedWeight ───────────────────────────────────────

  describe('applyTunedWeight', () => {
    it('returns base score when no data', () => {
      expect(applyTunedWeight(10, 'unknown-pack', 'chat-1')).toBe(10);
    });

    it('boosts score for successful packs', () => {
      for (let i = 0; i < 10; i++) {
        recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      const boosted = applyTunedWeight(10, 'manufacturing', 'chat-1');
      expect(boosted).toBeGreaterThan(10);
    });

    it('dampens score for failing packs', () => {
      for (let i = 0; i < 5; i++) recordPackToolOutcome('failing-pack', 'chat-1', true);
      for (let i = 0; i < 10; i++) recordPackToolOutcome('failing-pack', 'chat-1', false);

      const dampened = applyTunedWeight(10, 'failing-pack', 'chat-1');
      expect(dampened).toBeLessThan(10);
    });
  });

  // ── Tool → Pack mapping ────────────────────────────────────

  describe('getToolPackName', () => {
    it('maps manufacturing tools correctly', () => {
      expect(getToolPackName('line_balance')).toBe('manufacturing');
      expect(getToolPackName('sigma_analysis')).toBe('manufacturing');
      expect(getToolPackName('capacity_planning')).toBe('manufacturing');
      expect(getToolPackName('production_simulation')).toBe('manufacturing');
    });

    it('returns null for core tools', () => {
      expect(getToolPackName('web_search')).toBeNull();
      expect(getToolPackName('get_time')).toBeNull();
      expect(getToolPackName('query_memory')).toBeNull();
    });

    it('maps user tools from packs via source_file', () => {
      db.prepare(
        'INSERT INTO user_tools (id, name, description, tool_type, config, source_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('pack-finance-npv', 'calculate_npv', 'NPV calc', 'generated_code', '{}', 'packs/finance/tools/npv.md', Date.now(), Date.now());

      expect(getToolPackName('calculate_npv')).toBe('finance');
    });
  });

  // ── Reset ──────────────────────────────────────────────────

  describe('reset', () => {
    it('resets specific pack weights', () => {
      for (let i = 0; i < 10; i++) recordPackToolOutcome('mfg', 'chat-1', true);
      for (let i = 0; i < 10; i++) recordPackToolOutcome('fin', 'chat-1', true);

      resetPackWeights('chat-1', 'mfg');
      expect(getPackWeight('mfg', 'chat-1')).toBe(1.0); // reset
      expect(getPackWeight('fin', 'chat-1')).toBeGreaterThan(1.0); // untouched
    });

    it('resets all weights for a chat', () => {
      for (let i = 0; i < 10; i++) recordPackToolOutcome('mfg', 'chat-1', true);
      for (let i = 0; i < 10; i++) recordPackToolOutcome('fin', 'chat-1', true);

      const cleared = resetPackWeights('chat-1');
      expect(cleared).toBe(2);
      expect(getAllPackWeights('chat-1')).toHaveLength(0);
    });
  });

  // ── Formatting (bilingual) ─────────────────────────────────

  describe('formatting', () => {
    it('formatPackWeights returns bilingual empty state', () => {
      const msg = formatPackWeights([]);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('No pack usage');
    });

    it('formatPackWeights shows entries with trend emojis', () => {
      for (let i = 0; i < 10; i++) recordPackToolOutcome('manufacturing', 'chat-1', true);
      for (let i = 0; i < 5; i++) recordPackToolOutcome('finance', 'chat-1', true);
      for (let i = 0; i < 10; i++) recordPackToolOutcome('finance', 'chat-1', false);

      const weights = getAllPackWeights('chat-1');
      const msg = formatPackWeights(weights);
      expect(msg).toContain('📈'); // manufacturing boosted
      expect(msg).toContain('📉'); // finance dampened
      expect(msg).toContain('manufacturing');
      expect(msg).toContain('finance');
    });
  });

  // ── Provider-agnostic ──────────────────────────────────────

  describe('provider-agnostic', () => {
    it('same weight tracking regardless of AI provider', () => {
      // Weights track tool outcomes, not which provider was used
      // Both Claude and Ollama tool calls go through the same recordPackToolOutcome
      recordPackToolOutcome('manufacturing', 'claude-chat', true);
      recordPackToolOutcome('manufacturing', 'ollama-chat', true);

      for (let i = 0; i < 5; i++) {
        recordPackToolOutcome('manufacturing', 'claude-chat', true);
        recordPackToolOutcome('manufacturing', 'ollama-chat', false);
      }

      // Different outcomes for different chats — provider doesn't matter
      expect(getPackWeight('manufacturing', 'claude-chat')).toBeGreaterThan(1.0);
      expect(getPackWeight('manufacturing', 'ollama-chat')).toBeLessThan(1.0);
    });
  });
});
