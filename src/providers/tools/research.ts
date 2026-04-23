/**
 * Research tools: academic paper search (Semantic Scholar + arXiv),
 * citation management, and report review.
 */

import type { Tool } from 'ollama';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { UPLOADS_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import {
  addCitation, getCitations, clearCitations, exportCitations, citationExists,
  formatCitationList, type CitationFormat,
} from '../../citations.js';
import { parseFile } from '../../files.js';

// ── Constants ───────────────────────────────────────────────

const SEMANTIC_SCHOLAR_BASE = 'https://api.semanticscholar.org/graph/v1';
const ARXIV_BASE = 'https://export.arxiv.org/api';
const FETCH_TIMEOUT = 15_000;

// ── Tool Definitions ────────────────────────────────────────

export const searchPapersDefinition: Tool = {
  type: 'function',
  function: {
    name: 'search_papers',
    description: 'Search academic papers via Semantic Scholar and arXiv. Returns titles, authors, abstracts, citation counts, and URLs. Results are automatically saved as citations.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (topic, keywords, or paper title)' },
        source: { type: 'string', description: 'Search source: semantic_scholar, arxiv, or both (default: both)', enum: ['semantic_scholar', 'arxiv', 'both'] },
        limit: { type: 'number', description: 'Max results to return (default: 5, max: 10)' },
        year_from: { type: 'number', description: 'Filter papers published from this year onward (e.g., 2020)' },
      },
      required: ['query'],
    },
  },
};

export const manageCitationsDefinition: Tool = {
  type: 'function',
  function: {
    name: 'manage_citations',
    description: 'List, export, or clear saved citations for this conversation. Export formats: bibtex, apa, chicago.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['list', 'export', 'clear'] },
        format: { type: 'string', description: 'Export format (only for export action)', enum: ['bibtex', 'apa', 'chicago'] },
      },
      required: ['action'],
    },
  },
};

export const reviewReportDefinition: Tool = {
  type: 'function',
  function: {
    name: 'review_report',
    description: 'Review an uploaded document for quality, completeness, clarity, or data issues. Parses the file and provides structured feedback.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the uploaded file to review' },
        review_type: { type: 'string', description: 'Type of review to perform', enum: ['gaps', 'clarity', 'data_quality', 'full'] },
      },
      required: ['file_path'],
    },
  },
};

// ── Paper Search Results ────────────────────────────────────

interface PaperResult {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  citationCount: number | null;
  url: string;
  doi: string | null;
  source: 'semantic_scholar' | 'arxiv';
}

// ── Semantic Scholar API ────────────────────────────────────

async function searchSemanticScholar(query: string, limit: number, yearFrom?: number): Promise<PaperResult[]> {
  const fields = 'title,authors,year,abstract,citationCount,url,externalIds';
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(limit, 10)),
    fields,
  });
  if (yearFrom) params.set('year', `${yearFrom}-`);

  const url = `${SEMANTIC_SCHOLAR_BASE}/paper/search?${params}`;
  logger.debug({ url }, 'Searching Semantic Scholar');

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'luna/1.0 (research-tool)' },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Semantic Scholar API error');
      return [];
    }

    const data = await response.json() as {
      data?: Array<{
        title: string;
        authors?: Array<{ name: string }>;
        year?: number;
        abstract?: string;
        citationCount?: number;
        url?: string;
        externalIds?: { DOI?: string };
      }>;
    };

    return (data.data ?? []).map((paper) => ({
      title: paper.title || 'Untitled',
      authors: paper.authors?.map((a) => a.name) ?? [],
      year: paper.year ?? null,
      abstract: paper.abstract ?? '',
      citationCount: paper.citationCount ?? null,
      url: paper.url || '',
      doi: paper.externalIds?.DOI ?? null,
      source: 'semantic_scholar' as const,
    }));
  } catch (err) {
    logger.warn({ err }, 'Semantic Scholar search failed');
    return [];
  }
}

// ── arXiv API ───────────────────────────────────────────────

async function searchArxiv(query: string, limit: number): Promise<PaperResult[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    max_results: String(Math.min(limit, 10)),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });

  const url = `${ARXIV_BASE}/query?${params}`;
  logger.debug({ url }, 'Searching arXiv');

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'arXiv API error');
      return [];
    }

    const xml = await response.text();
    return parseArxivXml(xml);
  } catch (err) {
    logger.warn({ err }, 'arXiv search failed');
    return [];
  }
}

/** Parse arXiv Atom XML response using regex (avoids XML parser dependency). */
function parseArxivXml(xml: string): PaperResult[] {
  const entries: PaperResult[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim() || 'Untitled';
    const abstract = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim() || '';
    const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
    const year = published ? parseInt(published.slice(0, 4)) : null;
    const url = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || '';
    const doi = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/)?.[1]?.trim() ?? null;

    // Extract authors
    const authors: string[] = [];
    const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    entries.push({
      title,
      authors,
      year,
      abstract: abstract.length > 500 ? abstract.slice(0, 500) + '...' : abstract,
      citationCount: null, // arXiv doesn't provide citation counts
      url,
      doi,
      source: 'arxiv',
    });
  }

  return entries;
}

// ── Tool Implementations ────────────────────────────────────

