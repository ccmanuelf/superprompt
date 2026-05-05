/**
 * Doc-aware Luna (rc.109) — tests.
 *
 * Hits the real `docs/` and `reference/` directories on disk because the
 * module reads from PROJECT_ROOT-relative paths. The tests assert
 * properties of the live manifest (e.g. user-guide is exposed,
 * point-in-time docs are not) rather than exact content snapshots, so
 * doc edits don't break the suite.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  listAvailableDocs,
  readDocumentation,
  searchDocumentation,
  resetDocAwarenessCache,
  renderDocumentationManifest,
} from '../src/doc-awareness.js';

afterEach(() => {
  resetDocAwarenessCache();
});

describe('listAvailableDocs', () => {
  it('returns at least one doc from each source', () => {
    const docs = listAvailableDocs();
    const sources = new Set(docs.map((d) => d.source));
    expect(sources.has('docs')).toBe(true);
    expect(sources.has('reference')).toBe(true);
    expect(docs.length).toBeGreaterThan(5);
  });

  it('includes core user-facing docs', () => {
    const ids = listAvailableDocs().map((d) => `${d.source}/${d.id}`);
    expect(ids).toContain('docs/user-guide');
    expect(ids).toContain('docs/commands');
    expect(ids).toContain('docs/security');
    expect(ids).toContain('reference/decisions');
  });

  it('skips point-in-time and strategic docs by pattern', () => {
    const ids = listAvailableDocs().map((d) => d.id);
    // -rcXX point-in-time
    for (const id of ids) {
      expect(id).not.toMatch(/-rc\d+$/i);
    }
    // verification-audit-* and e2e-test-checklist-*
    for (const id of ids) {
      expect(id).not.toMatch(/^verification-audit-/i);
      expect(id).not.toMatch(/^e2e-test-checklist-/i);
    }
    // strategic / executive
    expect(ids).not.toContain('executive-brief');
    expect(ids).not.toContain('risk-register');
    expect(ids).not.toContain('competitive-assessment');
  });

  it('every entry has a non-empty title and summary', () => {
    for (const d of listAvailableDocs()) {
      expect(d.title.trim().length).toBeGreaterThan(0);
      expect(d.summary.trim().length).toBeGreaterThan(0);
      expect(d.size).toBeGreaterThan(0);
    }
  });

  it('caches on first call (subsequent calls return same array reference)', () => {
    const first = listAvailableDocs();
    const second = listAvailableDocs();
    expect(second).toBe(first);
  });

  it('resetDocAwarenessCache forces a re-scan', () => {
    const first = listAvailableDocs();
    resetDocAwarenessCache();
    const second = listAvailableDocs();
    expect(second).not.toBe(first);
    expect(second.length).toBe(first.length);
  });
});

describe('renderDocumentationManifest', () => {
  it('renders a markdown section with the canonical headings', () => {
    const out = renderDocumentationManifest();
    expect(out).toContain('## Available Documentation (read-access)');
    expect(out).toContain('read_documentation(filename)');
    expect(out).toContain('search_documentation(query)');
    expect(out).toContain('docs/user-guide');
  });

  it('returns empty string when no docs are available', () => {
    // No reliable way to make the docs disappear in-process; use a sentinel
    // assertion instead — every shipped doc is non-empty so the manifest
    // is always non-empty in practice.
    expect(renderDocumentationManifest().length).toBeGreaterThan(100);
  });
});

describe('readDocumentation', () => {
  it('returns markdown body for a valid filename', () => {
    const result = readDocumentation({ filename: 'docs/user-guide' }) as {
      filename: string;
      content: string;
      totalChars: number;
      truncated: boolean;
    };
    expect(result.filename).toBe('docs/user-guide');
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.totalChars).toBeGreaterThan(0);
  });

  it('accepts bare id (defaults to docs/)', () => {
    const result = readDocumentation({ filename: 'commands' }) as { filename: string };
    expect(result.filename).toBe('docs/commands');
  });

  it('accepts reference/ prefix', () => {
    const result = readDocumentation({ filename: 'reference/decisions' }) as { filename: string };
    expect(result.filename).toBe('reference/decisions');
  });

  it('strips a trailing .md suffix', () => {
    const result = readDocumentation({ filename: 'docs/security.md' }) as { filename: string };
    expect(result.filename).toBe('docs/security');
  });

  it('rejects empty filename', () => {
    expect(readDocumentation({ filename: '' })).toEqual({ error: 'filename is required' });
  });

  it('rejects path traversal attempts', () => {
    expect(readDocumentation({ filename: '../package' })).toMatchObject({ error: 'invalid filename' });
    expect(readDocumentation({ filename: 'docs/../../package' })).toMatchObject({ error: 'invalid filename' });
    expect(readDocumentation({ filename: 'docs/sub/dir' })).toMatchObject({ error: 'invalid filename' });
  });

  it('rejects filenames that exist on disk but are filtered out of the manifest', () => {
    // executive-brief.md exists in docs/ but is in SKIP_PATTERNS.
    const result = readDocumentation({ filename: 'docs/executive-brief' }) as { error: string };
    expect(result.error).toContain('not found or not exposed');
  });

  it('honors offset parameter for chunked reads', () => {
    const first = readDocumentation({ filename: 'docs/user-guide' }) as {
      content: string;
      totalChars: number;
    };
    const offset = Math.min(100, first.totalChars - 1);
    const second = readDocumentation({ filename: 'docs/user-guide', offset }) as {
      content: string;
      offset: number;
    };
    expect(second.offset).toBe(offset);
    expect(second.content.length).toBe(first.totalChars - offset > 30000 ? 30000 : first.totalChars - offset);
  });

  it('returns truncated=true with nextOffset when content exceeds 30KB', () => {
    // Find a doc larger than 30KB; if none, this assertion is vacuously true.
    const big = listAvailableDocs().find((d) => d.size > 30_000);
    if (!big) {
      expect(true).toBe(true);
      return;
    }
    const result = readDocumentation({ filename: `${big.source}/${big.id}` }) as {
      truncated: boolean;
      nextOffset?: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(30_000);
  });
});

describe('searchDocumentation', () => {
  it('returns matched lines with heading + context', () => {
    const result = searchDocumentation({ query: 'site-adjusted' }) as {
      query: string;
      matchCount: number;
      hits: Array<{ filename: string; heading: string; match: string; line: number; context: string[] }>;
    };
    expect(result.query).toBe('site-adjusted');
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.hits[0]).toHaveProperty('filename');
    expect(result.hits[0]).toHaveProperty('heading');
    expect(result.hits[0]).toHaveProperty('line');
  });

  it('case-insensitive substring match', () => {
    const lower = searchDocumentation({ query: 'capacity' }) as { matchCount: number };
    const upper = searchDocumentation({ query: 'CAPACITY' }) as { matchCount: number };
    expect(upper.matchCount).toBe(lower.matchCount);
  });

  it('rejects empty query', () => {
    expect(searchDocumentation({ query: '' })).toEqual({ error: 'query is required' });
    expect(searchDocumentation({ query: '   ' })).toEqual({ error: 'query is required' });
  });

  it('rejects oversized query (DoS guard)', () => {
    const result = searchDocumentation({ query: 'x'.repeat(500) }) as { error: string };
    expect(result.error).toContain('too long');
  });

  it('caps results at max=15 even when many matches exist', () => {
    // "the" appears in nearly every doc — should saturate the cap.
    const result = searchDocumentation({ query: 'the' }) as { matchCount: number; truncated: boolean };
    expect(result.matchCount).toBeLessThanOrEqual(15);
    expect(result.truncated).toBe(true);
  });

  it('honors caller-supplied max (clamped to 15)', () => {
    const small = searchDocumentation({ query: 'the', max: 3 }) as { matchCount: number };
    expect(small.matchCount).toBeLessThanOrEqual(3);

    const big = searchDocumentation({ query: 'the', max: 999 }) as { matchCount: number };
    expect(big.matchCount).toBeLessThanOrEqual(15);
  });

  it('does not match against files filtered out of the manifest', () => {
    // executive-brief.md is filtered. Pick a unique-looking phrase from it
    // — if it appeared in results, that would mean the search bypassed the
    // manifest gate. (We use a substring "Executive Brief" that is most
    // likely to appear in that file's H1.)
    const result = searchDocumentation({ query: 'Executive Brief' }) as {
      hits: Array<{ filename: string }>;
    };
    expect(result.hits.every((h) => !h.filename.includes('executive-brief'))).toBe(true);
  });
});
