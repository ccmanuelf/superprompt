/**
 * Citation tracking system.
 * Stores academic references per conversation with export to BibTeX, APA, Chicago.
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from './db.js';
import { logger } from './logger.js';

// ── Types ───────────────────────────────────────────────────

export type CitationSource = 'semantic_scholar' | 'arxiv' | 'manual' | 'web';
export type CitationFormat = 'bibtex' | 'apa' | 'chicago';

export interface Citation {
  id: string;
  chat_id: string;
  title: string;
  authors: string | null;   // JSON array of author names
  url: string | null;
  doi: string | null;
  year: number | null;
  source: CitationSource;
  abstract: string | null;
  added_at: number;
}

export interface CitationInput {
  title: string;
  authors?: string[];
  url?: string;
  doi?: string;
  year?: number;
  source?: CitationSource;
  abstract?: string;
}

// ── Initialization ──────────────────────────────────────────

export function initCitationTable(): void {
  const db = getDatabase();
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

  logger.info('Citation table initialized');
}

// ── CRUD ────────────────────────────────────────────────────

export function addCitation(chatId: string, input: CitationInput): Citation {
  const db = getDatabase();
  const id = randomBytes(6).toString('hex');
  const now = Date.now();

  db.prepare(
    `INSERT INTO citations (id, chat_id, title, authors, url, doi, year, source, abstract, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, chatId, input.title,
    input.authors ? JSON.stringify(input.authors) : null,
    input.url ?? null,
    input.doi ?? null,
    input.year ?? null,
    input.source ?? 'manual',
    input.abstract ?? null,
    now,
  );

  return getCitationById(id)!;
}

export function getCitationById(id: string): Citation | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM citations WHERE id = ?').get(id) as Citation | undefined;
}

export function getCitations(chatId: string, limit: number = 50): Citation[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM citations WHERE chat_id = ? ORDER BY added_at DESC LIMIT ?',
  ).all(chatId, limit) as Citation[];
}

export function deleteCitation(id: string): boolean {
  const db = getDatabase();
  return db.prepare('DELETE FROM citations WHERE id = ?').run(id).changes > 0;
}

export function clearCitations(chatId: string): number {
  const db = getDatabase();
  return db.prepare('DELETE FROM citations WHERE chat_id = ?').run(chatId).changes;
}

/** Check for duplicate by title (case-insensitive) before adding. */
export function citationExists(chatId: string, title: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT id FROM citations WHERE chat_id = ? AND LOWER(title) = LOWER(?)',
  ).get(chatId, title);
  return !!row;
}

// ── Export Formatters ───────────────────────────────────────

function parseAuthors(authorsJson: string | null): string[] {
  if (!authorsJson) return [];
  try {
    return JSON.parse(authorsJson);
  } catch {
    return [];
  }
}

function formatAuthorAPA(name: string): string {
  // "John Smith" → "Smith, J."
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop()!;
  const initials = parts.map((p) => p[0].toUpperCase() + '.').join(' ');
  return `${last}, ${initials}`;
}

function formatAuthorBibtex(authors: string[]): string {
  return authors.join(' and ');
}

export function exportCitations(chatId: string, format: CitationFormat): string {
  const citations = getCitations(chatId, 500);
  if (citations.length === 0) return 'No citations to export.';

  switch (format) {
    case 'bibtex':
      return citations.map((c) => {
        const authors = parseAuthors(c.authors);
        const key = c.id;
        const lines = [`@article{${key}`];
        lines.push(`  title = {${c.title}}`);
        if (authors.length > 0) lines.push(`  author = {${formatAuthorBibtex(authors)}}`);
        if (c.year) lines.push(`  year = {${c.year}}`);
        if (c.url) lines.push(`  url = {${c.url}}`);
        if (c.doi) lines.push(`  doi = {${c.doi}}`);
        return lines.join(',\n') + '\n}';
      }).join('\n\n');

    case 'apa':
      return citations.map((c) => {
        const authors = parseAuthors(c.authors);
        const authorStr = authors.length > 0
          ? authors.map(formatAuthorAPA).join(', ')
          : 'Unknown Author';
        const year = c.year ? `(${c.year})` : '(n.d.)';
        const url = c.url ? ` ${c.url}` : '';
        const doi = c.doi ? ` https://doi.org/${c.doi}` : '';
        return `${authorStr} ${year}. ${c.title}.${doi || url}`;
      }).join('\n\n');

    case 'chicago':
      return citations.map((c) => {
        const authors = parseAuthors(c.authors);
        const authorStr = authors.length > 0 ? authors.join(', ') : 'Unknown Author';
        const year = c.year ? `${c.year}` : 'n.d.';
        const url = c.url ? ` ${c.url}` : '';
        return `${authorStr}. "${c.title}." ${year}.${url}`;
      }).join('\n\n');

    default:
      return 'Unsupported format.';
  }
}

// ── Formatting ──────────────────────────────────────────────

export function formatCitationList(citations: Citation[]): string {
  if (citations.length === 0) return 'No citations saved yet.';

  const lines = [`**Citations** (${citations.length})`, ''];
  for (let i = 0; i < citations.length; i++) {
    const c = citations[i];
    const authors = parseAuthors(c.authors);
    const authorStr = authors.length > 0 ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '') : '';
    const year = c.year ? ` (${c.year})` : '';
    const src = c.source !== 'manual' ? ` [${c.source}]` : '';
    lines.push(`[${i + 1}] **${c.title}**${year}`);
    if (authorStr) lines.push(`    ${authorStr}`);
    if (c.url) lines.push(`    ${c.url}`);
    lines.push(`    ${src} id: ${c.id}`);
  }
  return lines.join('\n');
}
