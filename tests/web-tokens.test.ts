import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

// ── Knex test instance ─────────────────────────────────────

let testKnex: Knex;

// Mock getKnex to return our test instance
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getKnex: () => testKnex,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}));

// Import AFTER mocking
import {
  createWebToken,
  listWebTokens,
  getActiveTokenCount,
  validateWebToken,
  revokeWebToken,
  revokeAllWebTokens,
  getActiveTokenIds,
  logTokenAudit,
  getTokenAuditLog,
  webTokenTableInit,
} from '../src/web/web-tokens.js';

// ── Tests ───────────────────────────────────────────────────

describe('web-tokens', () => {
  const CHAT_A = '111111';
  const CHAT_B = '222222';

  beforeEach(async () => {
    // Fresh in-memory DB for each test
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    // Initialize tables via the module's own init function
    await webTokenTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // ── Creation ────────────────────────────────────────────

  describe('createWebToken', () => {
    it('creates a 64-char hex token', async () => {
      const token = await createWebToken(CHAT_A, 'laptop');
      expect(token.id).toHaveLength(64);
      expect(token.id).toMatch(/^[0-9a-f]{64}$/);
      expect(token.chat_id).toBe(CHAT_A);
      expect(token.label).toBe('laptop');
      expect(token.expires_at).toBeNull();
      expect(token.revoked_at).toBeNull();
    });

    it('creates token with TTL', async () => {
      const token = await createWebToken(CHAT_A, 'temp', 3600);
      expect(token.expires_at).not.toBeNull();
      expect(token.expires_at!).toBeGreaterThan(Date.now());
      expect(token.expires_at!).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 100);
    });

    it('allows up to 5 tokens per user', async () => {
      for (let i = 0; i < 5; i++) {
        await createWebToken(CHAT_A, `token-${i}`);
      }
      expect(await getActiveTokenCount(CHAT_A)).toBe(5);
    });

    it('rejects 6th token', async () => {
      for (let i = 0; i < 5; i++) {
        await createWebToken(CHAT_A, `token-${i}`);
      }
      await expect(createWebToken(CHAT_A, 'too-many')).rejects.toThrow(/Maximum 5/);
    });

    it('different users have independent limits', async () => {
      for (let i = 0; i < 5; i++) {
        await createWebToken(CHAT_A, `a-${i}`);
      }
      const tokenB = await createWebToken(CHAT_B, 'b-1');
      expect(tokenB.chat_id).toBe(CHAT_B);
    });

    it('generates unique tokens', async () => {
      const t1 = await createWebToken(CHAT_A, 'one');
      const t2 = await createWebToken(CHAT_A, 'two');
      expect(t1.id).not.toBe(t2.id);
    });

    it('rejects TTL of zero', async () => {
      await expect(createWebToken(CHAT_A, 'zero-ttl', 0)).rejects.toThrow(/positive/);
    });

    it('rejects negative TTL', async () => {
      await expect(createWebToken(CHAT_A, 'neg-ttl', -3600)).rejects.toThrow(/positive/);
    });

    it('truncates label to 50 chars', async () => {
      const longLabel = 'x'.repeat(100);
      const token = await createWebToken(CHAT_A, longLabel);
      expect(token.label).toHaveLength(50);
    });
  });

  // ── Listing ─────────────────────────────────────────────

  describe('listWebTokens', () => {
    it('lists tokens for the correct user', async () => {
      await createWebToken(CHAT_A, 'a1');
      await createWebToken(CHAT_A, 'a2');
      await createWebToken(CHAT_B, 'b1');

      const tokensA = await listWebTokens(CHAT_A);
      expect(tokensA).toHaveLength(2);
      expect(tokensA.every(t => t.chat_id === CHAT_A)).toBe(true);

      const tokensB = await listWebTokens(CHAT_B);
      expect(tokensB).toHaveLength(1);
      expect(tokensB[0].chat_id).toBe(CHAT_B);
    });

    it('includes revoked tokens in listing', async () => {
      const token = await createWebToken(CHAT_A, 'to-revoke');
      await revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const tokens = await listWebTokens(CHAT_A);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].revoked_at).not.toBeNull();
    });

    it('returns empty array for user with no tokens', async () => {
      expect(await listWebTokens('999999')).toHaveLength(0);
    });
  });

  // ── Validation ──────────────────────────────────────────

  describe('validateWebToken', () => {
    it('validates a valid token', async () => {
      const token = await createWebToken(CHAT_A, 'valid');
      const result = await validateWebToken(token.id);

      expect(result.valid).toBe(true);
      expect(result.chatId).toBe(CHAT_A);
      expect(result.isLegacy).toBe(false);
      expect(result.tokenPrefix).toBe(token.id.slice(0, 8));
    });

    it('updates last_used_at on validation', async () => {
      const token = await createWebToken(CHAT_A, 'use-me');
      expect(token.last_used_at).toBeNull();

      await validateWebToken(token.id);
      const tokens = await listWebTokens(CHAT_A);
      expect(tokens[0].last_used_at).not.toBeNull();
    });

    it('rejects revoked token', async () => {
      const token = await createWebToken(CHAT_A, 'to-revoke');
      await revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const result = await validateWebToken(token.id);
      expect(result.valid).toBe(false);
      expect(result.chatId).toBeNull();
    });

    it('rejects expired token', async () => {
      const token = await createWebToken(CHAT_A, 'expiring', 1);
      // Manually set expires_at to the past
      await testKnex('web_tokens').where({ id: token.id }).update({ expires_at: Date.now() - 1000 });

      const result = await validateWebToken(token.id);
      expect(result.valid).toBe(false);
    });

    it('rejects non-existent token', async () => {
      const fakeToken = 'a'.repeat(64);
      const result = await validateWebToken(fakeToken);

      expect(result.valid).toBe(false);
      expect(result.chatId).toBeNull();
    });

    it('rejects short tokens immediately', async () => {
      const result = await validateWebToken('tooshort');
      expect(result.valid).toBe(false);
    });

    it('rejects empty string', async () => {
      const result = await validateWebToken('');
      expect(result.valid).toBe(false);
    });
  });

  // ── Revocation ──────────────────────────────────────────

  describe('revokeWebToken', () => {
    it('revokes by prefix', async () => {
      const token = await createWebToken(CHAT_A, 'to-revoke');
      const prefix = token.id.slice(0, 8);

      const revokedId = await revokeWebToken(CHAT_A, prefix);
      expect(revokedId).toBe(token.id);

      expect((await validateWebToken(token.id)).valid).toBe(false);
    });

    it('returns null for non-matching prefix', async () => {
      await createWebToken(CHAT_A, 'mine');
      const result = await revokeWebToken(CHAT_A, 'zzzzzzzz');
      expect(result).toBeNull();
    });

    it('rejects prefix shorter than 8 chars', async () => {
      const token = await createWebToken(CHAT_A, 'short-prefix');
      const result = await revokeWebToken(CHAT_A, token.id.slice(0, 4));
      expect(result).toBeNull();
      expect((await validateWebToken(token.id)).valid).toBe(true);
    });

    it('cannot revoke another user\'s token', async () => {
      const token = await createWebToken(CHAT_A, 'mine');
      const result = await revokeWebToken(CHAT_B, token.id.slice(0, 8));
      expect(result).toBeNull();
      expect((await validateWebToken(token.id)).valid).toBe(true);
    });

    it('revoking frees up the slot for new tokens', async () => {
      const tokens = [];
      for (let i = 0; i < 5; i++) {
        tokens.push(await createWebToken(CHAT_A, `t-${i}`));
      }
      await expect(createWebToken(CHAT_A, 'overflow')).rejects.toThrow(/Maximum 5/);

      await revokeWebToken(CHAT_A, tokens[0].id.slice(0, 8));

      const newToken = await createWebToken(CHAT_A, 'replacement');
      expect(newToken.id).toHaveLength(64);
    });
  });

  describe('revokeAllWebTokens', () => {
    it('revokes all active tokens', async () => {
      await createWebToken(CHAT_A, 'a1');
      await createWebToken(CHAT_A, 'a2');
      await createWebToken(CHAT_A, 'a3');

      const count = await revokeAllWebTokens(CHAT_A);
      expect(count).toBe(3);
      expect(await getActiveTokenCount(CHAT_A)).toBe(0);
    });

    it('does not affect other users', async () => {
      await createWebToken(CHAT_A, 'a');
      const tokenB = await createWebToken(CHAT_B, 'b');

      await revokeAllWebTokens(CHAT_A);

      expect(await getActiveTokenCount(CHAT_A)).toBe(0);
      expect((await validateWebToken(tokenB.id)).valid).toBe(true);
    });

    it('returns 0 when no tokens exist', async () => {
      expect(await revokeAllWebTokens(CHAT_A)).toBe(0);
    });
  });

  // ── Active Token IDs ────────────────────────────────────

  describe('getActiveTokenIds', () => {
    it('returns only active token IDs', async () => {
      const t1 = await createWebToken(CHAT_A, 'active');
      const t2 = await createWebToken(CHAT_A, 'also-active');
      const t3 = await createWebToken(CHAT_A, 'to-revoke');
      await revokeWebToken(CHAT_A, t3.id.slice(0, 8));

      const ids = await getActiveTokenIds(CHAT_A);
      expect(ids).toHaveLength(2);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
      expect(ids).not.toContain(t3.id);
    });
  });

  // ── Audit Logging ───────────────────────────────────────

  describe('audit logging', () => {
    it('logs create events', async () => {
      await createWebToken(CHAT_A, 'audited');
      const log = await getTokenAuditLog(CHAT_A);
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0].action).toBe('create');
    });

    it('logs revoke events', async () => {
      const token = await createWebToken(CHAT_A, 'to-revoke');
      await revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const log = await getTokenAuditLog(CHAT_A);
      const revokeEntry = log.find(e => e.action === 'revoke');
      expect(revokeEntry).toBeDefined();
      expect(revokeEntry!.token_prefix).toBe(token.id.slice(0, 8));
    });

    it('logs manual audit events', async () => {
      await logTokenAudit(CHAT_A, 'auth_success', 'abcd1234', '127.0.0.1');
      const log = await getTokenAuditLog(CHAT_A);
      const entry = log.find(e => e.action === 'auth_success');
      expect(entry).toBeDefined();
      expect(entry!.ip).toBe('127.0.0.1');
    });

    it('scopes audit log to user', async () => {
      await createWebToken(CHAT_A, 'a');
      await createWebToken(CHAT_B, 'b');

      const logA = await getTokenAuditLog(CHAT_A);
      const logB = await getTokenAuditLog(CHAT_B);

      expect(logA.every(e => e.token_prefix.length > 0)).toBe(true);
      expect(logA.length).toBe(1);
      expect(logB.length).toBe(1);
    });
  });
});
