import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// ── Isolated test database ─────────────────────────────────

const TMP_DIR = resolve(tmpdir(), 'clauded-test-webtokens');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'webtokens.db');

let db: Database.Database;

function createTestDb(): Database.Database {
  try { rmSync(DB_PATH); } catch { /* ignore */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create the web_tokens and web_token_audit tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_tokens (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_tokens_chat ON web_tokens(chat_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_tokens_active ON web_tokens(chat_id, revoked_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS web_token_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      action TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      ip TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_token_audit_chat ON web_token_audit(chat_id, created_at)');

  return db;
}

// ── Mock getDatabase to return our test db ──────────────────

import { vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  getDatabase: () => db,
}));

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
} from '../src/web/web-tokens.js';

// ── Tests ───────────────────────────────────────────────────

describe('web-tokens', () => {
  const CHAT_A = '111111';
  const CHAT_B = '222222';

  beforeEach(() => {
    createTestDb();
  });

  afterAll(() => {
    try { db?.close(); } catch { /* ignore */ }
    try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  // ── Creation ────────────────────────────────────────────

  describe('createWebToken', () => {
    it('creates a 64-char hex token', () => {
      const token = createWebToken(CHAT_A, 'laptop');
      expect(token.id).toHaveLength(64);
      expect(token.id).toMatch(/^[0-9a-f]{64}$/);
      expect(token.chat_id).toBe(CHAT_A);
      expect(token.label).toBe('laptop');
      expect(token.expires_at).toBeNull();
      expect(token.revoked_at).toBeNull();
    });

    it('creates token with TTL', () => {
      const token = createWebToken(CHAT_A, 'temp', 3600); // 1 hour
      expect(token.expires_at).not.toBeNull();
      expect(token.expires_at!).toBeGreaterThan(Date.now());
      expect(token.expires_at!).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 100);
    });

    it('allows up to 5 tokens per user', () => {
      for (let i = 0; i < 5; i++) {
        createWebToken(CHAT_A, `token-${i}`);
      }
      expect(getActiveTokenCount(CHAT_A)).toBe(5);
    });

    it('rejects 6th token', () => {
      for (let i = 0; i < 5; i++) {
        createWebToken(CHAT_A, `token-${i}`);
      }
      expect(() => createWebToken(CHAT_A, 'too-many')).toThrow(/Maximum 5/);
    });

    it('different users have independent limits', () => {
      for (let i = 0; i < 5; i++) {
        createWebToken(CHAT_A, `a-${i}`);
      }
      // User B can still create tokens
      const tokenB = createWebToken(CHAT_B, 'b-1');
      expect(tokenB.chat_id).toBe(CHAT_B);
    });

    it('generates unique tokens', () => {
      const t1 = createWebToken(CHAT_A, 'one');
      const t2 = createWebToken(CHAT_A, 'two');
      expect(t1.id).not.toBe(t2.id);
    });
  });

  // ── Listing ─────────────────────────────────────────────

  describe('listWebTokens', () => {
    it('lists tokens for the correct user', () => {
      createWebToken(CHAT_A, 'a1');
      createWebToken(CHAT_A, 'a2');
      createWebToken(CHAT_B, 'b1');

      const tokensA = listWebTokens(CHAT_A);
      expect(tokensA).toHaveLength(2);
      expect(tokensA.every(t => t.chat_id === CHAT_A)).toBe(true);

      const tokensB = listWebTokens(CHAT_B);
      expect(tokensB).toHaveLength(1);
      expect(tokensB[0].chat_id).toBe(CHAT_B);
    });

    it('includes revoked tokens in listing', () => {
      const token = createWebToken(CHAT_A, 'to-revoke');
      revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const tokens = listWebTokens(CHAT_A);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].revoked_at).not.toBeNull();
    });

    it('returns empty array for user with no tokens', () => {
      expect(listWebTokens('999999')).toHaveLength(0);
    });
  });

  // ── Validation ──────────────────────────────────────────

  describe('validateWebToken', () => {
    it('validates a valid token', () => {
      const token = createWebToken(CHAT_A, 'valid');
      const result = validateWebToken(token.id);

      expect(result.valid).toBe(true);
      expect(result.chatId).toBe(CHAT_A);
      expect(result.isLegacy).toBe(false);
      expect(result.tokenPrefix).toBe(token.id.slice(0, 8));
    });

    it('updates last_used_at on validation', () => {
      const token = createWebToken(CHAT_A, 'use-me');
      expect(token.last_used_at).toBeNull();

      validateWebToken(token.id);
      const tokens = listWebTokens(CHAT_A);
      expect(tokens[0].last_used_at).not.toBeNull();
    });

    it('rejects revoked token', () => {
      const token = createWebToken(CHAT_A, 'to-revoke');
      revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const result = validateWebToken(token.id);
      expect(result.valid).toBe(false);
      expect(result.chatId).toBeNull();
    });

    it('rejects expired token', () => {
      // Create with 1-second TTL
      const token = createWebToken(CHAT_A, 'expiring', 1);

      // Manually set expires_at to the past
      db.prepare('UPDATE web_tokens SET expires_at = ? WHERE id = ?').run(
        Date.now() - 1000,
        token.id,
      );

      const result = validateWebToken(token.id);
      expect(result.valid).toBe(false);
    });

    it('rejects non-existent token', () => {
      const fakeToken = 'a'.repeat(64);
      const result = validateWebToken(fakeToken);

      expect(result.valid).toBe(false);
      expect(result.chatId).toBeNull();
    });

    it('rejects short tokens immediately', () => {
      const result = validateWebToken('tooshort');
      expect(result.valid).toBe(false);
    });

    it('rejects empty string', () => {
      const result = validateWebToken('');
      expect(result.valid).toBe(false);
    });
  });

  // ── Revocation ──────────────────────────────────────────

  describe('revokeWebToken', () => {
    it('revokes by prefix', () => {
      const token = createWebToken(CHAT_A, 'to-revoke');
      const prefix = token.id.slice(0, 8);

      const revokedId = revokeWebToken(CHAT_A, prefix);
      expect(revokedId).toBe(token.id);

      // Token no longer validates
      expect(validateWebToken(token.id).valid).toBe(false);
    });

    it('returns null for non-matching prefix', () => {
      createWebToken(CHAT_A, 'mine');
      const result = revokeWebToken(CHAT_A, 'zzzzzzzz');
      expect(result).toBeNull();
    });

    it('cannot revoke another user\'s token', () => {
      const token = createWebToken(CHAT_A, 'mine');
      const result = revokeWebToken(CHAT_B, token.id.slice(0, 8));
      expect(result).toBeNull();

      // Token still valid
      expect(validateWebToken(token.id).valid).toBe(true);
    });

    it('revoking frees up the slot for new tokens', () => {
      const tokens = [];
      for (let i = 0; i < 5; i++) {
        tokens.push(createWebToken(CHAT_A, `t-${i}`));
      }
      expect(() => createWebToken(CHAT_A, 'overflow')).toThrow(/Maximum 5/);

      // Revoke one
      revokeWebToken(CHAT_A, tokens[0].id.slice(0, 8));

      // Now we can create one more
      const newToken = createWebToken(CHAT_A, 'replacement');
      expect(newToken.id).toHaveLength(64);
    });
  });

  describe('revokeAllWebTokens', () => {
    it('revokes all active tokens', () => {
      createWebToken(CHAT_A, 'a1');
      createWebToken(CHAT_A, 'a2');
      createWebToken(CHAT_A, 'a3');

      const count = revokeAllWebTokens(CHAT_A);
      expect(count).toBe(3);
      expect(getActiveTokenCount(CHAT_A)).toBe(0);
    });

    it('does not affect other users', () => {
      createWebToken(CHAT_A, 'a');
      const tokenB = createWebToken(CHAT_B, 'b');

      revokeAllWebTokens(CHAT_A);

      expect(getActiveTokenCount(CHAT_A)).toBe(0);
      expect(validateWebToken(tokenB.id).valid).toBe(true);
    });

    it('returns 0 when no tokens exist', () => {
      expect(revokeAllWebTokens(CHAT_A)).toBe(0);
    });
  });

  // ── Active Token IDs ────────────────────────────────────

  describe('getActiveTokenIds', () => {
    it('returns only active token IDs', () => {
      const t1 = createWebToken(CHAT_A, 'active');
      const t2 = createWebToken(CHAT_A, 'also-active');
      const t3 = createWebToken(CHAT_A, 'to-revoke');
      revokeWebToken(CHAT_A, t3.id.slice(0, 8));

      const ids = getActiveTokenIds(CHAT_A);
      expect(ids).toHaveLength(2);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
      expect(ids).not.toContain(t3.id);
    });
  });

  // ── Audit Logging ───────────────────────────────────────

  describe('audit logging', () => {
    it('logs create events', () => {
      createWebToken(CHAT_A, 'audited');
      const log = getTokenAuditLog(CHAT_A);
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0].action).toBe('create');
    });

    it('logs revoke events', () => {
      const token = createWebToken(CHAT_A, 'to-revoke');
      revokeWebToken(CHAT_A, token.id.slice(0, 8));

      const log = getTokenAuditLog(CHAT_A);
      const revokeEntry = log.find(e => e.action === 'revoke');
      expect(revokeEntry).toBeDefined();
      expect(revokeEntry!.token_prefix).toBe(token.id.slice(0, 8));
    });

    it('logs manual audit events', () => {
      logTokenAudit(CHAT_A, 'auth_success', 'abcd1234', '127.0.0.1');
      const log = getTokenAuditLog(CHAT_A);
      const entry = log.find(e => e.action === 'auth_success');
      expect(entry).toBeDefined();
      expect(entry!.ip).toBe('127.0.0.1');
    });

    it('scopes audit log to user', () => {
      createWebToken(CHAT_A, 'a');
      createWebToken(CHAT_B, 'b');

      const logA = getTokenAuditLog(CHAT_A);
      const logB = getTokenAuditLog(CHAT_B);

      expect(logA.every(e => e.token_prefix.length > 0)).toBe(true);
      expect(logA.length).toBe(1);
      expect(logB.length).toBe(1);
    });
  });
});
