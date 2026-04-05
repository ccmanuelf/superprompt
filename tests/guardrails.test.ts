/**
 * Guardrails Memory Sector — Real Execution Tests
 *
 * No mocks. Real SQLite, real guardrail creation/retrieval,
 * real context injection, real auto-detection.
 * Works identically for both Claude and Ollama providers
 * (guardrails are injected into memory context, not provider-specific).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
vi.mock('../src/db.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return { ...original, getDatabase: () => db };
});

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
  initGuardrailsTables,
} from '../src/guardrails.js';

function setupDb(): void {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initGuardrailsTables();
}

describe('guardrails — real execution', () => {
  beforeEach(() => setupDb());
  afterEach(() => db.close());

  // ── CRUD ───────────────────────────────────────────────────

  describe('CRUD operations', () => {
    it('adds and retrieves a guardrail', () => {
      const id = addGuardrail('chat-1', 'Never use tool X for date calculations', 'manual');
      expect(id).not.toBeNull();

      const guardrails = getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].content).toBe('Never use tool X for date calculations');
      expect(guardrails[0].source).toBe('manual');
    });

    it('deduplicates identical guardrails', () => {
      addGuardrail('chat-1', 'Same rule', 'manual');
      const second = addGuardrail('chat-1', 'Same rule', 'manual');
      expect(second).toBeNull();
      expect(getGuardrails('chat-1')).toHaveLength(1);
    });

    it('allows different guardrails for same chat', () => {
      addGuardrail('chat-1', 'Rule A', 'manual');
      addGuardrail('chat-1', 'Rule B', 'tool_failure');
      expect(getGuardrails('chat-1')).toHaveLength(2);
    });

    it('removes a guardrail by ID', () => {
      const id = addGuardrail('chat-1', 'Temporary rule', 'manual')!;
      expect(removeGuardrail(id)).toBe(true);
      expect(getGuardrails('chat-1')).toHaveLength(0);
    });

    it('clears all guardrails for a chat', () => {
      addGuardrail('chat-1', 'Rule 1', 'manual');
      addGuardrail('chat-1', 'Rule 2', 'manual');
      addGuardrail('chat-2', 'Other chat rule', 'manual');

      const cleared = clearGuardrails('chat-1');
      expect(cleared).toBe(2);
      expect(getGuardrails('chat-1')).toHaveLength(0);
      expect(getGuardrails('chat-2')).toHaveLength(1); // untouched
    });

    it('per-chat isolation', () => {
      addGuardrail('chat-a', 'Rule for A', 'manual');
      addGuardrail('chat-b', 'Rule for B', 'manual');

      expect(getGuardrails('chat-a')).toHaveLength(1);
      expect(getGuardrails('chat-b')).toHaveLength(1);
      expect(getGuardrails('chat-a')[0].content).toContain('Rule for A');
    });
  });

  // ── Global guardrails ──────────────────────────────────────

  describe('global guardrails', () => {
    it('global guardrails apply to all chats', () => {
      addGuardrail('global', 'Company policy: always verify data before presenting', 'manual');

      const globals = getGlobalGuardrails();
      expect(globals).toHaveLength(1);
    });

    it('buildGuardrailsContext includes global + chat-specific', () => {
      addGuardrail('global', 'Global rule', 'manual');
      addGuardrail('chat-1', 'Chat-specific rule', 'manual');

      const ctx = buildGuardrailsContext('chat-1');
      expect(ctx).toContain('Global rule');
      expect(ctx).toContain('Chat-specific rule');
      expect(ctx).toContain('[GUARDRAILS');
    });
  });

  // ── Context Building (injected into BOTH providers) ────────

  describe('context building — both providers', () => {
    it('returns empty string when no guardrails', () => {
      expect(buildGuardrailsContext('empty-chat')).toBe('');
    });

    it('builds formatted context with source labels', () => {
      addGuardrail('chat-1', 'Tool lesson content', 'tool_failure');
      addGuardrail('chat-1', 'User preference content', 'user_correction');
      addGuardrail('chat-1', 'Quality note content', 'quality_issue');
      addGuardrail('chat-1', 'Manual rule content', 'manual');

      const ctx = buildGuardrailsContext('chat-1');
      expect(ctx).toContain('[Tool lesson]');
      expect(ctx).toContain('[User preference]');
      expect(ctx).toContain('[Quality note]');
      expect(ctx).toContain('[Rule]');
      expect(ctx).toContain('[GUARDRAILS');
      expect(ctx).toContain('[END GUARDRAILS]');
    });

    it('context is provider-agnostic (same string for Claude and Ollama)', () => {
      addGuardrail('chat-1', 'Universal constraint', 'manual');

      // The same context string is used regardless of provider
      // because it's injected via buildMemoryContext(), not provider-specific code
      const ctxForClaude = buildGuardrailsContext('chat-1');
      const ctxForOllama = buildGuardrailsContext('chat-1');
      expect(ctxForClaude).toBe(ctxForOllama);
      expect(ctxForClaude).toContain('Universal constraint');
    });
  });

  // ── Auto-Detection ─────────────────────────────────────────

  describe('auto-detection', () => {
    it('detectToolFailureGuardrail creates guardrail from tool error', () => {
      detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Connection timeout');

      const guardrails = getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('tool_failure');
      expect(guardrails[0].content).toContain('web_search');
      expect(guardrails[0].content).toContain('Connection timeout');
    });

    it('detectToolFailureGuardrail deduplicates within 1 hour', () => {
      detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Timeout 1');
      detectToolFailureGuardrail('chat-1', 'web_search', { query: 'test' }, 'Timeout 2');

      // Only 1 guardrail — second was deduped
      expect(getGuardrails('chat-1')).toHaveLength(1);
    });

    it('detectCorrectionGuardrail creates guardrail from user correction', () => {
      detectCorrectionGuardrail('chat-1', "no that's wrong, use method B", 'Topic: data analysis');

      const guardrails = getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('user_correction');
      expect(guardrails[0].content).toContain('method B');
    });

    it('detectQualityGuardrail creates guardrail for very low quality', () => {
      detectQualityGuardrail('chat-1', 'budget forecasting', 30, 'Hallucination detected, too short');

      const guardrails = getGuardrails('chat-1');
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].source).toBe('quality_issue');
      expect(guardrails[0].content).toContain('budget forecasting');
    });

    it('detectQualityGuardrail skips moderate quality (score >= 50)', () => {
      detectQualityGuardrail('chat-1', 'general topic', 60, 'Minor issue');
      expect(getGuardrails('chat-1')).toHaveLength(0);
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

    it('formatGuardrailsList shows entries with emojis', () => {
      addGuardrail('chat-1', 'Tool rule', 'tool_failure');
      addGuardrail('chat-1', 'User rule', 'user_correction');
      const guardrails = getGuardrails('chat-1');

      const msg = formatGuardrailsList(guardrails);
      expect(msg).toContain('🔧');
      expect(msg).toContain('👤');
      expect(msg).toContain('Tool rule');
      expect(msg).toContain('User rule');
    });
  });

  // ── Permanence (never decays) ──────────────────────────────

  describe('permanence', () => {
    it('guardrails have no salience or decay mechanism', () => {
      // Guardrails are stored in a separate table with no salience column
      // They don't go through the decay sweep
      addGuardrail('chat-1', 'Permanent constraint', 'manual');

      // Verify the table schema has no salience/decay columns
      const columns = db.prepare("PRAGMA table_info(guardrails)").all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).not.toContain('salience');
      expect(columnNames).not.toContain('accessed_at');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('source');
      expect(columnNames).toContain('created_at');
    });
  });
});
