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
 *   clauded.pid     → luna.pid
 *
 * Behavior matrix per file:
 *   legacy-only         → rename, log info
 *   new-only            → no-op silently
 *   neither             → no-op silently
 *   BOTH present        → WARN and keep the new one (do NOT overwrite).
 *                         This happens only if someone manually placed
 *                         files — caller is surprised and we don't want
 *                         to clobber either copy.
 *
 * The function is idempotent: it's safe to run on every boot.
 */
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';

export interface RebrandMigrationResult {
  /** Files that were renamed on this call. */
  renamed: string[];
  /** Files where both legacy and new exist — caller should investigate. */
  conflicts: string[];
  /** Files already on the new name, nothing to do. */
  alreadyNew: string[];
  /** Files that didn't exist under either name. */
  absent: string[];
}

/**
 * Pairs of (legacyName, newName) inside STORE_DIR. Extend here if any
 * future data file needs a similar rename.
 */
const FILE_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['clauded.db', 'luna.db'],
  ['clauded.db-shm', 'luna.db-shm'],
  ['clauded.db-wal', 'luna.db-wal'],
  ['clauded.pid', 'luna.pid'],
];

export function migrateRebrandDataFiles(
  storeDir: string,
  logger?: Pick<Logger, 'info' | 'warn'>,
): RebrandMigrationResult {
  const result: RebrandMigrationResult = {
    renamed: [],
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

  return result;
}
