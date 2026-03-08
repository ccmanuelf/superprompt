import {
  searchMemories,
  getRecentMemories,
  insertMemory,
  vectorSearchMemories,
  type Memory,
  getDatabase,
} from './db.js';
import { generateEmbedding } from './embeddings.js';
import { logger } from './logger.js';

const SEMANTIC_SIGNAL =
  /\b(my|i am|i'm|i prefer|remember|always|never|my name is|i like|i hate|i love|i work|i live)\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a memory context string to prepend to user messages.
 *
 * Hybrid search:
 * 1. FTS5 keyword search (top 3)
 * 2. Vector similarity search (top 3) — embed user message, query memories_vec
 * 3. Merge: deduplicate by id, return top 5 combined
 * 4. Touch each result (bump accessed_at + salience)
 * 5. Return formatted string
 *
 * Falls back to FTS5-only if embedding generation fails.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
): Promise<string> {
  // Sanitize query for FTS5: strip non-alphanumeric, add prefix matching
  const sanitized = userMessage
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => `${w}*`)
    .join(' ');

  let ftsResults: Memory[] = [];
  if (sanitized) {
    try {
      ftsResults = searchMemories(chatId, sanitized, 3);
    } catch {
      // FTS5 MATCH can fail on certain query patterns — not critical
      logger.debug({ query: sanitized }, 'FTS5 search failed, using recent only');
    }
  }

  // Vector similarity search
  let vecResults: Memory[] = [];
  try {
    const embedding = await generateEmbedding(userMessage);
    if (embedding) {
      vecResults = vectorSearchMemories(chatId, embedding, 3);
    }
  } catch {
    logger.debug('Vector search failed, using FTS5 only');
  }

  const recentResults = getRecentMemories(chatId, 5);

  // Deduplicate by id, preserving order (FTS first, then vec, then recent)
  const seen = new Set<number>();
  const combined: Memory[] = [];

  for (const m of [...ftsResults, ...vecResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      combined.push(m);
    }
  }

  // Take top 5
  const top = combined.slice(0, 5);

  if (top.length === 0) return '';

  // Touch each memory: bump accessed_at and reinforce salience (+0.1, cap 5.0)
  const db = getDatabase();
  const touchStmt = db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  );

  const now = Date.now();
  for (const m of top) {
    touchStmt.run(now, m.id);
  }

  // Format context
  const lines = top.map(
    (m) => `- ${m.content} (${m.sector})`,
  );

  return `[Memory context]\n${lines.join('\n')}`;
}

/**
 * Analyze a conversation turn and save notable content as a memory.
 *
 * - Skips short messages (≤20 chars) and commands (starting with / or !)
 * - Detects semantic signals (personal facts, preferences) → semantic sector
 * - Otherwise stores as episodic
 * - Generates embedding asynchronously (fire-and-forget if it fails)
 */
export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
): Promise<void> {
  // Skip commands and trivially short messages
  if (userMsg.startsWith('/') || userMsg.startsWith('!')) return;
  if (userMsg.length <= 20) return;

  const isSemanticSignal = SEMANTIC_SIGNAL.test(userMsg);
  const sector = isSemanticSignal ? 'semantic' : 'episodic';

  // For semantic: store the user's statement directly
  // For episodic: store a condensed turn summary
  const content = isSemanticSignal
    ? userMsg
    : `User: ${truncate(userMsg, 200)} → Assistant: ${truncate(assistantMsg, 200)}`;

  // Generate embedding (non-blocking — insert with null if it fails)
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(content);
  } catch {
    // Fire-and-forget: embedding failure is not critical
  }

  insertMemory(chatId, content, sector, undefined, embedding ?? undefined);

  logger.debug(
    { chatId, sector, contentLength: content.length, hasEmbedding: !!embedding },
    'Saved conversation memory',
  );
}

/**
 * Apply salience decay to all memories older than 24 hours.
 * Decay factor: 0.98 (2% daily reduction).
 * Memories below 0.1 salience are deleted.
 *
 * Call on startup and then every 24 hours via setInterval.
 */
export function runDecaySweep(): void {
  const db = getDatabase();
  const cutoff = Date.now() - DAY_MS;

  // Only decay memories older than 24 hours
  const decayResult = db
    .prepare(
      'UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?',
    )
    .run(cutoff);

  // Delete memories that have decayed below threshold
  // Also clean up their vec0 entries
  const toDelete = db
    .prepare('SELECT id FROM memories WHERE salience < 0.1')
    .all() as Array<{ id: number }>;

  for (const row of toDelete) {
    try {
      db.prepare('DELETE FROM memories_vec WHERE memory_id = ?').run(row.id);
    } catch {
      // best-effort
    }
  }

  const deleteResult = db
    .prepare('DELETE FROM memories WHERE salience < 0.1')
    .run();

  logger.info(
    {
      decayed: decayResult.changes,
      deleted: deleteResult.changes,
    },
    'Memory decay sweep completed',
  );
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
