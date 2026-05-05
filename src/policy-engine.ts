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

import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { ToolPolicy, PolicyDecision, ToolEntry } from './core/interfaces.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Table Initialization ─────────────────────────────────────

export async function initPolicyTables(): Promise<void> {
  const db = getKnex();
  const exists = await db.schema.hasTable('tool_trust');
  if (!exists) {
    await db.schema.createTable('tool_trust', (t) => {
      t.text('chat_id').notNullable();
      t.text('tool_name').notNullable();
      t.text('decision').notNullable();
      t.integer('trusted_at').notNullable();
      t.integer('expires_at');
      t.primary(['chat_id', 'tool_name']);
    });
  }
}

export const policyTableInit: TableInitializer = {
  name: 'policy-engine',
  initTables: initPolicyTables,
};

// ── Trust Memory ─────────────────────────────────────────────

/** TTL applied when a user accepts an "always" tool confirmation. */
export const TRUST_ALWAYS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TrustDecision = 'allow' | 'block';

export interface TrustEntry {
  chatId: string;
  toolName: string;
  decision: TrustDecision;
  trustedAt: number;
  expiresAt: number | null;
}

export async function getTrustDecision(chatId: string, toolName: string): Promise<TrustDecision | null> {
  const db = getKnex();
  const row = await db('tool_trust')
    .where({ chat_id: chatId, tool_name: toolName })
    .select('decision', 'expires_at')
    .first() as { decision: string; expires_at: number | null } | undefined;

  if (!row) return null;

  // Check expiration
  if (row.expires_at && row.expires_at < Date.now()) {
    await db('tool_trust').where({ chat_id: chatId, tool_name: toolName }).del();
    return null;
  }

  return row.decision as TrustDecision;
}

export async function setTrustDecision(
  chatId: string,
  toolName: string,
  decision: TrustDecision,
  expiresAt?: number | null,
): Promise<void> {
  const db = getKnex();
  await db('tool_trust')
    .insert({
      chat_id: chatId,
      tool_name: toolName,
      decision,
      trusted_at: Date.now(),
      expires_at: expiresAt ?? null,
    })
    .onConflict(['chat_id', 'tool_name'])
    .merge({
      decision,
      trusted_at: Date.now(),
      expires_at: expiresAt ?? null,
    });
}

export async function revokeTrust(chatId: string, toolName: string): Promise<boolean> {
  const db = getKnex();
  const count = await db('tool_trust').where({ chat_id: chatId, tool_name: toolName }).del();
  return count > 0;
}

export async function clearAllTrust(chatId: string): Promise<number> {
  const db = getKnex();
  return db('tool_trust').where('chat_id', chatId).del();
}

export async function listTrustEntries(chatId: string): Promise<TrustEntry[]> {
  const db = getKnex();
  const rows = await db('tool_trust')
    .where('chat_id', chatId)
    .select('chat_id', 'tool_name', 'decision', 'trusted_at', 'expires_at') as Array<{ chat_id: string; tool_name: string; decision: string; trusted_at: number; expires_at: number | null }>;

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
export async function evaluatePolicy(toolName: string, chatId: string): Promise<PolicyDecision> {
  // 1. Check trust memory first
  try {
    const trust = await getTrustDecision(chatId, toolName);

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

  // High: allowed, logged. Optionally requires confirmation for specific tools
  // via POLICY_CONFIRM_HIGH_RISK env var (comma-separated tool names).
  // CTO feedback (rc.29): "for stricter environments you might want optional
  // confirmation or narrower gating for some high-risk but non-critical tools."
  if (policy.riskLevel === 'high') {
    const confirmHighRisk = getHighRiskConfirmationList();
    if (confirmHighRisk.has(toolName)) {
      return {
        allowed: true,
        requiresConfirmation: true,
        confirmationPrompt: buildConfirmationPrompt(toolName),
      };
    }
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

/** Cache for POLICY_CONFIRM_HIGH_RISK env var parsing */
let _highRiskConfirmCache: Set<string> | null = null;

function getHighRiskConfirmationList(): Set<string> {
  if (_highRiskConfirmCache) return _highRiskConfirmCache;
  const envVal = process.env.POLICY_CONFIRM_HIGH_RISK || '';
  _highRiskConfirmCache = new Set(
    envVal.split(',').map((s) => s.trim()).filter(Boolean),
  );
  return _highRiskConfirmCache;
}

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
    await setTrustDecision(chatId, pending.toolName, 'block');
    return {
      executed: false,
      result: null,
      message: `[EN] Tool "${pending.toolName}" blocked for your account. Use /trust revoke ${pending.toolName} to unblock.\n`
        + `[ES] Herramienta "${pending.toolName}" bloqueada para tu cuenta. Usa /trust revoke ${pending.toolName} para desbloquear.`,
    };
  }

  if (response === 'always') {
    // 30-day TTL on "always" decisions. A permanent allow lets a single moment
    // of trust persist forever; rotating the decision keeps the user in the loop.
    const expiresAt = Date.now() + TRUST_ALWAYS_TTL_MS;
    await setTrustDecision(chatId, pending.toolName, 'allow', expiresAt);
    logger.info(
      { chatId, tool: pending.toolName, expiresAt },
      'User granted trust (30-day TTL)',
    );
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
