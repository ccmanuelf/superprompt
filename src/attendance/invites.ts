/**
 * Supervisor invitation flow (rc.90).
 *
 * The critical missing piece before Phase B can ship: a real supervisor
 * needs their Telegram chat_id linked to their module so the bot can
 * send exception lists. Self-declaration would be insecure (any Telegram
 * user could claim any module); manual `chat_id` entry requires the
 * admin to know the supervisor's numeric ID in advance. The invitation
 * flow resolves both:
 *
 *   1. Admin clicks "Invite supervisor" for a module in the admin UI.
 *      The server generates a short token, stores it with an expiry
 *      (default 24h), returns it.
 *   2. Admin shares the token with the supervisor out-of-band (verbal,
 *      WhatsApp, whatever's convenient).
 *   3. Supervisor sends `/attendance claim <token>` to the Telegram bot.
 *      The bot validates the token is unredeemed + not expired,
 *      populates `attendance_modules.supervisor_chat_id`, grants the
 *      `supervisor` role scoped to the module, marks the token redeemed.
 *
 * Tokens are one-shot. A supervisor who changes phones needs a fresh
 * invite. Admins can revoke an unredeemed token if something goes wrong.
 */
import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import { grantRole } from './roles.js';
import { logger } from '../logger.js';

export interface SupervisorInvite {
  token: string;
  moduleId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  redeemedByChatId: string | null;
  revokedAt: number | null;
}

/** Default token lifetime. Invitations exchanged in person rarely need longer. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 12-byte hex = 24 chars. Long enough to resist guessing, short enough to paste in Telegram. */
function newToken(): string {
  return randomBytes(12).toString('hex');
}

export async function createSupervisorInvite(params: {
  moduleId: string;
  createdBy: string;
  ttlMs?: number;
}): Promise<SupervisorInvite> {
  if (!params.moduleId) throw new Error('moduleId is required');
  const db = getKnex();
  const mod = await db('attendance_modules').where({ id: params.moduleId }).first();
  if (!mod) throw new Error(`module ${params.moduleId} does not exist`);

  const token = newToken();
  const now = Date.now();
  const ttl = Math.max(60_000, params.ttlMs ?? DEFAULT_TTL_MS);
  const expiresAt = now + ttl;

  await db('attendance_supervisor_invites').insert({
    token,
    module_id: params.moduleId,
    created_by: params.createdBy,
    created_at: now,
    expires_at: expiresAt,
  });

  logger.info(
    { moduleId: params.moduleId, createdBy: params.createdBy, expiresAt },
    'Attendance: supervisor invite created',
  );

  return {
    token,
    moduleId: params.moduleId,
    createdBy: params.createdBy,
    createdAt: now,
    expiresAt,
    redeemedAt: null,
    redeemedByChatId: null,
    revokedAt: null,
  };
}

export async function listSupervisorInvites(moduleId?: string): Promise<SupervisorInvite[]> {
  const db = getKnex();
  const q = db('attendance_supervisor_invites').orderBy('created_at', 'desc');
  if (moduleId) q.where({ module_id: moduleId });
  const rows = await q as Array<{
    token: string; module_id: string; created_by: string;
    created_at: number; expires_at: number;
    redeemed_at: number | null; redeemed_by_chat_id: string | null;
    revoked_at: number | null;
  }>;
  return rows.map((r) => ({
    token: r.token,
    moduleId: r.module_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedAt: r.redeemed_at,
    redeemedByChatId: r.redeemed_by_chat_id,
    revokedAt: r.revoked_at,
  }));
}

export async function revokeSupervisorInvite(token: string): Promise<boolean> {
  const db = getKnex();
  const n = await db('attendance_supervisor_invites')
    .where({ token })
    .whereNull('redeemed_at')
    .whereNull('revoked_at')
    .update({ revoked_at: Date.now() });
  return n > 0;
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  moduleId?: string;
  moduleName?: string;
}

/**
 * Validate + redeem an invite token. All-or-nothing: the supervisor_chat_id
 * update, the role grant, and the redemption stamp are wrapped in one
 * transaction so a partial claim can't leave the system in a weird state.
 */
export async function claimSupervisorInvite(
  token: string,
  claimantChatId: string,
): Promise<ClaimResult> {
  if (!token || !claimantChatId) {
    return { ok: false, error: 'token and chat_id are required' };
  }
  const db = getKnex();

  return db.transaction(async (trx) => {
    const invite = await trx('attendance_supervisor_invites')
      .where({ token })
      .first() as {
        token: string; module_id: string; expires_at: number;
        redeemed_at: number | null; revoked_at: number | null;
      } | undefined;

    if (!invite) return { ok: false, error: 'token not found' };
    if (invite.revoked_at) return { ok: false, error: 'invitation was revoked — ask your admin for a new one' };
    if (invite.redeemed_at) return { ok: false, error: 'invitation already redeemed' };
    if (Date.now() > invite.expires_at) return { ok: false, error: 'invitation expired — ask your admin for a new one' };

    const mod = await trx('attendance_modules').where({ id: invite.module_id }).first() as
      { id: string; name: string } | undefined;
    if (!mod) return { ok: false, error: 'module no longer exists' };

    // Update the module record. If a prior supervisor already registered,
    // we overwrite — the invite flow is the authoritative mechanism for
    // rotating supervisor ownership.
    await trx('attendance_modules')
      .where({ id: invite.module_id })
      .update({
        supervisor_chat_id: claimantChatId,
        updated_at: Date.now(),
      });

    // Mark invitation redeemed.
    await trx('attendance_supervisor_invites')
      .where({ token })
      .update({
        redeemed_at: Date.now(),
        redeemed_by_chat_id: claimantChatId,
      });

    // Re-using grantRole's own transaction would deadlock — instead do
    // the upsert here inline against the outer trx.
    const existingRole = await trx('user_roles')
      .where({
        chat_id: claimantChatId,
        role: 'supervisor',
        module_id: invite.module_id,
      })
      .first();
    if (existingRole) {
      await trx('user_roles')
        .where({
          chat_id: claimantChatId,
          role: 'supervisor',
          module_id: invite.module_id,
        })
        .update({ granted_at: Date.now(), granted_by: 'invite', revoked_at: null });
    } else {
      await trx('user_roles').insert({
        chat_id: claimantChatId,
        role: 'supervisor',
        module_id: invite.module_id,
        granted_by: 'invite',
        granted_at: Date.now(),
      });
    }

    logger.info(
      { moduleId: invite.module_id, claimantChatId },
      'Attendance: supervisor invite redeemed',
    );

    return { ok: true, moduleId: invite.module_id, moduleName: mod.name };
  });
}
// Silence unused-import warning when tests don't touch grantRole directly.
void grantRole;
