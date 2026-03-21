import {
  searchMemories,
  getRecentMemories,
  insertMemory,
  vectorSearchMemories,
  searchEpisodes,
  vectorSearchEpisodes,
  getChatsWithCompressibleMemories,
  getCompressibleMemories,
  deleteMemories,
  insertEpisode,
  type Memory,
  type Episode,
  getDatabase,
} from './db.js';
import { generateEmbedding } from './embeddings.js';
import { estimateTokens } from './context-budget.js';
import { logger } from './logger.js';

const SEMANTIC_SIGNAL =
  /\b(my|i am|i'm|i prefer|remember|always|never|my name is|i like|i hate|i love|i work|i live)\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum episodic memories per chat to trigger compression.
 * Lower than before (was 5) — even short conversations have value.
 */
const MIN_MEMORIES_FOR_COMPRESSION = 3;

/** Time window: memories within this gap are grouped into one episode */
const EPISODE_GROUP_GAP_MS = 60 * 60 * 1000; // 1 hour (was 30 min — too aggressive at splitting)

/**
 * Salience threshold for compression eligibility.
 * At 0.98 daily decay from 1.0:
 *   0.7 ≈ 18 days, 0.5 ≈ 35 days, 0.3 ≈ 60 days
 * Using 0.7 means compression kicks in after ~2-3 weeks of no access,
 * which is reasonable for "fading but still worth remembering" memories.
 */
const COMPRESSION_SALIENCE_THRESHOLD = 0.7;

/**
 * Build a memory context string to prepend to user messages.
 *
 * Hybrid search:
 * 1. FTS5 keyword search on memories (top 3) + episodes (top 2)
 * 2. Vector similarity search on memories (top 3) + episodes (top 2)
 * 3. Recent memories (top 5)
 * 4. Merge: deduplicate, return top 5 memories + top 2 episodes
 * 5. Touch each memory (bump accessed_at + salience)
 * 6. Return formatted string
 *
 * Falls back to FTS5-only if embedding generation fails.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  maxTokens: number = 1500,
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
  let ftsEpisodes: Episode[] = [];
  if (sanitized) {
    try {
      ftsResults = searchMemories(chatId, sanitized, 3);
    } catch {
      // FTS5 MATCH can fail on certain query patterns — not critical
      logger.debug({ query: sanitized }, 'FTS5 search failed, using recent only');
    }
    try {
      ftsEpisodes = searchEpisodes(chatId, sanitized, 2);
    } catch {
      logger.debug('Episode FTS5 search failed');
    }
  }

  // Vector similarity search
  let vecResults: Memory[] = [];
  let vecEpisodes: Episode[] = [];
  try {
    const embedding = await generateEmbedding(userMessage);
    if (embedding) {
      vecResults = vectorSearchMemories(chatId, embedding, 3);
      vecEpisodes = vectorSearchEpisodes(chatId, embedding, 2);
    }
  } catch {
    logger.debug('Vector search failed, using FTS5 only');
  }

  const recentResults = getRecentMemories(chatId, 5);

  // Deduplicate memories by id, preserving order (FTS first, then vec, then recent)
  const seen = new Set<number>();
  const combined: Memory[] = [];

  for (const m of [...ftsResults, ...vecResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      combined.push(m);
    }
  }

  // Deduplicate episodes
  const seenEp = new Set<number>();
  const combinedEpisodes: Episode[] = [];
  for (const ep of [...ftsEpisodes, ...vecEpisodes]) {
    if (!seenEp.has(ep.id)) {
      seenEp.add(ep.id);
      combinedEpisodes.push(ep);
    }
  }

  // Take top 5 memories + top 2 episodes
  const topMemories = combined.slice(0, 5);
  const topEpisodes = combinedEpisodes.slice(0, 2);

  if (topMemories.length === 0 && topEpisodes.length === 0) return '';

  // Touch each memory: bump accessed_at and reinforce salience (+0.1, cap 5.0)
  const db = getDatabase();
  const touchStmt = db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  );

  const now = Date.now();
  for (const m of topMemories) {
    touchStmt.run(now, m.id);
  }

  // Format context — episodes first (they're higher-level summaries)
  // Apply budget: keep adding items until we approach maxTokens
  const lines: string[] = [];
  let tokenCount = estimateTokens('[Memory context]\n');

  // Episodes first (higher-level, more value per token)
  for (const ep of topEpisodes) {
    const line = `- [Past conversation] ${ep.summary}`;
    const lineTokens = estimateTokens(line);
    if (tokenCount + lineTokens > maxTokens) break;
    lines.push(line);
    tokenCount += lineTokens;
  }

  // Then individual memories (semantic first, then episodic)
  const sortedMemories = [...topMemories].sort((a, b) => {
    if (a.sector === 'semantic' && b.sector !== 'semantic') return -1;
    if (a.sector !== 'semantic' && b.sector === 'semantic') return 1;
    return 0;
  });

  for (const m of sortedMemories) {
    const line = `- ${m.content} (${m.sector})`;
    const lineTokens = estimateTokens(line);
    if (tokenCount + lineTokens > maxTokens) break;
    lines.push(line);
    tokenCount += lineTokens;
  }

  if (lines.length === 0) return '';

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
 *
 * Compression runs BEFORE decay deletion:
 * - Eligible memories (episodic, salience 0.1–0.7) are compressed into episodes
 * - If compression fails (Ollama down), those memories are PROTECTED from deletion
 *   by boosting their salience above the deletion threshold
 * - Only memories below 0.1 salience with NO pending compression are deleted
 *
 * Call on startup and then every 24 hours via setInterval.
 */
export async function runDecaySweep(): Promise<void> {
  const db = getDatabase();
  const cutoff = Date.now() - DAY_MS;

  // Only decay memories older than 24 hours
  const decayResult = db
    .prepare(
      'UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?',
    )
    .run(cutoff);

  // Compress episodic memories that have decayed enough to be candidates
  let compressed = 0;
  let compressionFailed = false;
  try {
    compressed = await compressEpisodes();
  } catch (err) {
    compressionFailed = true;
    logger.warn({ err }, 'Episode compression failed during decay sweep');
  }

  // SAFETY: If compression failed, protect compressible memories from deletion.
  // Boost their salience so they survive until the next successful compression.
  if (compressionFailed) {
    const protected_ = db
      .prepare(
        `UPDATE memories SET salience = MAX(salience, 0.15)
         WHERE sector = 'episodic' AND salience > 0.05 AND salience <= ?`,
      )
      .run(COMPRESSION_SALIENCE_THRESHOLD);

    if (protected_.changes > 0) {
      logger.info(
        { protected: protected_.changes },
        'Protected compressible memories from deletion (compression unavailable)',
      );
    }
  }

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
      compressed,
      deleted: deleteResult.changes,
      compressionFailed,
    },
    'Memory decay sweep completed',
  );
}

