import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Reimplemented from src/media.ts to test in isolation

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function guessExtension(contentType: string | null): string {
  if (!contentType) return '';
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return map[contentType.split(';')[0].trim()] || '';
}

function buildPhotoMessage(filePath: string, caption?: string): string {
  const parts = ['[Photo received]'];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please describe or analyze the photo based on the caption.');
  return parts.join('\n');
}

function buildDocumentMessage(filePath: string, filename: string, caption?: string): string {
  const parts = [`[Document received: ${filename}]`];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please analyze the document content.');
  return parts.join('\n');
}

function buildVideoMessage(filePath: string, caption?: string): string {
  const parts = ['[Video received]'];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please analyze the video content.');
  return parts.join('\n');
}

// ── sanitizeFilename ─────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('preserves safe characters', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('file-name_v2.txt')).toBe('file-name_v2.txt');
  });

  it('replaces spaces with underscores', () => {
    expect(sanitizeFilename('my file.txt')).toBe('my_file.txt');
  });

  it('replaces special characters', () => {
    expect(sanitizeFilename('photo (1).jpg')).toBe('photo__1_.jpg');
  });

  it('replaces unicode characters', () => {
    expect(sanitizeFilename('日本語.pdf')).toBe('___.pdf');
  });

  it('handles empty filename', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  it('replaces path traversal characters', () => {
    // Only / is replaced (dots and dashes are safe chars)
    expect(sanitizeFilename('../../../etc/passwd')).toBe('.._.._.._etc_passwd');
  });

  it('handles dots and dashes only', () => {
    expect(sanitizeFilename('...')).toBe('...');
    expect(sanitizeFilename('---')).toBe('---');
  });
});

// ── guessExtension ───────────────────────────────────────────

describe('guessExtension', () => {
  it('returns correct extension for known types', () => {
    expect(guessExtension('image/jpeg')).toBe('.jpg');
    expect(guessExtension('image/png')).toBe('.png');
    expect(guessExtension('audio/ogg')).toBe('.ogg');
    expect(guessExtension('video/mp4')).toBe('.mp4');
    expect(guessExtension('application/pdf')).toBe('.pdf');
    expect(guessExtension('text/plain')).toBe('.txt');
  });

  it('handles content-type with charset parameter', () => {
    expect(guessExtension('text/plain; charset=utf-8')).toBe('.txt');
    expect(guessExtension('image/jpeg; quality=85')).toBe('.jpg');
  });

  it('returns empty string for null', () => {
    expect(guessExtension(null)).toBe('');
  });

  it('returns empty string for unknown types', () => {
    expect(guessExtension('application/octet-stream')).toBe('');
    expect(guessExtension('application/x-custom')).toBe('');
  });
});

// ── buildPhotoMessage ────────────────────────────────────────

describe('buildPhotoMessage', () => {
  it('includes file path', () => {
    const msg = buildPhotoMessage('/path/to/photo.jpg');
    expect(msg).toContain('/path/to/photo.jpg');
    expect(msg).toContain('[Photo received]');
  });

  it('includes caption when provided', () => {
    const msg = buildPhotoMessage('/path/to/photo.jpg', 'My cat');
    expect(msg).toContain('Caption: My cat');
  });

  it('omits caption line when not provided', () => {
    const msg = buildPhotoMessage('/path/to/photo.jpg');
    expect(msg).not.toContain('Caption:');
  });
});

// ── buildDocumentMessage ─────────────────────────────────────

describe('buildDocumentMessage', () => {
  it('includes filename and path', () => {
    const msg = buildDocumentMessage('/path/to/doc.pdf', 'report.pdf');
    expect(msg).toContain('[Document received: report.pdf]');
    expect(msg).toContain('File: /path/to/doc.pdf');
  });

  it('includes caption when provided', () => {
    const msg = buildDocumentMessage('/path/to/doc.pdf', 'report.pdf', 'Q4 report');
    expect(msg).toContain('Caption: Q4 report');
  });
});

// ── buildVideoMessage ────────────────────────────────────────

describe('buildVideoMessage', () => {
  it('includes file path and video tag', () => {
    const msg = buildVideoMessage('/path/to/video.mp4');
    expect(msg).toContain('[Video received]');
    expect(msg).toContain('/path/to/video.mp4');
  });

  it('includes caption when provided', () => {
    const msg = buildVideoMessage('/path/to/video.mp4', 'Tutorial');
    expect(msg).toContain('Caption: Tutorial');
  });
});

// ── cleanupOldUploads logic ──────────────────────────────────

const CLEANUP_DIR = resolve(tmpdir(), 'luna-test-cleanup');

function cleanupOldUploads(uploadsDir: string, maxAgeMs: number): number {
  mkdirSync(uploadsDir, { recursive: true });
  const now = Date.now();
  let deleted = 0;

  try {
    const files = readdirSync(uploadsDir);
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = resolve(uploadsDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(filePath);
          deleted++;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir might not exist */ }

  return deleted;
}

describe('cleanupOldUploads', () => {
  beforeEach(() => {
    try { rmSync(CLEANUP_DIR, { recursive: true }); } catch { /* ignore */ }
    mkdirSync(CLEANUP_DIR, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(CLEANUP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('deletes files older than maxAge', () => {
    const filePath = resolve(CLEANUP_DIR, 'old-file.txt');
    writeFileSync(filePath, 'old');

    // Set file mtime to 2 hours ago using utimesSync
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional CJS require in test
    const { utimesSync } = require('node:fs');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(filePath, twoHoursAgo, twoHoursAgo);

    // maxAge of 1 hour should delete a 2-hour-old file
    const deleted = cleanupOldUploads(CLEANUP_DIR, 3600_000);
    expect(deleted).toBe(1);
  });

  it('preserves recent files', () => {
    const filePath = resolve(CLEANUP_DIR, 'new-file.txt');
    writeFileSync(filePath, 'new');

    // Use maxAge of 1 hour
    const deleted = cleanupOldUploads(CLEANUP_DIR, 3600_000);
    expect(deleted).toBe(0);
  });

  it('preserves .gitkeep', () => {
    writeFileSync(resolve(CLEANUP_DIR, '.gitkeep'), '');
    const deleted = cleanupOldUploads(CLEANUP_DIR, 0);
    expect(deleted).toBe(0);
  });

  it('returns 0 for empty directory', () => {
    const deleted = cleanupOldUploads(CLEANUP_DIR, 0);
    expect(deleted).toBe(0);
  });

  it('handles nonexistent directory gracefully', () => {
    const deleted = cleanupOldUploads('/tmp/nonexistent-luna-dir', 0);
    expect(deleted).toBe(0);
  });
});
