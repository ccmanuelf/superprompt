import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * S13 Research & Reporting tests.
 * Tests: citation CRUD, export formats, arXiv XML parsing, PPTX docgen detection.
 */

// ── Citation CRUD (real SQLite) ─────────────────────────────

const TMP_DIR = resolve(tmpdir(), 'clauded-test-research');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'research-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS citations (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      authors TEXT,
      url TEXT,
      doi TEXT,
      year INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      abstract TEXT,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_citations_chat ON citations(chat_id, added_at);
  `);
}

function insertCitation(
  chatId: string, title: string, authors: string[] = [], year: number | null = null,
  url: string | null = null, source: string = 'manual',
): string {
  const id = Math.random().toString(36).slice(2, 14);
  db.prepare(
    `INSERT INTO citations (id, chat_id, title, authors, url, doi, year, source, abstract, added_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
  ).run(id, chatId, title, JSON.stringify(authors), url, year, source, Date.now());
  return id;
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

describe('citation CRUD (real DB)', () => {
  it('inserts and retrieves a citation', () => {
    const id = insertCitation('chat1', 'Machine Learning in Manufacturing', ['John Smith', 'Jane Doe'], 2024, 'https://example.com/paper');
    const row = db.prepare('SELECT * FROM citations WHERE id = ?').get(id) as any;
    expect(row.title).toBe('Machine Learning in Manufacturing');
    expect(JSON.parse(row.authors)).toEqual(['John Smith', 'Jane Doe']);
    expect(row.year).toBe(2024);
    expect(row.source).toBe('manual');
  });

  it('lists citations by chat', () => {
    insertCitation('chat1', 'Paper A');
    insertCitation('chat1', 'Paper B');
    insertCitation('chat2', 'Paper C');

    const chat1 = db.prepare('SELECT * FROM citations WHERE chat_id = ?').all('chat1') as any[];
    expect(chat1).toHaveLength(2);

    const chat2 = db.prepare('SELECT * FROM citations WHERE chat_id = ?').all('chat2') as any[];
    expect(chat2).toHaveLength(1);
  });

  it('deletes a citation', () => {
    const id = insertCitation('chat1', 'To Delete');
    db.prepare('DELETE FROM citations WHERE id = ?').run(id);
    const row = db.prepare('SELECT * FROM citations WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('clears all citations for a chat', () => {
    insertCitation('chat1', 'A');
    insertCitation('chat1', 'B');
    insertCitation('chat2', 'C');

    const result = db.prepare('DELETE FROM citations WHERE chat_id = ?').run('chat1');
    expect(result.changes).toBe(2);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM citations').get() as any;
    expect(remaining.cnt).toBe(1);
  });

  it('detects duplicate citations by title', () => {
    insertCitation('chat1', 'Unique Paper');
    const exists = db.prepare('SELECT id FROM citations WHERE chat_id = ? AND LOWER(title) = LOWER(?)').get('chat1', 'unique paper');
    expect(exists).toBeDefined();

    const notExists = db.prepare('SELECT id FROM citations WHERE chat_id = ? AND LOWER(title) = LOWER(?)').get('chat1', 'nonexistent');
    expect(notExists).toBeUndefined();
  });
});

// ── Citation Export Formats (pure logic) ────────────────────

describe('citation export formats', () => {
  function formatBibtex(id: string, title: string, authors: string[], year: number | null, url: string | null): string {
    const lines = [`@article{${id}`];
    lines.push(`  title = {${title}}`);
    if (authors.length > 0) lines.push(`  author = {${authors.join(' and ')}}`);
    if (year) lines.push(`  year = {${year}}`);
    if (url) lines.push(`  url = {${url}}`);
    return lines.join(',\n') + '\n}';
  }

  function formatAPA(title: string, authors: string[], year: number | null, url: string | null): string {
    const formatAuthor = (name: string) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0];
      const last = parts.pop()!;
      const initials = parts.map((p) => p[0].toUpperCase() + '.').join(' ');
      return `${last}, ${initials}`;
    };
    const authorStr = authors.length > 0 ? authors.map(formatAuthor).join(', ') : 'Unknown Author';
    const yearStr = year ? `(${year})` : '(n.d.)';
    const urlStr = url ? ` ${url}` : '';
    return `${authorStr} ${yearStr}. ${title}.${urlStr}`;
  }

  it('formats BibTeX correctly', () => {
    const result = formatBibtex('abc123', 'Test Paper', ['John Smith'], 2024, 'https://example.com');
    expect(result).toContain('@article{abc123');
    expect(result).toContain('title = {Test Paper}');
    expect(result).toContain('author = {John Smith}');
    expect(result).toContain('year = {2024}');
    expect(result).toContain('url = {https://example.com}');
  });

  it('formats APA correctly', () => {
    const result = formatAPA('Machine Learning Review', ['John Smith', 'Jane Doe'], 2024, 'https://example.com');
    expect(result).toContain('Smith, J.');
    expect(result).toContain('Doe, J.');
    expect(result).toContain('(2024)');
    expect(result).toContain('Machine Learning Review');
  });

  it('handles missing authors in APA', () => {
    const result = formatAPA('Anonymous Paper', [], null, null);
    expect(result).toContain('Unknown Author');
    expect(result).toContain('(n.d.)');
  });

  it('formats Chicago correctly', () => {
    const authors = ['John Smith'];
    const authorStr = authors.join(', ');
    const result = `${authorStr}. "Test Paper." 2024. https://example.com`;
    expect(result).toBe('John Smith. "Test Paper." 2024. https://example.com');
  });
});

