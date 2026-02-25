import type { Tool } from 'ollama';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

export const webSearchDefinition: Tool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current information. Use for questions about recent events, facts, or topics you are unsure about.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchSearXNG(query: string): Promise<SearchResult[]> {
  const url = new URL('/search', config.SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}`);
  }

  const data = (await res.json()) as { results: Array<{ title: string; url: string; content: string }> };
  return (data.results || []).slice(0, 5).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function searchBrave(query: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': config.BRAVE_API_KEY,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Brave Search returned ${res.status}`);
  }

  const data = (await res.json()) as {
    web: { results: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results || []).slice(0, 5).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

export async function webSearch(args: {
  query: string;
}): Promise<Record<string, string | SearchResult[]>> {
  // Try SearXNG first, then Brave
  if (config.SEARXNG_URL) {
    try {
      const results = await searchSearXNG(args.query);
      return { results: results as unknown as SearchResult[] };
    } catch (err) {
      logger.warn({ err }, 'SearXNG search failed, trying Brave');
    }
  }

  if (config.BRAVE_API_KEY) {
    try {
      const results = await searchBrave(args.query);
      return { results: results as unknown as SearchResult[] };
    } catch (err) {
      logger.warn({ err }, 'Brave search failed');
    }
  }

  return {
    error:
      'No search backend available. Configure SEARXNG_URL or BRAVE_API_KEY.',
  };
}
