import {
  searchMemories,
  getRecentMemories,
  insertMemory,
  touchMemory,
  type Memory,
  getDatabase,
} from './db.js';
import { logger } from './logger.js';

const SEMANTIC_SIGNAL =
  /\b(my|i am|i'm|i prefer|remember|always|never|my name is|i like|i hate|i love|i work|i live)\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a memory context string to prepend to user messages.
 *
 * 1. FTS5 search the user message (top 3)
 * 2. Fetch recent memories (top 5)
 * 3. Deduplicate by id
 * 4. Touch each result (bump accessed_at + salience)
 * 5. Return formatted string
 */
export function buildMemoryContext(
  chatId: string,
  userMessage: string,
): string {
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

  const recentResults = getRecentMemories(chatId, 5);

  // Deduplicate by id
  const seen = new Set<number>();
  const combined: Memory[] = [];

  for (const m of [...ftsResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      combined.push(m);
    }
  }

  if (combined.length === 0) return '';

  // Touch each memory: bump accessed_at and reinforce salience (+0.1, cap 5.0)
  const db = getDatabase();
  const touchStmt = db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  );

  const now = Date.now();
  for (const m of combined) {
    touchStmt.run(now, m.id);
  }

  // Format context
  const lines = combined.map(
    (m) => `- ${m.content} (${m.sector})`,
  );

  return `[Memory context]\n${lines.join('\n')}`;
}

/**
 * Analyze a conversation turn and save notable content as a memory.
 *
 * - Skips short messages (≤20 chars) and commands (starting with /)
 * - Detects semantic signals (personal facts, preferences) → semantic sector
 * - Otherwise stores as episodic
 */
export function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
): void {
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

  insertMemory(chatId, content, sector);

  logger.debug(
    { chatId, sector, contentLength: content.length },
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