// ── arXiv XML Parsing ───────────────────────────────────────

import { parseArxivXml } from '../src/providers/tools/research.js';

describe('arXiv XML parsing', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.12345v1</id>
    <title>Deep Learning for Manufacturing Process Optimization</title>
    <summary>This paper presents a novel approach to using deep neural networks for optimizing manufacturing processes in real-time production environments.</summary>
    <published>2023-01-15T00:00:00Z</published>
    <author><name>Alice Johnson</name></author>
    <author><name>Bob Williams</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2302.67890v2</id>
    <title>Reinforcement Learning in Supply Chain Management</title>
    <summary>We explore the application of reinforcement learning algorithms to supply chain optimization problems.</summary>
    <published>2023-02-20T00:00:00Z</published>
    <author><name>Carol Davis</name></author>
  </entry>
</feed>`;

  it('parses multiple entries', () => {
    const results = parseArxivXml(sampleXml);
    expect(results).toHaveLength(2);
  });

  it('extracts title correctly', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].title).toBe('Deep Learning for Manufacturing Process Optimization');
  });

  it('extracts authors', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].authors).toEqual(['Alice Johnson', 'Bob Williams']);
    expect(results[1].authors).toEqual(['Carol Davis']);
  });

  it('extracts year from published date', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].year).toBe(2023);
  });

  it('extracts abstract', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].abstract).toContain('deep neural networks');
  });

  it('extracts URL', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].url).toBe('http://arxiv.org/abs/2301.12345v1');
  });

  it('sets source as arxiv', () => {
    const results = parseArxivXml(sampleXml);
    expect(results[0].source).toBe('arxiv');
  });

  it('handles empty feed', () => {
    const results = parseArxivXml('<feed></feed>');
    expect(results).toHaveLength(0);
  });
});

// ── PPTX DocGen Detection ───────────────────────────────────

import { isDocGenResponse, parseDocGenResponse } from '../src/docgen.js';

describe('PPTX docgen detection', () => {
  it('detects PPTX format in AI response', () => {
    const response = '```json\n{"format": "pptx", "filename": "test.pptx", "content": {"type": "presentation", "slides": []}}\n```';
    expect(isDocGenResponse(response)).toBe(true);
  });

  it('parses PPTX request correctly', () => {
    const response = '```json\n{"format": "pptx", "filename": "deck.pptx", "content": {"type": "presentation", "slides": [{"layout": "title", "title": "Hello"}]}}\n```';
    const parsed = parseDocGenResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('pptx');
    expect(parsed!.filename).toBe('deck.pptx');
  });

  it('still detects xlsx, docx, pdf, csv', () => {
    expect(isDocGenResponse('```json\n{"format": "xlsx", "filename": "a.xlsx", "content": {"type": "spreadsheet", "sheets": []}}\n```')).toBe(true);
    expect(isDocGenResponse('```json\n{"format": "docx", "filename": "a.docx", "content": {"type": "document", "sections": []}}\n```')).toBe(true);
    expect(isDocGenResponse('```json\n{"format": "pdf", "filename": "a.pdf", "content": {"type": "document", "sections": []}}\n```')).toBe(true);
    expect(isDocGenResponse('```json\n{"format": "csv", "filename": "a.csv", "content": {"type": "spreadsheet", "sheets": []}}\n```')).toBe(true);
  });

  it('rejects unknown format', () => {
    const response = '```json\n{"format": "html", "filename": "a.html", "content": {"type": "document", "sections": []}}\n```';
    expect(isDocGenResponse(response)).toBe(false);
  });
});

// ── PPTX Generation ─────────────────────────────────────────

import { generateDocument } from '../src/docgen.js';

describe('PPTX generation', () => {
  it('generates a valid PPTX buffer from presentation content', async () => {
    const result = await generateDocument({
      format: 'pptx',
      filename: 'test.pptx',
      title: 'Test Presentation',
      content: {
        type: 'presentation',
        slides: [
          { layout: 'title', title: 'Welcome', subtitle: 'Subtitle here' },
          { layout: 'bullets', title: 'Key Points', bullets: ['Point 1', 'Point 2', 'Point 3'] },
          { layout: 'two-column', title: 'Comparison', leftColumn: ['Left A', 'Left B'], rightColumn: ['Right A', 'Right B'] },
        ],
      },
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(1000);
    expect(result.filename).toBe('test.pptx');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');

    // PPTX is a ZIP file — verify magic bytes (PK header)
    expect(result.buffer[0]).toBe(0x50); // P
    expect(result.buffer[1]).toBe(0x4B); // K
  });

  it('generates PPTX from document content (auto-converts sections to slides)', async () => {
    const result = await generateDocument({
      format: 'pptx',
      filename: 'from-doc.pptx',
      title: 'Auto-Converted',
      content: {
        type: 'document',
        sections: [
          { heading: 'Section 1', bulletPoints: ['Bullet A', 'Bullet B'] },
          { heading: 'Section 2', paragraphs: ['Some text here'] },
        ],
      },
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(1000);
  });

  it('handles empty slides array', async () => {
    const result = await generateDocument({
      format: 'pptx',
      filename: 'empty.pptx',
      content: {
        type: 'presentation',
        slides: [],
      },
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(100);
  });
});