export async function searchPapers(
  args: { query: string; source?: string; limit?: number; year_from?: number },
  chatId: string,
): Promise<Record<string, unknown>> {
  const { query, source = 'both', limit = 5, year_from } = args;

  if (!query || query.trim().length < 2) {
    return { error: 'Query must be at least 2 characters.' };
  }

  const results: PaperResult[] = [];

  if (source === 'semantic_scholar' || source === 'both') {
    const ssResults = await searchSemanticScholar(query, limit, year_from);
    results.push(...ssResults);
  }

  if (source === 'arxiv' || source === 'both') {
    const arxivResults = await searchArxiv(query, limit);
    results.push(...arxivResults);
  }

  if (results.length === 0) {
    return { papers: [], message: 'No papers found. Try different keywords or a broader query.' };
  }

  // Deduplicate by title similarity (case-insensitive, normalized)
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by citation count (if available), then recency
  unique.sort((a, b) => {
    if (a.citationCount !== null && b.citationCount !== null) return b.citationCount - a.citationCount;
    if (a.citationCount !== null) return -1;
    if (b.citationCount !== null) return 1;
    return (b.year ?? 0) - (a.year ?? 0);
  });

  const limited = unique.slice(0, Math.min(limit, 10));

  // Auto-save as citations
  let saved = 0;
  for (const paper of limited) {
    if (!await citationExists(chatId, paper.title)) {
      await addCitation(chatId, {
        title: paper.title,
        authors: paper.authors,
        url: paper.url,
        doi: paper.doi ?? undefined,
        year: paper.year ?? undefined,
        source: paper.source,
        abstract: paper.abstract,
      });
      saved++;
    }
  }

  logger.info({ query, source, results: limited.length, saved }, 'Paper search completed');

  return {
    papers: limited.map((p) => ({
      title: p.title,
      authors: p.authors.join(', '),
      year: p.year,
      abstract: p.abstract,
      citations: p.citationCount,
      url: p.url,
      source: p.source,
    })),
    total: limited.length,
    saved_as_citations: saved,
  };
}

export async function manageCitations(
  args: { action: string; format?: string },
  chatId: string,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'list': {
      const citations = await getCitations(chatId);
      return { citations: formatCitationList(citations), count: citations.length };
    }

    case 'export': {
      const format = (args.format || 'apa') as CitationFormat;
      if (!['bibtex', 'apa', 'chicago'].includes(format)) {
        return { error: `Invalid format: ${format}. Use bibtex, apa, or chicago.` };
      }
      const exported = await exportCitations(chatId, format);
      if (exported === 'No citations to export.') {
        return { message: exported };
      }

      // Save to file
      mkdirSync(UPLOADS_DIR, { recursive: true });
      const ext = format === 'bibtex' ? 'bib' : 'txt';
      const filePath = resolve(UPLOADS_DIR, `citations_${Date.now()}.${ext}`);
      writeFileSync(filePath, exported, 'utf-8');

      return {
        message: `Exported ${(await getCitations(chatId)).length} citations in ${format.toUpperCase()} format.`,
        file_path: filePath,
        content: exported,
      };
    }

    case 'clear': {
      const count = await clearCitations(chatId);
      return { message: `Cleared ${count} citation(s).` };
    }

    default:
      return { error: `Unknown action: ${args.action}. Use list, export, or clear.` };
  }
}

export async function reviewReport(
  args: { file_path: string; review_type?: string },
): Promise<Record<string, unknown>> {
  const { file_path, review_type = 'full' } = args;

  // Parse the uploaded file
  const parsed = await parseFile(file_path);
  if (parsed.error) {
    return { error: `Failed to parse file: ${parsed.error}` };
  }

  if (!parsed.text || parsed.text.trim().length < 50) {
    return { error: 'File contains too little text to review.' };
  }

  // Build review prompt based on type
  const reviewPrompts: Record<string, string> = {
    gaps: 'Identify missing sections, unsupported claims, incomplete analysis, and topics that should be covered but are not. List each gap with its location and what should be added.',
    clarity: 'Assess readability, jargon usage, logical flow, and ambiguous statements. Identify sentences or paragraphs that are hard to understand and suggest rewrites.',
    data_quality: 'Check for inconsistencies in numbers, missing units, statistical errors, unsourced data claims, and calculation mistakes. Flag each issue with its location.',
    full: 'Perform a comprehensive review covering: (1) Missing sections or gaps in coverage, (2) Clarity and readability issues, (3) Data quality and consistency problems, (4) Logical flow and argument structure, (5) Overall recommendations for improvement.',
  };

  const prompt = reviewPrompts[review_type] || reviewPrompts.full;

  // Truncate long documents for review (keep first 8000 chars for AI processing)
  const textForReview = parsed.text.length > 8000
    ? parsed.text.slice(0, 8000) + '\n\n[... document truncated for review — ' + parsed.text.length + ' chars total]'
    : parsed.text;

  return {
    review_type: review_type,
    document_format: parsed.format,
    document_length: parsed.text.length,
    pages: parsed.pageCount ?? null,
    review_prompt: `Review this document:\n\n---\n${textForReview}\n---\n\n${prompt}`,
    instructions: 'Use the review_prompt content to provide your analysis. Structure your response with numbered findings, each with severity (critical/major/minor), location, and suggestion.',
  };
}

/** Exported for testing. */
export { parseArxivXml };
