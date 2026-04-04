/**
 * Policy Engine — central tool permission enforcement (SA4).
 *
 * Evaluates whether a tool should be allowed to execute based on:
 * 1. Per-user trust memory (allow/block decisions stored in DB)
 * 2. Tool risk level (low/medium/high/critical)
 * 3. Confirmation requirements for critical tools
 *
 * "Flipping to least-privilege defaults would reduce accidental overexposure." — CTO
 */

import { getDatabase } from './db.js';
import { logger } from './logger.js';
import type { ToolPolicy, PolicyDecision, ToolEntry } from './core/interfaces.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Table Initialization ─────────────────────────────────────

export function initPolicyTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_trust (
      chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('allow', 'block')),
      trusted_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (chat_id, tool_name)
    );
  `);
}

export const policyTableInit: TableInitializer = {
  name: 'policy-engine',
  initTables: initPolicyTables,
};

// ── Trust Memory ─────────────────────────────────────────────

export type TrustDecision = 'allow' | 'block';

export interface TrustEntry {
  chatId: string;
  toolName: string;
  decision: TrustDecision;
  trustedAt: number;
  expiresAt: number | null;
}

export function getTrustDecision(chatId: string, toolName: string): TrustDecision | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT decision, expires_at FROM tool_trust WHERE chat_id = ? AND tool_name = ?',
  ).get(chatId, toolName) as { decision: string; expires_at: number | null } | undefined;

  if (!row) return null;

  // Check expiration
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare('DELETE FROM tool_trust WHERE chat_id = ? AND tool_name = ?').run(chatId, toolName);
    return null;
  }

  return row.decision as TrustDecision;
}

export function setTrustDecision(
  chatId: string,
  toolName: string,
  decision: TrustDecision,
  expiresAt?: number | null,
): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO tool_trust (chat_id, tool_name, decision, trusted_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, toolName, decision, Date.now(), expiresAt ?? null);
}

export function revokeTrust(chatId: string, toolName: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM tool_trust WHERE chat_id = ? AND tool_name = ?').run(chatId, toolName);
  return result.changes > 0;
}

export function clearAllTrust(chatId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM tool_trust WHERE chat_id = ?').run(chatId);
  return result.changes;
}

export function listTrustEntries(chatId: string): TrustEntry[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT chat_id, tool_name, decision, trusted_at, expires_at FROM tool_trust WHERE chat_id = ?',
  ).all(chatId) as Array<{ chat_id: string; tool_name: string; decision: string; trusted_at: number; expires_at: number | null }>;

  return rows.map((r) => ({
    chatId: r.chat_id,
    toolName: r.tool_name,
    decision: r.decision as TrustDecision,
    trustedAt: r.trusted_at,
    expiresAt: r.expires_at,
  }));
}

// ── Policy Evaluation ────────────────────────────────────────

/** Policy registry — maps tool name to policy (populated during tool registration) */
const policyRegistry = new Map<string, ToolPolicy>();

/**
 * Register a tool's policy in the engine.
 * Called during tool registration in providers/tools/index.ts.
 */
export function registerToolPolicy(toolName: string, policy: ToolPolicy): void {
  policyRegistry.set(toolName, policy);
}

/**
 * Get a tool's registered policy.
 */
export function getToolPolicy(toolName: string): ToolPolicy | undefined {
  return policyRegistry.get(toolName);
}

/**
 * Default policy for tools without explicit risk metadata.
 * Applies to user-generated tools and unclassified tools.
 */
const DEFAULT_POLICY: ToolPolicy = {
  riskLevel: 'medium',
  scopes: [],
  requiresConfirmation: false,
};

/**
 * Evaluate whether a tool should be allowed to execute.
 *
 * Evaluation order:
 * 1. Check trust memory (per-user allow/block decisions)
 * 2. Check tool policy (risk level, confirmation requirements)
 * 3. Return decision with optional confirmation prompt
 */
export function evaluatePolicy(toolName: string, chatId: string): PolicyDecision {
  // 1. Check trust memory first
  try {
    const trust = getTrustDecision(chatId, toolName);

    if (trust === 'block') {
      return {
        allowed: false,
        requiresConfirmation: false,
        reason: `[EN] Tool "${toolName}" is blocked for your account. Use /trust revoke ${toolName} to unblock. `
          + `[ES] La herramienta "${toolName}" esta bloqueada para tu cuenta. Usa /trust revoke ${toolName} para desbloquear.`,
      };
    }

    if (trust === 'allow') {
      // User previously trusted this tool — skip confirmation
      return { allowed: true, requiresConfirmation: false };
    }
  } catch {
    // DB not ready — skip trust check, fall through to policy
  }

  // 2. Check tool policy
  const policy = policyRegistry.get(toolName) ?? DEFAULT_POLICY;

  // Low and medium: always allowed, no confirmation
  if (policy.riskLevel === 'low' || policy.riskLevel === 'medium') {
    return { allowed: true, requiresConfirmation: false };
  }

  // High: allowed, logged, no confirmation by default
  if (policy.riskLevel === 'high') {
    logger.debug({ tool: toolName, risk: 'high', chatId }, 'High-risk tool execution');
    return { allowed: true, requiresConfirmation: false };
  }

  // Critical: requires confirmation (unless trusted)
  if (policy.riskLevel === 'critical' && policy.requiresConfirmation) {
    return {
      allowed: true,
      requiresConfirmation: true,
      confirmationPrompt: buildConfirmationPrompt(toolName),
    };
  }

  return { allowed: true, requiresConfirmation: false };
}

// ── Confirmation Prompt ──────────────────────────────────────

function buildConfirmationPrompt(toolName: string): string {
  return [
    `[EN] Tool "${toolName}" requires confirmation before execution.`,
    `  "confirm" / "confirmar" — allow this once`,
    `  "always" / "siempre" — always allow for you (remember)`,
    `  "never" / "nunca" — block this tool for your account`,
    `[ES] La herramienta "${toolName}" requiere confirmacion antes de ejecutarse.`,
    `  "confirm" / "confirmar" — permitir una vez`,
    `  "always" / "siempre" — permitir siempre (recordar)`,
    `  "never" / "nunca" — bloquear esta herramienta para tu cuenta`,
  ].join('\n');
}

/**
 * Detect user's response to a tool confirmation prompt.
 */
export function detectConfirmationResponse(message: string): 'once' | 'always' | 'never' | null {
  const lower = message.trim().toLowerCase();
  if (lower.split(/\s+/).length > 3) return null;

  if (/^(confirm|confirmar|ok|proceed|ejecutar)$/i.test(lower)) return 'once';
  if (/^(always|siempre|always allow|permitir siempre)$/i.test(lower)) return 'always';
  if (/^(never|nunca|block|bloquear|never allow)$/i.test(lower)) return 'never';

  return null;
}

// ── Pending Confirmation State Machine ────────────────────────
// When a critical tool requires confirmation, we store the pending
// state so the next user message can be intercepted. Works across
// all interfaces: Telegram, Matrix, and voice web.

export interface PendingConfirmation {
  toolName: string;
  args: Record<string, unknown>;
  chatId: string;
  createdAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

/** TTL for pending confirmations — expire after 5 minutes of no response */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * Store a pending tool confirmation for a chat.
 * Called when executeTool() returns _confirmation_required.
 */
export function setPendingConfirmation(
  chatId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  pendingConfirmations.set(chatId, {
    toolName,
    args,
    chatId,
    createdAt: Date.now(),
  });
}

/**
 * Get a pending confirmation for a chat (if exists and not expired).
 */
export function getPendingConfirmation(chatId: string): PendingConfirmation | null {
  const pending = pendingConfirmations.get(chatId);
  if (!pending) return null;

  if (Date.now() - pending.createdAt > CONFIRMATION_TTL_MS) {
    pendingConfirmations.delete(chatId);
    return null;
  }

  return pending;
}

/**
 * Clear a pending confirmation for a chat.
 */
export function clearPendingConfirmation(chatId: string): void {
  pendingConfirmations.delete(chatId);
}

/**
 * Handle a user's response to a tool confirmation prompt.
 * This is the core state machine:
 * - "once"/"confirm" → execute tool, don't store trust
 * - "always"/"siempre" → store trust + execute tool
 * - "never"/"nunca" → store block, don't execute
 *
 * Returns the tool execution result or a bilingual status message.
 */
export async function handleToolConfirmation(
  chatId: string,
  response: 'once' | 'always' | 'never',
  executeToolFn: (name: string, args: Record<string, unknown>, chatId: string) => Promise<Record<string, unknown>>,
): Promise<{ executed: boolean; result: Record<string, unknown> | null; message: string }> {
  const pending = getPendingConfirmation(chatId);
  if (!pending) {
    return {
      executed: false,
      result: null,
      message: '[EN] No pending tool confirmation found. [ES] No se encontro confirmacion de herramienta pendiente.',
    };
  }

  clearPendingConfirmation(chatId);

  if (response === 'never') {
    setTrustDecision(chatId, pending.toolName, 'block');
    return {
      executed: false,
      result: null,
      message: `[EN] Tool "${pending.toolName}" blocked for your account. Use /trust revoke ${pending.toolName} to unblock.\n`
        + `[ES] Herramienta "${pending.toolName}" bloqueada para tu cuenta. Usa /trust revoke ${pending.toolName} para desbloquear.`,
    };
  }

  if (response === 'always') {
    setTrustDecision(chatId, pending.toolName, 'allow');
    logger.info({ chatId, tool: pending.toolName }, 'User granted permanent trust');
  }

  // Execute the tool (for 'once' and 'always')
  const result = await executeToolFn(pending.toolName, pending.args, chatId);

  const trustMsg = response === 'always'
    ? `[EN] Trust remembered — "${pending.toolName}" will execute without confirmation next time.\n`
      + `[ES] Confianza recordada — "${pending.toolName}" se ejecutara sin confirmacion la proxima vez.`
    : '';

  return {
    executed: true,
    result,
    message: trustMsg,
  };
}

/**
 * Format trust list for display (bilingual).
 */
export function formatTrustList(entries: TrustEntry[]): string {
  if (entries.length === 0) {
    return '[EN] No trust decisions stored. [ES] No hay decisiones de confianza almacenadas.';
  }

  const lines = entries.map((e) => {
    const emoji = e.decision === 'allow' ? '✅' : '🚫';
    const date = new Date(e.trustedAt).toLocaleDateString();
    return `${emoji} **${e.toolName}** — ${e.decision} (${date})`;
  });

  return [
    `[EN] Your tool trust decisions:`,
    ...lines,
    ``,
    `[ES] Tus decisiones de confianza:`,
    ...lines,
  ].join('\n');
}
