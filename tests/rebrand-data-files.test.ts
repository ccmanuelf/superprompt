/**
 * rc.85 — rebrand data-file migration.
 *
 * An upgraded instance that was running under the old brand (clauded.db,
 * clauded.pid, ...) must find its data automatically under the new luna.*
 * names. These tests pin the four behaviors:
 *
 *   legacy-only  → renamed
 *   new-only     → no-op
 *   both present → keep new, leave legacy for manual review (conflict)
 *   neither      → no-op
 *
 * No tests exercise content — only the filename-level rename. The
 * contents of clauded.db (SQLite bytes) are opaque to the migration
 * layer, which is what we want: a plain fs.rename preserves everything,
 * including the WAL sidecars.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateRebrandDataFiles } from '../src/migrations/rebrand-data-files.js';

function freshStore(): string {
  return mkdtempSync(join(tmpdir(), 'luna-migration-test-'));
}

// Minimal logger shape — the migration accepts Pick<Logger, 'info' | 'warn'>,
// so a pair of stubs is enough and avoids the pino dependency in tests.
function makeStubLogger() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  return {
    info: (...args: unknown[]) => { info.push(args); },
    warn: (...args: unknown[]) => { warn.push(args); },
    _info: info,
    _warn: warn,
  };
}

describe('migrateRebrandDataFiles', () => {
  let store: string;

  beforeEach(() => {
    store = freshStore();
  });

  it('renames DB files and DELETES legacy PID file (happy path upgrade)', () => {
    writeFileSync(join(store, 'clauded.db'), 'db-bytes');
    writeFileSync(join(store, 'clauded.db-shm'), 'shm-bytes');
    writeFileSync(join(store, 'clauded.db-wal'), 'wal-bytes');
    writeFileSync(join(store, 'clauded.pid'), '12345');

    const log = makeStubLogger();
    const result = migrateRebrandDataFiles(store, log);

    // DB + sidecars carried forward
    expect(result.renamed).toEqual([
      'clauded.db → luna.db',
      'clauded.db-shm → luna.db-shm',
      'clauded.db-wal → luna.db-wal',
    ]);
    // PID deleted — carrying a stale container-PID into acquireLock caused
    // a false "another instance is running" trip in the rc.85 rollout.
    expect(result.deleted).toEqual(['clauded.pid']);
    expect(result.conflicts).toEqual([]);

    // Legacy paths gone, new paths present with original bytes, no new luna.pid
    expect(existsSync(join(store, 'clauded.db'))).toBe(false);
    expect(existsSync(join(store, 'clauded.pid'))).toBe(false);
    expect(existsSync(join(store, 'luna.pid'))).toBe(false);
    expect(readFileSync(join(store, 'luna.db'), 'utf8')).toBe('db-bytes');
    expect(readFileSync(join(store, 'luna.db-shm'), 'utf8')).toBe('shm-bytes');
    expect(readFileSync(join(store, 'luna.db-wal'), 'utf8')).toBe('wal-bytes');

    // 3 renames + 1 delete = 4 info logs
    expect(log._info.length).toBe(4);
    expect(log._warn.length).toBe(0);

    rmSync(store, { recursive: true, force: true });
  });

  it('is a no-op when only the new filename exists (already migrated boot)', () => {
    writeFileSync(join(store, 'luna.db'), 'db-bytes');

    const log = makeStubLogger();
    const result = migrateRebrandDataFiles(store, log);

    expect(result.renamed).toEqual([]);
    expect(result.alreadyNew).toContain('luna.db');
    expect(readFileSync(join(store, 'luna.db'), 'utf8')).toBe('db-bytes');
    expect(log._info.length).toBe(0);
    expect(log._warn.length).toBe(0);

    rmSync(store, { recursive: true, force: true });
  });

  it('is a no-op when neither name exists (fresh install)', () => {
    const log = makeStubLogger();
    const result = migrateRebrandDataFiles(store, log);
    expect(result.renamed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.absent.length).toBeGreaterThan(0);

    rmSync(store, { recursive: true, force: true });
  });

  it('leaves BOTH files untouched and warns when both legacy and new are present', () => {
    writeFileSync(join(store, 'clauded.db'), 'OLD');
    writeFileSync(join(store, 'luna.db'), 'NEW');

    const log = makeStubLogger();
    const result = migrateRebrandDataFiles(store, log);

    // Neither renamed nor removed — operator must decide
    expect(result.conflicts).toContain('clauded.db');
    expect(result.renamed).toEqual([]);
    expect(readFileSync(join(store, 'clauded.db'), 'utf8')).toBe('OLD');
    expect(readFileSync(join(store, 'luna.db'), 'utf8')).toBe('NEW');
    expect(log._warn.length).toBe(1);

    rmSync(store, { recursive: true, force: true });
  });

  it('deletes legacy clauded.pid even when DB is already migrated', () => {
    writeFileSync(join(store, 'luna.db'), 'db-bytes');
    writeFileSync(join(store, 'clauded.pid'), '999');

    const log = makeStubLogger();
    const result = migrateRebrandDataFiles(store, log);

    expect(result.renamed).toEqual([]);
    expect(result.deleted).toEqual(['clauded.pid']);
    expect(result.alreadyNew).toContain('luna.db');
    expect(existsSync(join(store, 'clauded.pid'))).toBe(false);
    expect(existsSync(join(store, 'luna.pid'))).toBe(false);
    expect(readFileSync(join(store, 'luna.db'), 'utf8')).toBe('db-bytes');

    rmSync(store, { recursive: true, force: true });
  });

  it('is idempotent — running twice in a row changes nothing the second time', () => {
    writeFileSync(join(store, 'clauded.db'), 'bytes');

    const log1 = makeStubLogger();
    migrateRebrandDataFiles(store, log1);
    const log2 = makeStubLogger();
    const result2 = migrateRebrandDataFiles(store, log2);

    expect(result2.renamed).toEqual([]);
    expect(result2.alreadyNew).toContain('luna.db');
    expect(log2._info.length).toBe(0);

    rmSync(store, { recursive: true, force: true });
  });

  it('does not require a logger (safe when called without one)', () => {
    writeFileSync(join(store, 'clauded.db'), 'bytes');
    expect(() => migrateRebrandDataFiles(store)).not.toThrow();
    expect(existsSync(join(store, 'luna.db'))).toBe(true);
    rmSync(store, { recursive: true, force: true });
  });
});
