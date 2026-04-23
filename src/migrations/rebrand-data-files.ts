/**
 * One-time migration (rc.85): rename legacy `clauded.*` runtime data
 * files to their `luna.*` successors.
 *
 * Runs on startup BEFORE the DB is opened or the PID lock is written, so
 * existing instances that stop/upgrade in place find their data under the
 * new filename without any manual ops.
 *
 * Covered files (all inside STORE_DIR):
 *   clauded.db      → luna.db
 *   clauded.db-shm  → luna.db-shm       (SQLite WAL sidecar)
 *   clauded.db-wal  → luna.db-wal       (SQLite WAL log)
 *
 * NOT renamed — deleted:
 *   clauded.pid
 *
 * Rationale for deleting PID files instead of renaming: PIDs from the
 * previous container instance are meaningless (often PID 1 under Docker)
 * and carrying them into acquireLock causes a false "another instance is
 * running" trip when the new process happens to share the recorded PID
 * (observed in the rc.85 rollout). PID files are boot-time state; the
 * next startup reissues them.
 *
 * Behavior matrix per renameable file:
 *   legacy-only         → rename, log info
 *   new-only            → no-op silently
 *   neither             → no-op silently
 *   BOTH present        → WARN and keep the new one (do NOT overwrite).
 *                         This happens only if someone manually placed
 *                         files — caller is surprised and we don't want
 *                         to clobber either copy.
 *
 * Behavior for deleteable files (clauded.pid):
 *   exists              → unlink, log info
 *   absent              → no-op silently
 *
 * The function is idempotent: it's safe to run on every boot.
 */
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';

export interface RebrandMigrationResult {
  /** Files that were renamed on this call. */
  renamed: string[];
  /** Legacy files that were deleted on this call (PID files). */
  deleted: string[];
  /** Files where both legacy and new exist — caller should investigate. */
  conflicts: string[];
  /** Files already on the new name, nothing to do. */
  alreadyNew: string[];
  /** Files that didn't exist under either name. */
  absent: string[];
}

/**
 * Pairs of (legacyName, newName) inside STORE_DIR for files whose
 * contents carry forward and need renaming. Extend here if any future
 * data file needs a similar rename.
 */
const FILE_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['clauded.db', 'luna.db'],
  ['clauded.db-shm', 'luna.db-shm'],
  ['clauded.db-wal', 'luna.db-wal'],
];

/**
 * Legacy files that should be DELETED on sight, not renamed — their
 * contents are stale the moment the container is recreated.
 */
const FILES_TO_DELETE: ReadonlyArray<string> = [
  'clauded.pid',
];

export function migrateRebrandDataFiles(
  storeDir: string,
  logger?: Pick<Logger, 'info' | 'warn'>,
): RebrandMigrationResult {
  const result: RebrandMigrationResult = {
    renamed: [],
    deleted: [],
    conflicts: [],
    alreadyNew: [],
    absent: [],
  };

  for (const [legacyName, newName] of FILE_RENAMES) {
    const legacyPath = resolve(storeDir, legacyName);
    const newPath = resolve(storeDir, newName);

    const legacyExists = existsSync(legacyPath);
    const newExists = existsSync(newPath);

    if (!legacyExists && !newExists) {
      result.absent.push(legacyName);
      continue;
    }

    if (!legacyExists && newExists) {
      result.alreadyNew.push(newName);
      continue;
    }

    if (legacyExists && newExists) {
      result.conflicts.push(legacyName);
      logger?.warn(
        { legacyPath, newPath },
        `Rebrand migration: both ${legacyName} and ${newName} exist — keeping new, leaving legacy untouched for manual review`,
      );
      continue;
    }

    // legacyExists && !newExists — perform the rename
    renameSync(legacyPath, newPath);
    result.renamed.push(`${legacyName} → ${newName}`);
    logger?.info(
      { from: legacyPath, to: newPath },
      `Rebrand migration: renamed ${legacyName} → ${newName}`,
    );
  }

  // Delete legacy files whose contents don't carry forward (PID files
  // are boot-time state; rc.85 observed a false "another instance is
  // running" trip from carrying an old PID 1 into acquireLock).
  for (const name of FILES_TO_DELETE) {
    const path = resolve(storeDir, name);
    if (existsSync(path)) {
      unlinkSync(path);
      result.deleted.push(name);
      logger?.info({ path }, `Rebrand migration: deleted legacy ${name} (PID files don't migrate)`);
    } else {
      result.absent.push(name);
    }
  }

  return result;
}