/**
 * Compress decaying episodic memories into episodes.
 *
 * Filtration Analysis approach (inspired by Slate + professor.md):
 * - Filter 1 — Relevance: What user facts, preferences, or decisions emerged?
 * - Filter 2 — Outcome: What was accomplished or resolved?
 * - Filter 3 — Continuity: What open threads or follow-ups remain?
 *
 * Groups memories by time proximity (within 1h gap = same episode).
 * Uses Ollama to generate compressed summaries.
 * Deletes original memories after successful compression.
 *
 * Returns the number of episodes created.
 */
export async function compressEpisodes(): Promise<number> {
  const chatIds = getChatsWithCompressibleMemories(COMPRESSION_SALIENCE_THRESHOLD);
  let totalCreated = 0;

  for (const chatId of chatIds) {
    const memories = getCompressibleMemories(chatId, COMPRESSION_SALIENCE_THRESHOLD);

    if (memories.length < MIN_MEMORIES_FOR_COMPRESSION) continue;

    // Group by time proximity
    const groups = groupMemoriesByTime(memories);

    for (const group of groups) {
      // Compress groups of any size ≥ 1 — even a single memory is worth
      // compressing if its salience is low enough to be a candidate
      try {
        const episode = await compressMemoryGroup(chatId, group);
        if (episode) {
          totalCreated++;
        }
      } catch (err) {
        logger.warn(
          { err, chatId, groupSize: group.length },
          'Failed to compress memory group',
        );
        // Re-throw so runDecaySweep knows compression failed and can protect memories
        throw err;
      }
    }
  }

  if (totalCreated > 0) {
    logger.info({ episodesCreated: totalCreated }, 'Episode compression completed');
  }

  return totalCreated;
}

