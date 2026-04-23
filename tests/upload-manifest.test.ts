/**
 * rc.71 — upload manifest + not-found hint.
 *
 * Two small-model anti-hallucination primitives:
 *   - getRecentUploads() / formatUploadManifest(): surface exact
 *     absolute paths in the system prompt so the model never has
 *     to invent a filename.
 *   - buildNotFoundHint(): when a tool call references a missing
 *     path, return the real list so the model can self-correct in
 *     one iteration instead of spiraling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// vi.mock is hoisted above regular consts, so compute paths inside the
// factory (vi.hoisted keeps them available both places).
const { TMP, UPLOADS } = vi.hoisted(() => {
  const { resolve } = require('node:path');
  const { tmpdir } = require('node:os');
  const root = resolve(tmpdir(), `luna-upload-manifest-test-${process.pid}`);
  return { TMP: root, UPLOADS: resolve(root, 'uploads') };
});

vi.mock('../src/config.js', () => ({
  STORE_DIR: TMP,
  PROJECT_ROOT: TMP,
  WORKSPACE_DIR: TMP,
  UPLOADS_DIR: UPLOADS,
  config: {},
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { getRecentUploads, formatUploadManifest, buildNotFoundHint } from '../src/upload-manifest.js';

function touch(path: string, content = '', mtimeMs?: number): void {
  writeFileSync(path, content);
  if (mtimeMs !== undefined) {
    const s = mtimeMs / 1000;
    utimesSync(path, s, s);
  }
}

describe('upload-manifest (rc.71)', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(UPLOADS, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('getRecentUploads', () => {
    it('returns empty when uploads dir is missing', async () => {
      rmSync(UPLOADS, { recursive: true });
      expect(await getRecentUploads()).toEqual([]);
    });

    it('returns empty when uploads dir is empty', async () => {
      expect(await getRecentUploads()).toEqual([]);
    });

    it('orders files by mtime descending and respects the limit', async () => {
      const now = Date.now();
      touch(join(UPLOADS, 'oldest.txt'), 'a', now - 5 * 60_000);
      touch(join(UPLOADS, 'middle.xlsx'), 'b', now - 2 * 60_000);
      touch(join(UPLOADS, 'newest.pdf'), 'c', now - 1 * 60_000);

      const all = await getRecentUploads(10);
      expect(all.map((e) => e.filename)).toEqual(['newest.pdf', 'middle.xlsx', 'oldest.txt']);

      const capped = await getRecentUploads(2);
      expect(capped.map((e) => e.filename)).toEqual(['newest.pdf', 'middle.xlsx']);
    });

    it('filters out dotfiles and non-regular entries', async () => {
      const now = Date.now();
      touch(join(UPLOADS, '.gitkeep'), '', now - 10_000);
      mkdirSync(join(UPLOADS, 'subdir'));
      touch(join(UPLOADS, 'real.txt'), 'x', now - 5_000);

      const entries = await getRecentUploads();
      expect(entries.map((e) => e.filename)).toEqual(['real.txt']);
    });

    it('captures size and lowercase extension', async () => {
      touch(join(UPLOADS, 'Report.XLSX'), 'x'.repeat(2048));
      const [entry] = await getRecentUploads();
      expect(entry.sizeBytes).toBe(2048);
      expect(entry.extension).toBe('.xlsx');
    });
  });

  describe('formatUploadManifest', () => {
    it('returns empty string when there are no uploads (skip prompt concat)', () => {
      expect(formatUploadManifest([])).toBe('');
    });

    it('renders each entry with absolute path, size, age, and includes anti-hallucination guidance', () => {
      const now = Date.now();
      const manifest = formatUploadManifest([
        {
          path: '/app/workspace/uploads/report.xlsx',
          filename: 'report.xlsx',
          sizeBytes: 29 * 1024,
          modifiedAt: now - 10 * 60_000,
          extension: '.xlsx',
        },
      ]);

      expect(manifest).toContain('/app/workspace/uploads/report.xlsx');
      expect(manifest).toContain('29 KB');
      expect(manifest).toMatch(/\d+m ago/);
      expect(manifest).toContain('.xlsx');
      // The anti-hallucination nudge must be present — this is the whole point
      expect(manifest).toMatch(/do NOT invent|EXACT absolute paths/i);
    });
  });

  describe('buildNotFoundHint', () => {
    it('returns an error plus the real uploads list when the path is missing', async () => {
      touch(join(UPLOADS, 'actual.xlsx'));
      touch(join(UPLOADS, 'other.pdf'));

      const hint = await buildNotFoundHint('/app/hallucinated.jpg');

      expect(hint.error).toContain('/app/hallucinated.jpg');
      expect(hint.error).toMatch(/not found|does not exist/i);
      expect(hint.available).toHaveLength(2);
      expect(hint.available.every((p) => p.startsWith(UPLOADS))).toBe(true);
      expect(hint.suggestion).toMatch(/pick one|available/i);
    });

    it('tells the user to upload first when no uploads exist', async () => {
      const hint = await buildNotFoundHint('/app/nothing.xlsx');
      expect(hint.available).toEqual([]);
      expect(hint.suggestion).toMatch(/no files|upload/i);
    });
  });
});
