/**
 * Policy Engine — Real Execution Tests (SA4)
 *
 * No mocks for behavior. Real SQLite for trust memory.
 * Validates: risk evaluation, trust decisions, confirmation flow, bilingual messages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
vi.mock('../src/db.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return { ...original, getDatabase: () => db };
});

import {
  evaluatePolicy,
  registerToolPolicy,
  getToolPolicy,
  initPolicyTables,
  getTrustDecision,
  setTrustDecision,
  revokeTrust,
  clearAllTrust,
  listTrustEntries,
  detectConfirmationResponse,
  formatTrustList,
} from '../src/policy-engine.js';
import type { ToolPolicy } from '../src/core/interfaces.js';

function setupDb(): void {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initPolicyTables();
}

describe('policy-engine — real execution', () => {
  beforeEach(() => setupDb());
  afterEach(() => db.close());

  // ── Risk evaluation ────────────────────────────────────────

  describe('evaluatePolicy', () => {
    it('allows low-risk tools without confirmation', () => {
      registerToolPolicy('get_time', { riskLevel: 'low', scopes: ['stateless'], requiresConfirmation: false });
      const decision = evaluatePolicy('get_time', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
    });

    it('allows medium-risk tools without confirmation', () => {
      registerToolPolicy('save_memory', { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false });
      const decision = evaluatePolicy('save_memory', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
    });

    it('allows high-risk tools without confirmation', () => {
      registerToolPolicy('web_search', { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false });
      const decision = evaluatePolicy('web_search', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
    });

    it('requires confirmation for critical tools', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });
      const decision = evaluatePolicy('run_command', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.confirmationPrompt).toContain('[EN]');
      expect(decision.confirmationPrompt).toContain('[ES]');
      expect(decision.confirmationPrompt).toContain('run_command');
    });

    it('skips confirmation for critical tool when user has trusted it', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });
      setTrustDecision('chat-1', 'run_command', 'allow');

      const decision = evaluatePolicy('run_command', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false); // trusted!
    });

    it('blocks tool when user has blocked it', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });
      setTrustDecision('chat-1', 'run_command', 'block');

      const decision = evaluatePolicy('run_command', 'chat-1');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('[EN]');
      expect(decision.reason).toContain('[ES]');
      expect(decision.reason).toContain('blocked');
    });

    it('uses default medium policy for unknown tools', () => {
      const decision = evaluatePolicy('unknown_tool', 'chat-1');
      expect(decision.allowed).toBe(true);
      expect(decision.requiresConfirmation).toBe(false);
    });
  });

  // ── Trust memory ───────────────────────────────────────────

  describe('trust memory', () => {
    it('stores and retrieves allow decision', () => {
      setTrustDecision('chat-1', 'run_command', 'allow');
      expect(getTrustDecision('chat-1', 'run_command')).toBe('allow');
    });

    it('stores and retrieves block decision', () => {
      setTrustDecision('chat-1', 'github_commit_push', 'block');
      expect(getTrustDecision('chat-1', 'github_commit_push')).toBe('block');
    });

    it('returns null for no decision', () => {
      expect(getTrustDecision('chat-1', 'run_command')).toBeNull();
    });

    it('respects per-user isolation', () => {
      setTrustDecision('user-a', 'run_command', 'allow');
      setTrustDecision('user-b', 'run_command', 'block');
      expect(getTrustDecision('user-a', 'run_command')).toBe('allow');
      expect(getTrustDecision('user-b', 'run_command')).toBe('block');
    });

    it('revokeTrust removes specific decision', () => {
      setTrustDecision('chat-1', 'run_command', 'allow');
      setTrustDecision('chat-1', 'web_search', 'allow');

      const revoked = revokeTrust('chat-1', 'run_command');
      expect(revoked).toBe(true);
      expect(getTrustDecision('chat-1', 'run_command')).toBeNull();
      expect(getTrustDecision('chat-1', 'web_search')).toBe('allow'); // untouched
    });

    it('clearAllTrust removes all decisions for a chat', () => {
      setTrustDecision('chat-1', 'run_command', 'allow');
      setTrustDecision('chat-1', 'web_search', 'block');
      setTrustDecision('chat-2', 'run_command', 'allow');

      const cleared = clearAllTrust('chat-1');
      expect(cleared).toBe(2);
      expect(getTrustDecision('chat-1', 'run_command')).toBeNull();
      expect(getTrustDecision('chat-1', 'web_search')).toBeNull();
      expect(getTrustDecision('chat-2', 'run_command')).toBe('allow'); // different user untouched
    });

    it('listTrustEntries returns all decisions for a chat', () => {
      setTrustDecision('chat-1', 'run_command', 'allow');
      setTrustDecision('chat-1', 'github_commit_push', 'block');

      const entries = listTrustEntries('chat-1');
      expect(entries).toHaveLength(2);
      expect(entries.find(e => e.toolName === 'run_command')?.decision).toBe('allow');
      expect(entries.find(e => e.toolName === 'github_commit_push')?.decision).toBe('block');
    });

    it('handles trust expiration', () => {
      // Set trust with past expiration
      setTrustDecision('chat-1', 'run_command', 'allow', Date.now() - 1000);
      expect(getTrustDecision('chat-1', 'run_command')).toBeNull(); // expired
    });

    it('permanent trust (no expiration) persists', () => {
      setTrustDecision('chat-1', 'run_command', 'allow', null);
      expect(getTrustDecision('chat-1', 'run_command')).toBe('allow');
    });
  });

  // ── Confirmation response detection ────────────────────────

  describe('detectConfirmationResponse', () => {
    it('detects "once" responses (EN + ES)', () => {
      expect(detectConfirmationResponse('confirm')).toBe('once');
      expect(detectConfirmationResponse('confirmar')).toBe('once');
      expect(detectConfirmationResponse('ok')).toBe('once');
      expect(detectConfirmationResponse('proceed')).toBe('once');
    });

    it('detects "always" responses (EN + ES)', () => {
      expect(detectConfirmationResponse('always')).toBe('always');
      expect(detectConfirmationResponse('siempre')).toBe('always');
    });

    it('detects "never" responses (EN + ES)', () => {
      expect(detectConfirmationResponse('never')).toBe('never');
      expect(detectConfirmationResponse('nunca')).toBe('never');
      expect(detectConfirmationResponse('block')).toBe('never');
      expect(detectConfirmationResponse('bloquear')).toBe('never');
    });

    it('returns null for normal messages', () => {
      expect(detectConfirmationResponse('What is the weather?')).toBeNull();
      expect(detectConfirmationResponse('Show me the report')).toBeNull();
    });
  });

  // ── Trust formatting ───────────────────────────────────────

  describe('formatTrustList', () => {
    it('shows bilingual empty state', () => {
      const msg = formatTrustList([]);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('No trust');
    });

    it('shows entries with emoji indicators', () => {
      const entries = [
        { chatId: 'c', toolName: 'run_command', decision: 'allow' as const, trustedAt: Date.now(), expiresAt: null },
        { chatId: 'c', toolName: 'github_push', decision: 'block' as const, trustedAt: Date.now(), expiresAt: null },
      ];
      const msg = formatTrustList(entries);
      expect(msg).toContain('✅');
      expect(msg).toContain('🚫');
      expect(msg).toContain('run_command');
      expect(msg).toContain('github_push');
    });
  });

  // ── Full confirmation lifecycle ────────────────────────────

  describe('full confirmation lifecycle', () => {
    it('critical tool → confirm once → no trust stored → asks again', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });

      // First call: requires confirmation
      const d1 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d1.requiresConfirmation).toBe(true);

      // User says "confirm" (once) — no trust stored
      const response = detectConfirmationResponse('confirm');
      expect(response).toBe('once');
      // Don't store trust for "once"

      // Second call: still requires confirmation
      const d2 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d2.requiresConfirmation).toBe(true);
    });

    it('critical tool → always → trust stored → no more confirmation', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });

      // First call: requires confirmation
      const d1 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d1.requiresConfirmation).toBe(true);

      // User says "always" — store trust
      const response = detectConfirmationResponse('always');
      expect(response).toBe('always');
      setTrustDecision('lifecycle-chat', 'run_command', 'allow');

      // Second call: no confirmation needed
      const d2 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d2.requiresConfirmation).toBe(false);
      expect(d2.allowed).toBe(true);
    });

    it('critical tool → never → blocked → revoke → asks again', () => {
      registerToolPolicy('run_command', { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true });

      // User blocks
      setTrustDecision('lifecycle-chat', 'run_command', 'block');
      const d1 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d1.allowed).toBe(false);

      // User revokes block
      revokeTrust('lifecycle-chat', 'run_command');
      const d2 = evaluatePolicy('run_command', 'lifecycle-chat');
      expect(d2.allowed).toBe(true);
      expect(d2.requiresConfirmation).toBe(true); // back to default
    });
  });

  // ── Policy registration ────────────────────────────────────

  describe('policy registration', () => {
    it('registers and retrieves tool policy', () => {
      const policy: ToolPolicy = {
        riskLevel: 'high',
        scopes: ['network', 'filesystem:read'],
        requiresConfirmation: false,
      };
      registerToolPolicy('web_search', policy);
      expect(getToolPolicy('web_search')).toEqual(policy);
    });

    it('returns undefined for unregistered tool', () => {
      expect(getToolPolicy('nonexistent')).toBeUndefined();
    });
  });

  // ── Pending confirmation state machine ─────────────────────

  describe('pending confirmation state machine', () => {
    it('stores and retrieves pending confirmation', async () => {
      const { setPendingConfirmation, getPendingConfirmation } = await import('../src/policy-engine.js');
      setPendingConfirmation('state-chat', 'run_command', { command: 'ls -la' });
      const pending = getPendingConfirmation('state-chat');
      expect(pending).not.toBeNull();
      expect(pending!.toolName).toBe('run_command');
      expect(pending!.args).toEqual({ command: 'ls -la' });
    });

    it('clears pending confirmation', async () => {
      const { setPendingConfirmation, getPendingConfirmation, clearPendingConfirmation } = await import('../src/policy-engine.js');
      setPendingConfirmation('clear-chat', 'run_command', { command: 'ls' });
      clearPendingConfirmation('clear-chat');
      expect(getPendingConfirmation('clear-chat')).toBeNull();
    });

    it('handleToolConfirmation with "once" executes without storing trust', async () => {
      const { setPendingConfirmation, handleToolConfirmation } = await import('../src/policy-engine.js');
      setPendingConfirmation('once-chat', 'get_time', {});

      const mockExecute = async () => ({ time: '12:00' });
      const result = await handleToolConfirmation('once-chat', 'once', mockExecute);

      expect(result.executed).toBe(true);
      expect(result.result).toEqual({ time: '12:00' });
      // No trust stored
      expect(getTrustDecision('once-chat', 'get_time')).toBeNull();
    });

    it('handleToolConfirmation with "always" executes AND stores trust', async () => {
      const { setPendingConfirmation, handleToolConfirmation } = await import('../src/policy-engine.js');
      setPendingConfirmation('always-chat', 'run_command', { command: 'ls' });

      const mockExecute = async () => ({ output: 'file1.txt' });
      const result = await handleToolConfirmation('always-chat', 'always', mockExecute);

      expect(result.executed).toBe(true);
      expect(result.result).toEqual({ output: 'file1.txt' });
      expect(result.message).toContain('Trust remembered');
      expect(result.message).toContain('[EN]');
      expect(result.message).toContain('[ES]');
      // Trust IS stored
      expect(getTrustDecision('always-chat', 'run_command')).toBe('allow');
    });

    it('handleToolConfirmation with "never" blocks without executing', async () => {
      const { setPendingConfirmation, handleToolConfirmation } = await import('../src/policy-engine.js');
      setPendingConfirmation('never-chat', 'github_commit_push', { repo: 'test' });

      const mockExecute = async () => ({ should: 'not be called' });
      const result = await handleToolConfirmation('never-chat', 'never', mockExecute);

      expect(result.executed).toBe(false);
      expect(result.result).toBeNull();
      expect(result.message).toContain('blocked');
      expect(result.message).toContain('[EN]');
      expect(result.message).toContain('[ES]');
      // Block IS stored
      expect(getTrustDecision('never-chat', 'github_commit_push')).toBe('block');
    });

    it('returns error when no pending confirmation exists', async () => {
      const { handleToolConfirmation } = await import('../src/policy-engine.js');
      const mockExecute = async () => ({});
      const result = await handleToolConfirmation('empty-chat', 'once', mockExecute);

      expect(result.executed).toBe(false);
      expect(result.message).toContain('No pending');
    });
  });
});
