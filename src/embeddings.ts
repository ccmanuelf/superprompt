import { Ollama } from 'ollama';
import { config } from './config.js';
import { logger } from './logger.js';

const EMBED_MODEL = 'nomic-embed-text';
// nomic-embed-text has 8192 token context; ~4 chars per token, leave margin
// nomic-embed-text: 8192 tokens. Dense content (CSV, numbers) tokenizes at ~2 chars/token.
// Use conservative limit to avoid context overflow.
const MAX_EMBED_CHARS = 8000;

let client: Ollama | null = null;

function getClient(): Ollama {
  if (!client) {
    client = new Ollama({ host: config.OLLAMA_HOST });
  }
  return client;
}

/**
 * Generate a single embedding vector for the given text.
 * Returns null if Ollama is unreachable or the model is not available.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    // Truncate to fit nomic-embed-text context window
    const truncated = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
    const response = await getClient().embed({
      model: EMBED_MODEL,
      input: truncated,
    });
    return response.embeddings[0] ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Embedding generation failed (Ollama may be down or model not pulled)',
    );
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a single batch call.
 * Returns an array of the same length as input; null for any that failed.
 */
export async function generateEmbeddings(
  texts: string[],
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  try {
    // Truncate each text to fit nomic-embed-text context window
    const truncated = texts.map((t) => t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t);
    const response = await getClient().embed({
      model: EMBED_MODEL,
      input: truncated,
    });
    return response.embeddings.map((e) => e ?? null);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), count: texts.length },
      'Batch embedding generation failed',
    );
    return texts.map(() => null);
  }
}
