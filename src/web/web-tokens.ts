/**
 * Per-user web tokens — self-service authentication for web UIs.
 *
 * Each Telegram user (ALLOWED_CHAT_ID) creates their own tokens via /webtoken.
 * Tokens are scoped to the user's chat_id, so they only see their own data.
 * The legacy VOICE_WEB_TOKEN env var is preserved as a backward-compatible fallback.
 *
 * Design:
 * - Token = 64-char hex (crypto.randomBytes(32))
 * - Max 5 active tokens per user (laptop, phone, etc.)
 * - Optional TTL (default: no expiry)
 * - Immediate revocation disconnects active WebSocket sessions
 * - Audit log for create/revoke/auth events
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getDatabase } from '../db.js';
import type { TableInitializer } from '../core/interfaces.js';
import { logger } from '../logger.js';

// ── Types ──────────────────────────────────────────────────

export interface WebToken {
  id: string;           // 64-char hex token
  chat_id: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface WebTokenValidation {
  valid: boolean;
  chatId: string | null;
  tokenPrefix: string;   // first 8 chars for safe logging
  isLegacy: boolean;      // true if matched via VOICE_WEB_TOKEN
}

// ── Table Initializer ──────────────────────────────────────

const TOKEN_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS web_tokens (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  )
`;

const AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS web_token_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    action TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL
  )
`;

function initWebTokenTables(): void {
  const db = getDatabase();
  db.exec(TOKEN_TABLE_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_tokens_chat ON web_tokens(chat_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_tokens_active ON web_tokens(chat_id, revoked_at)');
  db.exec(AUDIT_TABLE_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_token_audit_chat ON web_token_audit(chat_id, created_at)');
}

export const webTokenTableInit: TableInitializer = {
  name: 'web-tokens',
  initTables: initWebTokenTables,
};

// ── Constants ──────────────────────────────────────────────

const MAX_TOKENS_PER_USER = 5;
const TOKEN_BYTES = 32; // 32 bytes = 64 hex chars

// ── Audit Logging ──────────────────────────────────────────

export function logTokenAudit(
  chatId: string,
  action: 'create' | 'revoke' | 'revoke_all' | 'auth_success' | 'auth_failure',
  tokenPrefix: string,
  ip?: string,
): void {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO web_token_audit (chat_id, action, token_prefix, ip, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, action, tokenPrefix, ip || null, Date.now());
}

// ── CRUD ───────────────────────────────────────────────────

/**
 * Create a new web token for a user.
 * @param chatId Telegram chat ID of the token owner
 * @param label Optional label (e.g. "laptop", "office PC")
 * @param ttlSeconds Optional time-to-live in seconds (null = no expiry)
 * @returns The created token (full value shown only once)
 * @throws Error if user already has MAX_TOKENS_PER_USER active tokens
 */
export function createWebToken(
  chatId: string,
  label: string = '',
  ttlSeconds?: number,
): WebToken {
  // Validate TTL
  if (ttlSeconds !== undefined && ttlSeconds <= 0) {
    throw new Error('Token TTL must be a positive number of seconds.');
  }

  // Validate label length
  if (label.length > 50) {
    label = label.slice(0, 50);
  }

  const activeCount = getActiveTokenCount(chatId);
  if (activeCount >= MAX_TOKENS_PER_USER) {
    throw new Error(
      `Maximum ${MAX_TOKENS_PER_USER} active tokens per user. Revoke an existing token first.`,
    );
  }

  const tokenId = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;

  const db = getDatabase();
  db.prepare(
    'INSERT INTO web_tokens (id, chat_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(tokenId, chatId, label, now, expiresAt);

  logTokenAudit(chatId, 'create', tokenId.slice(0, 8));

  logger.info(
    { chatId, tokenPrefix: tokenId.slice(0, 8), label },
    'Web token created',
  );

  return {
    id: tokenId,
    chat_id: chatId,
    label,
    created_at: now,
    expires_at: expiresAt,
    last_used_at: null,
    revoked_at: null,
  };
}

/**
 * List all tokens for a user (active and revoked).
 */
export function listWebTokens(chatId: string): WebToken[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM web_tokens WHERE chat_id = ? ORDER BY created_at DESC',
  ).all(chatId) as WebToken[];
}

