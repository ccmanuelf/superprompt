import { getDatabase, type Episode } from './db.js';
import { logger } from './logger.js';
import type { NotifyFn } from './scheduler.js';

const FOLLOW_UP_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours after episode creation
const FOLLOW_UP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

let followUpTimer: ReturnType<typeof setInterval> | undefined;
let notifyFn: NotifyFn | undefined;

/**
 * Get episodes with open threads that haven't been followed up on yet.
 * An episode is eligible for follow-up when:
 * 1. It has non-empty open_threads
 * 2. It was created more than FOLLOW_UP_DELAY_MS ago
 * 3. It hasn't been followed up on yet (no 'followed_up' flag)
 */
export function getEpisodesNeedingFollowUp(): Episode[] {
  const db = getDatabase();
  const cutoff = Date.now() - FOLLOW_UP_DELAY_MS;

  return db.prepare(
    `SELECT * FROM episodes
     WHERE open_threads IS NOT NULL
       AND open_threads != '[]'
       AND created_at < ?
       AND id NOT IN (SELECT episode_id FROM episode_follow_ups)
     ORDER BY created_at ASC
     LIMIT 5`,
  ).all(cutoff) as Episode[];
}

/**
 * Mark an episode as followed up so we don't send duplicate messages.
 */
export function markEpisodeFollowedUp(episodeId: number): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR IGNORE INTO episode_follow_ups (episode_id, followed_up_at) VALUES (?, ?)',
  ).run(episodeId, Date.now());
}

/**
 * Generate a follow-up message for an episode with open threads.
 */
export function buildFollowUpMessage(episode: Episode): string {
  let threads: string[];
  try {
    threads = JSON.parse(episode.open_threads!);
  } catch {
    return '';
  }

  if (threads.length === 0) return '';

  const threadList = threads.map((t) => `• ${t}`).join('\n');

  return `📌 **Follow-up from a previous conversation:**\n\n${threadList}\n\nWant to pick any of these up?`;
}

/**
 * Run the follow-up check: find episodes with open threads and notify users.
 */
