/**
 * Attendance role management (rc.89).
 *
 * The user_roles table was created in rc.88 but never wired into any
 * policy check. This module provides:
 *   - hasRole / requireRole / listRoles helpers for the API layer
 *   - A bootstrap rule: any chat_id listed in ALLOWED_CHAT_ID is
 *     automatically treated as `admin`. That's how the very first admin
 *     gets their role without needing to edit the DB by hand.
 *   - grantRole / revokeRole so an admin can expand the team from the
 *     API or, later, via Telegram commands.
 *
 * Role hierarchy:
 *   admin       → everything (setup CRUD, role management, ingestion)
 *   hr          → ingestion + organisational read, no role management
 *   supervisor  → scoped to their assigned module_id (future phases)
 *   manager     → escalation target (future phases, read-only reports)
 *
 * The helpers are role-specific — there is no "any-role" check. Each
 * API endpoint declares exactly which role(s) it accepts so the trust
 * boundary is visible at every call site.
 */
import { getKnex } from '../db-knex.js';
import { config } from '../config.js';

export type AttendanceRole = 'admin' | 'hr' | 'supervisor' | 'manager';

export interface RoleAssignment {
  chatId: string;
  role: AttendanceRole;
  moduleId: string | null;
  grantedBy: string;
  grantedAt: number;
}

/**
 * Chat IDs that are auto-admin by virtue of being in ALLOWED_CHAT_ID.
 * The env var is comma-separated. Trim and drop blanks.
 */
function bootstrapAdminChatIds(): string[] {
  const raw = config.ALLOWED_CHAT_ID ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isBootstrapAdmin(chatId: string): boolean {
  return bootstrapAdminChatIds().includes(chatId);
}

/**
 * Check if a chat_id holds `role`, either by explicit assignment in
 * user_roles or by bootstrap (admin-only). Returns false when revoked.
 */
export async function hasRole(
  chatId: string,
  role: AttendanceRole,
  moduleId?: string,
): Promise<boolean> {
  if (role === 'admin' && isBootstrapAdmin(chatId)) return true;

  const db = getKnex();
  const query = db('user_roles')
    .where({ chat_id: chatId, role })
    .whereNull('revoked_at');

  if (moduleId) {
    // Either a module-scoped grant for this specific module, or a
    // site-wide grant (module_id NULL).
    query.andWhere(function () {
      this.where({ module_id: moduleId }).orWhereNull('module_id');
    });
  }

  const row = await query.first();
  return Boolean(row);
}

/**
 * Return every role the caller holds (for the UI's "what can I do?"
 * probe). Bootstrap admins get a synthetic entry with grantedBy='bootstrap'.
 */
export async function listRoles(chatId: string): Promise<RoleAssignment[]> {
  const roles: RoleAssignment[] = [];

  if (isBootstrapAdmin(chatId)) {
    roles.push({
      chatId,
      role: 'admin',
      moduleId: null,
      grantedBy: 'bootstrap',
      grantedAt: 0,
    });
  }

  const db = getKnex();
  const rows = await db('user_roles')
    .where({ chat_id: chatId })
    .whereNull('revoked_at') as Array<{
      chat_id: string;
      role: AttendanceRole;
      module_id: string | null;
      granted_by: string;
      granted_at: number;
    }>;

  for (const r of rows) {
    roles.push({
      chatId: r.chat_id,
      role: r.role,
      moduleId: r.module_id,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    });
  }

  return roles;
}

/**
 * Thrown by requireRole; HTTP handlers translate to 403.
 */
export class RoleRequiredError extends Error {
  constructor(
    public readonly role: AttendanceRole,
    public readonly chatId: string,
  ) {
    super(`chat_id=${chatId} lacks required role "${role}"`);
    this.name = 'RoleRequiredError';
  }
}

export async function requireRole(
  chatId: string,
  role: AttendanceRole,
  moduleId?: string,
): Promise<void> {
  const ok = await hasRole(chatId, role, moduleId);
  if (!ok) throw new RoleRequiredError(role, chatId);
}

/**
 * hr, supervisor, and manager roles are all elevated-enough to perform
 * at least some attendance operations. Admin includes all of them.
 * Used by endpoints that accept any attendance-adjacent role.
 */
export async function hasAnyAttendanceRole(chatId: string): Promise<boolean> {
  if (isBootstrapAdmin(chatId)) return true;
  const db = getKnex();
  const row = await db('user_roles')
    .where({ chat_id: chatId })
    .whereIn('role', ['admin', 'hr', 'supervisor', 'manager'])
    .whereNull('revoked_at')
    .first();
  return Boolean(row);
}

// ── Mutations ─────────────────────────────────────────────────

export async function grantRole(params: {
  chatId: string;
  role: AttendanceRole;
  moduleId?: string | null;
  grantedBy: string;
}): Promise<void> {
  const db = getKnex();
  const now = Date.now();
  // If an earlier grant was revoked, re-grant (clear revoked_at + touch grantedAt).
  const existing = await db('user_roles')
    .where({
      chat_id: params.chatId,
      role: params.role,
      module_id: params.moduleId ?? null,
    })
    .first();
  if (existing) {
    await db('user_roles')
      .where({
        chat_id: params.chatId,
        role: params.role,
        module_id: params.moduleId ?? null,
      })
      .update({
        granted_by: params.grantedBy,
        granted_at: now,
        revoked_at: null,
      });
    return;
  }
  await db('user_roles').insert({
    chat_id: params.chatId,
    role: params.role,
    module_id: params.moduleId ?? null,
    granted_by: params.grantedBy,
    granted_at: now,
  });
}

export async function revokeRole(params: {
  chatId: string;
  role: AttendanceRole;
  moduleId?: string | null;
}): Promise<void> {
  const db = getKnex();
  await db('user_roles')
    .where({
      chat_id: params.chatId,
      role: params.role,
      module_id: params.moduleId ?? null,
    })
    .whereNull('revoked_at')
    .update({ revoked_at: Date.now() });
}
