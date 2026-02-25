import type { Tool } from 'ollama';

const MAX_CHARS = 5_000;

export const summarizeUrlDefinition: Tool = {
  type: 'function',
  function: {
    name: 'summarize_url',
    description:
      'Fetch a URL and return a summary of its content. Useful for getting information from web pages.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch and summarize',
        },
      },
      required: ['url'],
    },
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function summarizeUrl(args: {
  url: string;
}): Promise<Record<string, string>> {
  try {
    new URL(args.url); // Validate URL
  } catch {
    return { error: `Invalid URL: ${args.url}` };
  }

  try {
    const res = await fetch(args.url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'clauded/0.1 (bot; URL summarizer)',
      },
    });

    if (!res.ok) {
      return { error: `HTTP ${res.status} fetching ${args.url}` };
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    let content: string;
    if (contentType.includes('text/html')) {
      content = stripHtml(text);
    } else {
      content = text;
    }

    if (content.length > MAX_CHARS) {
      return {
        content: content.slice(0, MAX_CHARS),
        truncated: `true (showing first ${MAX_CHARS} of ${content.length} chars)`,
        url: args.url,
      };
    }

    return { content, url: args.url };
  } catch (err) {
    return {
      error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