async function runFollowUpCheck(): Promise<void> {
  if (!notifyFn) return;

  try {
    const episodes = getEpisodesNeedingFollowUp();

    if (episodes.length === 0) return;

    for (const episode of episodes) {
      const message = buildFollowUpMessage(episode);
      if (!message) {
        markEpisodeFollowedUp(episode.id);
        continue;
      }

      try {
        await notifyFn(episode.chat_id, message);
        markEpisodeFollowedUp(episode.id);
        logger.info(
          { episodeId: episode.id, chatId: episode.chat_id },
          'Sent follow-up for episode with open threads',
        );
      } catch (err) {
        logger.warn(
          { err, episodeId: episode.id },
          'Failed to send follow-up message',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Follow-up check failed');
  }
}

/**
 * Get a digest of recent activity for a chat.
 */
export function buildDigest(chatId: string, periodMs: number): string {
  const db = getDatabase();
  const since = Date.now() - periodMs;

  // Count memories created
  const memoryCount = (db.prepare(
    'SELECT COUNT(*) as count FROM memories WHERE chat_id = ? AND created_at > ?',
  ).get(chatId, since) as { count: number }).count;

  // Count episodes created
  const episodeCount = (db.prepare(
    'SELECT COUNT(*) as count FROM episodes WHERE chat_id = ? AND created_at > ?',
  ).get(chatId, since) as { count: number }).count;

  // Recent episodes with summaries
  const recentEpisodes = db.prepare(
    'SELECT summary FROM episodes WHERE chat_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 5',
  ).all(chatId, since) as Array<{ summary: string }>;

  // Scheduled tasks that ran
  const tasksRun = (db.prepare(
    'SELECT COUNT(*) as count FROM scheduled_tasks WHERE chat_id = ? AND last_run > ?',
  ).get(chatId, since) as { count: number }).count;

  if (memoryCount === 0 && episodeCount === 0 && tasksRun === 0) {
    return 'No activity in this period.';
  }

  const lines: string[] = ['📊 **Activity Digest**\n'];

  if (memoryCount > 0) {
    lines.push(`• ${memoryCount} conversation${memoryCount > 1 ? 's' : ''} remembered`);
  }
  if (episodeCount > 0) {
    lines.push(`• ${episodeCount} conversation${episodeCount > 1 ? 's' : ''} compressed into episodes`);
  }
  if (tasksRun > 0) {
    lines.push(`• ${tasksRun} scheduled task${tasksRun > 1 ? 's' : ''} executed`);
  }

  if (recentEpisodes.length > 0) {
    lines.push('\n**Recent conversation summaries:**');
    for (const ep of recentEpisodes) {
      lines.push(`• ${ep.summary.slice(0, 150)}${ep.summary.length > 150 ? '...' : ''}`);
    }
  }

  return lines.join('\n');
}

// ── Digest preferences (per-chat) ──────────────────────────

export type DigestFrequency = 'daily' | 'weekly' | 'off';

/**
 * Get the digest preference for a chat.
 */
export function getDigestPreference(chatId: string): DigestFrequency {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT frequency FROM digest_preferences WHERE chat_id = ?',
  ).get(chatId) as { frequency: string } | undefined;
  return (row?.frequency as DigestFrequency) || 'off';
}

/**
 * Set the digest preference for a chat.
 */
export function setDigestPreference(chatId: string, frequency: DigestFrequency): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO digest_preferences (chat_id, frequency, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET frequency = excluded.frequency, updated_at = excluded.updated_at`,
  ).run(chatId, frequency, Date.now());
}

/**
 * Run digest delivery for all chats with active digest preferences.
 */
async function runDigestDelivery(): Promise<void> {
  if (!notifyFn) return;

  const db = getDatabase();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  const prefs = db.prepare(
    'SELECT * FROM digest_preferences WHERE frequency != ?',
  ).all('off') as Array<{ chat_id: string; frequency: string; updated_at: number }>;

  for (const pref of prefs) {
    const periodMs = pref.frequency === 'daily' ? DAY_MS : WEEK_MS;

    // Only send if enough time has passed since last update
    // (prevents sending multiple digests on restart)
    if (now - pref.updated_at < periodMs * 0.9) continue;

    const digest = buildDigest(pref.chat_id, periodMs);
    if (digest === 'No activity in this period.') continue;

    try {
      await notifyFn(pref.chat_id, digest);
      // Update timestamp so we don't re-send
      db.prepare('UPDATE digest_preferences SET updated_at = ? WHERE chat_id = ?')
        .run(now, pref.chat_id);
      logger.info({ chatId: pref.chat_id, frequency: pref.frequency }, 'Sent digest');
    } catch (err) {
      logger.warn({ err, chatId: pref.chat_id }, 'Failed to send digest');
    }
  }
}

/**
 * Initialize proactive messaging. Starts periodic follow-up and digest checks.
 */
export function initProactiveMessaging(notify: NotifyFn): () => void {
  notifyFn = notify;

  logger.info('Proactive messaging initialized');

  // Run follow-up check every hour
  followUpTimer = setInterval(() => {
    runFollowUpCheck().catch((err) =>
      logger.warn({ err }, 'Proactive follow-up check failed'),
    );
    runDigestDelivery().catch((err) =>
      logger.warn({ err }, 'Digest delivery failed'),
    );
  }, FOLLOW_UP_CHECK_INTERVAL_MS);

  // Also run once on startup (delayed by 5 min to let things settle)
  setTimeout(() => {
    runFollowUpCheck().catch((err) =>
      logger.warn({ err }, 'Initial follow-up check failed'),
    );
  }, 5 * 60 * 1000);

  return () => {
    if (followUpTimer) {
      clearInterval(followUpTimer);
      followUpTimer = undefined;
      logger.info('Proactive messaging stopped');
    }
  };
}