/**
 * Count active (non-revoked, non-expired) tokens for a user.
 */
export function getActiveTokenCount(chatId: string): number {
  const db = getDatabase();
  const now = Date.now();
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM web_tokens WHERE chat_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).get(chatId, now) as { count: number };
  return result.count;
}

/**
 * Validate a candidate token.
 * Returns validation result with chat_id if valid.
 * Uses timing-safe comparison after DB lookup for defense-in-depth.
 */
export function validateWebToken(candidateToken: string): WebTokenValidation {
  const prefix = candidateToken.slice(0, 8);

  // Quick reject: tokens are always 64 hex chars
  if (candidateToken.length !== TOKEN_BYTES * 2) {
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM web_tokens WHERE id = ?',
  ).get(candidateToken) as WebToken | undefined;

  if (!row) {
    // Dummy timing-safe compare to prevent timing leaks
    const dummy = randomBytes(TOKEN_BYTES).toString('hex');
    timingSafeEqual(Buffer.from(candidateToken), Buffer.from(dummy));
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  // Timing-safe verify (defense-in-depth — DB already matched by PK)
  const match = timingSafeEqual(
    Buffer.from(candidateToken),
    Buffer.from(row.id),
  );

  if (!match) {
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  // Check revocation
  if (row.revoked_at !== null) {
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  // Check expiry
  if (row.expires_at !== null && Date.now() > row.expires_at) {
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  // Valid — update last_used_at
  db.prepare('UPDATE web_tokens SET last_used_at = ? WHERE id = ?').run(
    Date.now(),
    row.id,
  );

  return {
    valid: true,
    chatId: row.chat_id,
    tokenPrefix: prefix,
    isLegacy: false,
  };
}

/**
 * Revoke a token by its prefix (minimum 8 chars for safety).
 * Only the token owner (matching chat_id) can revoke their own tokens.
 * If multiple tokens match, the oldest (first created) is revoked.
 * @returns The full token ID if revoked (for session disconnect), or null if not found
 */
export function revokeWebToken(chatId: string, tokenPrefix: string): string | null {
  if (tokenPrefix.length < 8) {
    return null; // Require minimum 8-char prefix to avoid accidental revocation
  }

  const db = getDatabase();
  const row = db.prepare(
    'SELECT id FROM web_tokens WHERE chat_id = ? AND id LIKE ? AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1',
  ).get(chatId, tokenPrefix + '%') as { id: string } | undefined;

  if (!row) return null;

  db.prepare('UPDATE web_tokens SET revoked_at = ? WHERE id = ?').run(
    Date.now(),
    row.id,
  );

  logTokenAudit(chatId, 'revoke', row.id.slice(0, 8));

  logger.info(
    { chatId, tokenPrefix: row.id.slice(0, 8) },
    'Web token revoked',
  );

  return row.id;
}

/**
 * Revoke ALL active tokens for a user.
 * @returns Number of tokens revoked
 */
export function revokeAllWebTokens(chatId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    'UPDATE web_tokens SET revoked_at = ? WHERE chat_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), chatId);

  if (result.changes > 0) {
    logTokenAudit(chatId, 'revoke_all', 'all');
    logger.info({ chatId, count: result.changes }, 'All web tokens revoked');
  }

  return result.changes;
}

/**
 * Get all active (non-revoked) token IDs for a user.
 * Used for bulk session disconnect on revoke-all.
 */
export function getActiveTokenIds(chatId: string): string[] {
  const db = getDatabase();
  const now = Date.now();
  const rows = db.prepare(
    'SELECT id FROM web_tokens WHERE chat_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).all(chatId, now) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Get audit log entries for a user (most recent first).
 */
export function getTokenAuditLog(chatId: string, limit: number = 20): Array<{
  action: string;
  token_prefix: string;
  ip: string | null;
  created_at: number;
}> {
  const db = getDatabase();
  return db.prepare(
    'SELECT action, token_prefix, ip, created_at FROM web_token_audit WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(chatId, limit) as Array<{
    action: string;
    token_prefix: string;
    ip: string | null;
    created_at: number;
  }>;
}
