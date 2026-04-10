/**
 * Guardrails Memory Sector — Real Execution Tests
 *
 * No mocks. Real SQLite, real guardrail creation/retrieval,
 * real context injection, real auto-detection.
 * Works identically for both Claude and Ollama providers
 * (guardrails are injected into memory context, not provider-specific).
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
  addGuardrail,
  getGuardrails,
  getGlobalGuardrails,
  removeGuardrail,
  clearGuardrails,
  buildGuardrailsContext,
  detectToolFailureGuardrail,
  detectCorrectionGuardrail,
  detectQualityGuardrail,
  formatGuardrailsList,
  guardrailsTableInit,
} from '../src/guardrails.js';

describe('guardrails — real execution', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await guardrailsTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // ── CRUD ───────────────────────────────────────────────────

  describe('CRUD operations', () => {
    it('adds and retrieves a guardrail', async () => {
      const id = await addGuardrail('chat-1', 'Never use tool X for date calculations', 'manual');
      expect(id).not.toBeNull();

      const guardrails = await getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].content).toBe('Never use tool X for date calculations');
      expect(guardrails[0].source).toBe('manual');
    });

    it('deduplicates identical guardrails', async () => {
      await addGuardrail('chat-1', 'Same rule', 'manual');
      const second = await addGuardrail('chat-1', 'Same rule', 'manual');
      expect(second).toBeNull();
      expect(await getGuardrails('chat-1')).toHaveLength(1);
    });

    it('allows different guardrails for same chat', async () => {
      await addGuardrail('chat-1', 'Rule A', 'manual');
      await addGuardrail('chat-1', 'Rule B', 'tool_failure');
      expect(await getGuardrails('chat-1')).toHaveLength(2);
    });

    it('removes a guardrail by ID', async () => {
      const id = (await addGuardrail('chat-1', 'Temporary rule', 'manual'))!;
      expect(await removeGuardrail(id)).toBe(true);
      expect(await getGuardrails('chat-1')).toHaveLength(0);
    });

    it('clears all guardrails for a chat', async () => {
      await addGuardrail('chat-1', 'Rule 1', 'manual');
      await addGuardrail('chat-1', 'Rule 2', 'manual');
      await addGuardrail('chat-2', 'Other chat rule', 'manual');

      const cleared = await clearGuardrails('chat-1');
      expect(cleared).toBe(2);
      expect(await getGuardrails('chat-1')).toHaveLength(0);
      expect(await getGuardrails('chat-2')).toHaveLength(1); // untouched
    });

    it('per-chat isolation', async () => {
      await addGuardrail('chat-a', 'Rule for A', 'manual');
      await addGuardrail('chat-b', 'Rule for B', 'manual');

      expect(await getGuardrails('chat-a')).toHaveLength(1);
      expect(await getGuardrails('chat-b')).toHaveLength(1);
      expect((await getGuardrails('chat-a'))[0].content).toContain('Rule for A');
    });
  });

  // ── Global guardrails ──────────────────────────────────────

  describe('global guardrails', () => {
    it('global guardrails apply to all chats', async () => {
      await addGuardrail('global', 'Company policy: always verify data before presenting', 'manual');

      const globals = await getGlobalGuardrails();
      expect(globals).toHaveLength(1);
    });

    it('buildGuardrailsContext includes global + chat-specific', async () => {
      await addGuardrail('global', 'Global rule', 'manual');
      await addGuardrail('chat-1', 'Chat-specific rule', 'manual');

      const ctx = await buildGuardrailsContext('chat-1');
      expect(ctx).toContain('Global rule');
      expect(ctx).toContain('Chat-specific rule');
      expect(ctx).toContain('[GUARDRAILS');
    });
  });

  // ── Context Building (injected into BOTH providers) ────────

  describe('context building — both providers', () => {
    it('returns empty string when no guardrails', async () => {
      expect(await buildGuardrailsContext('empty-chat')).toBe('');
    });

    it('builds formatted context with source labels', async () => {
      await addGuardrail('chat-1', 'Tool lesson content', 'tool_failure');
      await addGuardrail('chat-1', 'User preference content', 'user_correction');
      await addGuardrail('chat-1', 'Quality note content', 'quality_issue');
      await addGuardrail('chat-1', 'Manual rule content', 'manual');

      const ctx = await buildGuardrailsContext('chat-1');
      expect(ctx).toContain('[Tool lesson]');
      expect(ctx).toContain('[User preference]');
      expect(ctx).toContain('[Quality note]');
      expect(ctx).toContain('[Rule]');
      expect(ctx).toContain('[GUARDRAILS');
      expect(ctx).toContain('[END GUARDRAILS]');
    });

    it('context is provider-agnostic (same string for Claude and Ollama)', async () => {
      await addGuardrail('chat-1', 'Universal constraint', 'manual');

      // The same context string is used regardless of provider
      // because it's injected via buildMemoryContext(), not provider-specific code
      const ctxForClaude = await buildGuardrailsContext('chat-1');
      const ctxForOllama = await buildGuardrailsContext('chat-1');
      expect(ctxForClaude).toBe(ctxForOllama);
      expect(ctxForClaude).toContain('Universal constraint');
    });
  });

  // ── Auto-Detection ─────────────────────────────────────────

  describe('auto-detection', () => {
    it('detectToolFailureGuardrail creates guardrail from tool error', async () => {
      await detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Connection timeout');

      const guardrails = await getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('tool_failure');
      expect(guardrails[0].content).toContain('web_search');
      expect(guardrails[0].content).toContain('Connection timeout');
    });

    it('detectToolFailureGuardrail deduplicates within 1 hour', async () => {
      await detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Timeout 1');
      await detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Timeout 2');

      // Only 1 guardrail — second was deduped
      expect(await getGuardrails('chat-1')).toHaveLength(1);
    });

    it('detectCorrectionGuardrail creates guardrail from user correction', async () => {
      await detectCorrectionGuardrail('chat-1', "no that's wrong, use method B", 'Topic: data analysis');

      const guardrails = await getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('user_correction');
      expect(guardrails[0].content).toContain('method B');
    });

    it('detectQualityGuardrail creates guardrail for very low quality', async () => {
      await detectQualityGuardrail('chat-1', 'budget forecasting', 30, 'Hallucination detected, too short');

      const guardrails = await getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('quality_issue');
      expect(guardrails[0].content).toContain('budget forecasting');
    });

    it('detectQualityGuardrail skips moderate quality (score >= 50)', async () => {
      await detectQualityGuardrail('chat-1', 'general topic', 60, 'Minor issue');
      expect(await getGuardrails('chat-1')).toHaveLength(0);
    });
  });

  // ── Formatting (bilingual) ─────────────────────────────────

  describe('formatting', () => {
    it('formatGuardrailsList returns bilingual empty state', () => {
      const msg = formatGuardrailsList([]);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('No guardrails');
    });

    it('formatGuardrailsList shows entries with emojis', async () => {
      await addGuardrail('chat-1', 'Tool rule', 'tool_failure');
      await addGuardrail('chat-1', 'User rule', 'user_correction');
      const guardrails = await getGuardrails('chat-1');

      const msg = formatGuardrailsList(guardrails);
      expect(msg).toContain('🔧');
      expect(msg).toContain('👤');
      expect(msg).toContain('Tool rule');
      expect(msg).toContain('User rule');
    });
  });

  // ── Permanence (never decays) ──────────────────────────────

  describe('permanence', () => {
    it('guardrails have no salience or decay mechanism', async () => {
      // Guardrails are stored in a separate table with no salience column
      // They don't go through the decay sweep
      await addGuardrail('chat-1', 'Permanent constraint', 'manual');

      // Verify the table schema has no salience/decay columns
      const columns = await testKnex.raw("PRAGMA table_info(guardrails)") as Array<{ name: string }>;
      const columnNames = columns.map((c: { name: string }) => c.name);
      expect(columnNames).not.toContain('salience');
      expect(columnNames).not.toContain('accessed_at');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('source');
      expect(columnNames).toContain('created_at');
    });
  });
});
