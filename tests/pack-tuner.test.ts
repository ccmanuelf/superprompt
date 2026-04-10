/**
 * Self-Tuning Pack Weights — Real Execution Tests
 *
 * No mocks. Real SQLite, real weight adjustment, real per-user isolation.
 * Provider-agnostic: tuning is based on tool outcomes, not AI provider.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}));

import {
  recordPackToolOutcome,
  getPackWeight,
  getAllPackWeights,
  applyTunedWeight,
  resetPackWeights,
  formatPackWeights,
  getToolPackName,
  packTunerTableInit,
} from '../src/pack-tuner.js';

describe('pack-tuner — real execution', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    // Create user_tools table for getToolPackName
    await testKnex.schema.createTable('user_tools', (t) => {
      t.text('id').primary();
      t.text('name').notNullable().unique();
      t.text('description');
      t.text('tool_type');
      t.text('config');
      t.integer('enabled').defaultTo(1);
      t.integer('locked').defaultTo(0);
      t.text('source_file');
      t.integer('created_at');
      t.integer('updated_at');
    });
    await packTunerTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // ── Weight adjustment ──────────────────────────────────────

  describe('weight adjustment', () => {
    it('starts at default weight 1.0', async () => {
      expect(await getPackWeight('manufacturing', 'chat-1')).toBe(1.0);
    });

    it('weight stays at 1.0 below minimum calls threshold', async () => {
      for (let i = 0; i < 4; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      expect(await getPackWeight('manufacturing', 'chat-1')).toBe(1.0); // 4 < 5 minimum
    });

    it('weight increases after successful calls above threshold', async () => {
      for (let i = 0; i < 6; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      const weight = await getPackWeight('manufacturing', 'chat-1');
      expect(weight).toBeGreaterThan(1.0);
    });

    it('weight decreases after failed calls above threshold', async () => {
      // 5 successes to reach threshold, then failures
      for (let i = 0; i < 5; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      for (let i = 0; i < 5; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', false);
      }
      const weight = await getPackWeight('manufacturing', 'chat-1');
      expect(weight).toBeLessThan(1.0);
    });

    it('weight never goes below 0.5', async () => {
      for (let i = 0; i < 5; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      // Many failures
      for (let i = 0; i < 50; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', false);
      }
      expect(await getPackWeight('manufacturing', 'chat-1')).toBeGreaterThanOrEqual(0.5);
    });

    it('weight never goes above 2.0', async () => {
      for (let i = 0; i < 100; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      expect(await getPackWeight('manufacturing', 'chat-1')).toBeLessThanOrEqual(2.0);
    });
  });

  // ── Per-user isolation ─────────────────────────────────────

  describe('per-user isolation', () => {
    it('different chats have independent weights', async () => {
      // Chat A: all successes
      for (let i = 0; i < 10; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-a', true);
      }
      // Chat B: all failures
      for (let i = 0; i < 10; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-b', false);
      }

      expect(await getPackWeight('manufacturing', 'chat-a')).toBeGreaterThan(1.0);
      expect(await getPackWeight('manufacturing', 'chat-b')).toBeLessThan(1.0);
    });

    it('different packs have independent weights', async () => {
      for (let i = 0; i < 10; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
        await recordPackToolOutcome('finance', 'chat-1', false);
      }

      expect(await getPackWeight('manufacturing', 'chat-1')).toBeGreaterThan(1.0);
      expect(await getPackWeight('finance', 'chat-1')).toBeLessThan(1.0);
    });
  });

  // ── applyTunedWeight ───────────────────────────────────────

  describe('applyTunedWeight', () => {
    it('returns base score when no data', async () => {
      expect(await applyTunedWeight(10, 'unknown-pack', 'chat-1')).toBe(10);
    });

    it('boosts score for successful packs', async () => {
      for (let i = 0; i < 10; i++) {
        await recordPackToolOutcome('manufacturing', 'chat-1', true);
      }
      const boosted = await applyTunedWeight(10, 'manufacturing', 'chat-1');
      expect(boosted).toBeGreaterThan(10);
    });

    it('dampens score for failing packs', async () => {
      for (let i = 0; i < 5; i++) await recordPackToolOutcome('failing-pack', 'chat-1', true);
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('failing-pack', 'chat-1', false);

      const dampened = await applyTunedWeight(10, 'failing-pack', 'chat-1');
      expect(dampened).toBeLessThan(10);
    });
  });

  // ── Tool → Pack mapping ────────────────────────────────────

  describe('getToolPackName', () => {
    it('maps tools via explicit packName parameter', async () => {
      // rc.30: packName is now passed explicitly from ToolEntry, not hardcoded
      expect(await getToolPackName('line_balance', 'manufacturing')).toBe('manufacturing');
      expect(await getToolPackName('sigma_analysis', 'manufacturing')).toBe('manufacturing');
      expect(await getToolPackName('any_tool', 'finance')).toBe('finance');
      expect(await getToolPackName('custom_tool', 'hr')).toBe('hr');
    });

    it('returns null for core tools without packName', async () => {
      expect(await getToolPackName('web_search')).toBeNull();
      expect(await getToolPackName('get_time')).toBeNull();
      expect(await getToolPackName('query_memory')).toBeNull();
    });

    it('maps user tools from packs via source_file', async () => {
      await testKnex('user_tools').insert({
        id: 'pack-finance-npv',
        name: 'calculate_npv',
        description: 'NPV calc',
        tool_type: 'generated_code',
        config: '{}',
        source_file: 'packs/finance/tools/npv.md',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      expect(await getToolPackName('calculate_npv')).toBe('finance');
    });
  });

  // ── Reset ──────────────────────────────────────────────────

  describe('reset', () => {
    it('resets specific pack weights', async () => {
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('mfg', 'chat-1', true);
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('fin', 'chat-1', true);

      await resetPackWeights('chat-1', 'mfg');
      expect(await getPackWeight('mfg', 'chat-1')).toBe(1.0); // reset
      expect(await getPackWeight('fin', 'chat-1')).toBeGreaterThan(1.0); // untouched
    });

    it('resets all weights for a chat', async () => {
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('mfg', 'chat-1', true);
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('fin', 'chat-1', true);

      const cleared = await resetPackWeights('chat-1');
      expect(cleared).toBe(2);
      expect(await getAllPackWeights('chat-1')).toHaveLength(0);
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

    it('formatPackWeights shows entries with trend emojis', async () => {
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('manufacturing', 'chat-1', true);
      for (let i = 0; i < 5; i++) await recordPackToolOutcome('finance', 'chat-1', true);
      for (let i = 0; i < 10; i++) await recordPackToolOutcome('finance', 'chat-1', false);

      const weights = await getAllPackWeights('chat-1');
      const msg = formatPackWeights(weights);
      expect(msg).toContain('📈'); // manufacturing boosted
      expect(msg).toContain('📉'); // finance dampened
      expect(msg).toContain('manufacturing');
      expect(msg).toContain('finance');
    });
  });

  // ── Provider-agnostic ──────────────────────────────────────

  describe('provider-agnostic', () => {
    it('same weight tracking regardless of AI provider', async () => {
      // Weights track tool outcomes, not which provider was used
      // Both Claude and Ollama tool calls go through the same recordPackToolOutcome
      await recordPackToolOutcome('manufacturing', 'claude-chat', true);
      await recordPackToolOutcome('manufacturing', 'ollama-chat', true);

      for (let i = 0; i < 5; i++) {
        await recordPackToolOutcome('manufacturing', 'claude-chat', true);
        await recordPackToolOutcome('manufacturing', 'ollama-chat', false);
      }

      // Different outcomes for different chats — provider doesn't matter
      expect(await getPackWeight('manufacturing', 'claude-chat')).toBeGreaterThan(1.0);
      expect(await getPackWeight('manufacturing', 'ollama-chat')).toBeLessThan(1.0);
    });
  });
});
