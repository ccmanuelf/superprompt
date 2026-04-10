/**
 * Citation tracking system.
 * Stores academic references per conversation with export to BibTeX, APA, Chicago.
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

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

export async function initCitationTable(): Promise<void> {
  const db = getKnex();
  const exists = await db.schema.hasTable('citations');
  if (!exists) {
    await db.schema.createTable('citations', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable();
      t.text('title').notNullable();
      t.text('authors');
      t.text('url');
      t.text('doi');
      t.integer('year');
      t.text('source').notNullable().defaultTo('manual');
      t.text('abstract');
      t.integer('added_at').notNullable();
      t.index(['chat_id', 'added_at'], 'idx_citations_chat');
    });
  }

  logger.info('Citation table initialized');
}

export const citationTableInit: TableInitializer = { name: 'citations', initTables: initCitationTable };

// ── CRUD ────────────────────────────────────────────────────

export async function addCitation(chatId: string, input: CitationInput): Promise<Citation> {
  const db = getKnex();
  const id = randomBytes(6).toString('hex');
  const now = Date.now();

  await db('citations').insert({
    id,
    chat_id: chatId,
    title: input.title,
    authors: input.authors ? JSON.stringify(input.authors) : null,
    url: input.url ?? null,
    doi: input.doi ?? null,
    year: input.year ?? null,
    source: input.source ?? 'manual',
    abstract: input.abstract ?? null,
    added_at: now,
  });

  return (await getCitationById(id))!;
}

export async function getCitationById(id: string): Promise<Citation | undefined> {
  const db = getKnex();
  return db('citations').where('id', id).first() as Promise<Citation | undefined>;
}

export async function getCitations(chatId: string, limit: number = 50): Promise<Citation[]> {
  const db = getKnex();
  return db('citations')
    .where('chat_id', chatId)
    .orderBy('added_at', 'desc')
    .limit(limit) as Promise<Citation[]>;
}

export async function deleteCitation(id: string): Promise<boolean> {
  const db = getKnex();
  const count = await db('citations').where('id', id).del();
  return count > 0;
}

export async function clearCitations(chatId: string): Promise<number> {
  const db = getKnex();
  return db('citations').where('chat_id', chatId).del();
}

/** Check for duplicate by title (case-insensitive) before adding. */
export async function citationExists(chatId: string, title: string): Promise<boolean> {
  const db = getKnex();
  const row = await db('citations')
    .where('chat_id', chatId)
    .whereRaw('LOWER(title) = LOWER(?)', [title])
    .select('id')
    .first();
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

export async function exportCitations(chatId: string, format: CitationFormat): Promise<string> {
  const citations = await getCitations(chatId, 500);
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