/**
 * Group memories by time proximity.
 * Memories within EPISODE_GROUP_GAP_MS of each other belong to the same group.
 * Exported for testing.
 */
export function groupMemoriesByTime(memories: Memory[]): Memory[][] {
  if (memories.length === 0) return [];

  const sorted = [...memories].sort((a, b) => a.created_at - b.created_at);
  const groups: Memory[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastGroup = groups[groups.length - 1];
    const lastMemory = lastGroup[lastGroup.length - 1];

    if (current.created_at - lastMemory.created_at <= EPISODE_GROUP_GAP_MS) {
      lastGroup.push(current);
    } else {
      groups.push([current]);
    }
  }

  return groups;
}

/**
 * Compress a group of episodic memories into a single episode using AI.
 * Uses Ollama (local, fast) for compression.
 */
async function compressMemoryGroup(
  chatId: string,
  memories: Memory[],
): Promise<Episode | null> {
  // Build the content to compress
  const turnSummaries = memories.map((m) => `- ${m.content}`).join('\n');

  const compressionPrompt = `You are a memory compression system. Analyze the following conversation turns and produce a compressed episode summary.

Conversation turns:
${turnSummaries}

Apply these filters:

FILTER 1 — RELEVANCE: What user facts, preferences, or decisions emerged from this conversation?
FILTER 2 — OUTCOME: What was accomplished or resolved?
FILTER 3 — CONTINUITY: What open threads, questions, or follow-ups remain?

Respond in this exact JSON format (no markdown, no code fences):
{"summary":"One paragraph capturing the essential context from this conversation","key_facts":["fact1","fact2"],"open_threads":["thread1","thread2"]}

Rules:
- Summary must be a single paragraph, max 200 words
- key_facts: specific, actionable facts about the user or decisions made (empty array if none)
- open_threads: unresolved topics or promised follow-ups (empty array if none)
- Do NOT include greetings, small talk, or trivial exchanges
- If the conversation was trivial with no meaningful content, return: {"summary":"Casual conversation with no actionable content","key_facts":[],"open_threads":[]}`;

  // Use Ollama directly for compression (avoid going through the full router)
  const { Ollama } = await import('ollama');
  const { config } = await import('./config.js');

  const ollama = new Ollama({ host: config.OLLAMA_HOST });
  const response = await ollama.chat({
    model: config.OLLAMA_CHAT_MODEL,
    messages: [{ role: 'user', content: compressionPrompt }],
    options: { temperature: 0.3, num_predict: 512 },
    stream: false,
  });

  const responseText = response.message.content.trim();

  // Parse the JSON response — handle potential markdown fences
  const jsonStr = responseText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: { summary: string; key_facts: string[]; open_threads: string[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // If JSON parsing fails, use the raw text as summary
    logger.warn({ responseText }, 'Episode compression returned invalid JSON, using raw text');
    parsed = { summary: truncate(responseText, 500), key_facts: [], open_threads: [] };
  }

  // Generate embedding for the episode summary
  let embedding: number[] | undefined;
  try {
    const emb = await generateEmbedding(parsed.summary);
    if (emb) embedding = emb;
  } catch {
    // Non-critical
  }

  // Save the episode
  const episodeId = insertEpisode(
    chatId,
    parsed.summary,
    parsed.key_facts.length > 0 ? parsed.key_facts : null,
    parsed.open_threads.length > 0 ? parsed.open_threads : null,
    memories.length,
    embedding,
  );

  // Delete the original memories ONLY after episode is successfully saved
  deleteMemories(memories.map((m) => m.id));

  logger.debug(
    {
      chatId,
      episodeId,
      memoriesCompressed: memories.length,
      summaryLength: parsed.summary.length,
      keyFacts: parsed.key_facts.length,
      openThreads: parsed.open_threads.length,
    },
    'Created episode from memory group',
  );

  return {
    id: episodeId,
    chat_id: chatId,
    summary: parsed.summary,
    key_facts: parsed.key_facts.length > 0 ? JSON.stringify(parsed.key_facts) : null,
    open_threads: parsed.open_threads.length > 0 ? JSON.stringify(parsed.open_threads) : null,
    source_count: memories.length,
    created_at: Date.now(),
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
