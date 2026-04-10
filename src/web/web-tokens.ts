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
 *
 * Database: Uses Knex for cross-dialect support (SQLite/MariaDB/PostgreSQL).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getKnex } from '../db-knex.js';
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

async function initWebTokenTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('web_tokens'))) {
    await db.schema.createTable('web_tokens', (t) => {
      t.string('id').primary();
      t.string('chat_id').notNullable();
      t.string('label').notNullable().defaultTo('');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').nullable();
      t.bigInteger('last_used_at').nullable();
      t.bigInteger('revoked_at').nullable();
      t.index(['chat_id']);
      t.index(['chat_id', 'revoked_at']);
    });
  }

  if (!(await db.schema.hasTable('web_token_audit'))) {
    await db.schema.createTable('web_token_audit', (t) => {
      t.increments('id').primary();
      t.string('chat_id').notNullable();
      t.string('action').notNullable();
      t.string('token_prefix').notNullable();
      t.string('ip').nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['chat_id', 'created_at']);
    });
  }
}

export const webTokenTableInit: TableInitializer = {
  name: 'web-tokens',
  initTables: initWebTokenTables,
};

// ── Constants ──────────────────────────────────────────────

const MAX_TOKENS_PER_USER = 5;
const TOKEN_BYTES = 32; // 32 bytes = 64 hex chars

// ── Audit Logging ──────────────────────────────────────────

export async function logTokenAudit(
  chatId: string,
  action: 'create' | 'revoke' | 'revoke_all' | 'auth_success' | 'auth_failure',
  tokenPrefix: string,
  ip?: string,
): Promise<void> {
  const db = getKnex();
  await db('web_token_audit').insert({
    chat_id: chatId,
    action,
    token_prefix: tokenPrefix,
    ip: ip || null,
    created_at: Date.now(),
  });
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
export async function createWebToken(
  chatId: string,
  label: string = '',
  ttlSeconds?: number,
): Promise<WebToken> {
  // Validate TTL
  if (ttlSeconds !== undefined && ttlSeconds <= 0) {
    throw new Error('Token TTL must be a positive number of seconds.');
  }

  // Validate label length
  if (label.length > 50) {
    label = label.slice(0, 50);
  }

  const activeCount = await getActiveTokenCount(chatId);
  if (activeCount >= MAX_TOKENS_PER_USER) {
    throw new Error(
      `Maximum ${MAX_TOKENS_PER_USER} active tokens per user. Revoke an existing token first.`,
    );
  }

  const tokenId = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;

  const db = getKnex();
  await db('web_tokens').insert({
    id: tokenId,
    chat_id: chatId,
    label,
    created_at: now,
    expires_at: expiresAt,
  });

  await logTokenAudit(chatId, 'create', tokenId.slice(0, 8));

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
export async function listWebTokens(chatId: string): Promise<WebToken[]> {
  const db = getKnex();
  return db('web_tokens')
    .where({ chat_id: chatId })
    .orderBy('created_at', 'desc') as Promise<WebToken[]>;
}

/**
 * Count active (non-revoked, non-expired) tokens for a user.
 */
export async function getActiveTokenCount(chatId: string): Promise<number> {
  const db = getKnex();
  const now = Date.now();
  const result = await db('web_tokens')
    .where({ chat_id: chatId })
    .whereNull('revoked_at')
    .where(function () {
      this.whereNull('expires_at').orWhere('expires_at', '>', now);
    })
    .count('* as count')
    .first();
  return (result as { count: number })?.count ?? 0;
}

/**
 * Validate a candidate token.
 * Returns validation result with chat_id if valid.
 * Uses timing-safe comparison after DB lookup for defense-in-depth.
 */
export async function validateWebToken(candidateToken: string): Promise<WebTokenValidation> {
  const prefix = candidateToken.slice(0, 8);

  // Quick reject: tokens are always 64 hex chars
  if (candidateToken.length !== TOKEN_BYTES * 2) {
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  const db = getKnex();
  const row = await db('web_tokens').where({ id: candidateToken }).first() as WebToken | undefined;

  if (!row) {
    // Timing equalization: perform a dummy compare so the not-found path
    // takes roughly the same CPU time as the found path.
    const dummy = Buffer.alloc(TOKEN_BYTES * 2, 0);
    timingSafeEqual(Buffer.from(candidateToken), dummy);
    return { valid: false, chatId: null, tokenPrefix: prefix, isLegacy: false };
  }

  // Defense-in-depth: timing-safe verify after DB lookup
  if (!timingSafeEqual(Buffer.from(candidateToken), Buffer.from(row.id))) {
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
  await db('web_tokens').where({ id: row.id }).update({ last_used_at: Date.now() });

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
export async function revokeWebToken(chatId: string, tokenPrefix: string): Promise<string | null> {
  if (tokenPrefix.length < 8) {
    return null; // Require minimum 8-char prefix to avoid accidental revocation
  }

  const db = getKnex();
  const row = await db('web_tokens')
    .where({ chat_id: chatId })
    .where('id', 'like', tokenPrefix + '%')
    .whereNull('revoked_at')
    .orderBy('created_at', 'asc')
    .first() as { id: string } | undefined;

  if (!row) return null;

  await db('web_tokens').where({ id: row.id }).update({ revoked_at: Date.now() });

  await logTokenAudit(chatId, 'revoke', row.id.slice(0, 8));

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
export async function revokeAllWebTokens(chatId: string): Promise<number> {
  const db = getKnex();
  const count = await db('web_tokens')
    .where({ chat_id: chatId })
    .whereNull('revoked_at')
    .update({ revoked_at: Date.now() });

  if (count > 0) {
    await logTokenAudit(chatId, 'revoke_all', 'all');
    logger.info({ chatId, count }, 'All web tokens revoked');
  }

  return count;
}

/**
 * Get all active (non-revoked) token IDs for a user.
 * Used for bulk session disconnect on revoke-all.
 */
export async function getActiveTokenIds(chatId: string): Promise<string[]> {
  const db = getKnex();
  const now = Date.now();
  const rows = await db('web_tokens')
    .select('id')
    .where({ chat_id: chatId })
    .whereNull('revoked_at')
    .where(function () {
      this.whereNull('expires_at').orWhere('expires_at', '>', now);
    }) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Get audit log entries for a user (most recent first).
 */
export async function getTokenAuditLog(chatId: string, limit: number = 20): Promise<Array<{
  action: string;
  token_prefix: string;
  ip: string | null;
  created_at: number;
}>> {
  const db = getKnex();
  return db('web_token_audit')
    .select('action', 'token_prefix', 'ip', 'created_at')
    .where({ chat_id: chatId })
    .orderBy('created_at', 'desc')
    .limit(limit);
}
