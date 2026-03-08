#!/usr/bin/env node
/**
 * clauded — Personal AI Assistant Daemon
 *
 * Entry point. Wires all subsystems together and manages the lifecycle.
 *
 * Startup sequence:
 * 1. Show banner
 * 2. Validate required config
 * 3. Acquire PID lock
 * 4. Initialize database
 * 5. Run memory decay sweep (+ 24h interval)
 * 6. Clean up old uploads
 * 7. Initialize provider router
 * 8. Create Telegram bot (if configured)
 * 9. Create Matrix bot (if configured)
 * 10. Initialize scheduler
 * 11. Register signal handlers
 * 12. Start bots
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, PROJECT_ROOT, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { initDatabase, closeDatabase, getUnembeddedMemoryCount } from './db.js';
import { initBuiltinSkills } from './skills.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';
import { ProviderRouter } from './providers/router.js';
import { initScheduler } from './scheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PID_FILE = resolve(STORE_DIR, 'clauded.pid');

// ── PID Lock ─────────────────────────────────────────────────

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      // Check if the old process is still running
      process.kill(Number(oldPid), 0);
      logger.error(
        { pid: oldPid },
        'Another clauded instance is running. Remove store/clauded.pid if stale.',
      );
      process.exit(1);
    } catch {
      // Process not running — stale PID file, safe to overwrite
      logger.warn({ stalePid: oldPid }, 'Removing stale PID file');
    }
  }

  writeFileSync(PID_FILE, String(process.pid));
  logger.debug({ pid: process.pid }, 'PID lock acquired');
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      const storedPid = readFileSync(PID_FILE, 'utf-8').trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Show banner
  const bannerPath = resolve(PROJECT_ROOT, 'banner.txt');
  if (existsSync(bannerPath)) {
    const banner = readFileSync(bannerPath, 'utf-8');
    console.log(banner);
  }

  // 2. Validate required config
  if (!config.TELEGRAM_BOT_TOKEN && !config.MATRIX_HOMESERVER) {
    logger.fatal(
      'No messaging platform configured. Set TELEGRAM_BOT_TOKEN or MATRIX_HOMESERVER in .env',
    );
    process.exit(1);
  }

  // 3. Acquire PID lock
  acquireLock();

  // 4. Initialize database
  initDatabase();
  logger.info('Database initialized');

  // 4b. Initialize skills
  initBuiltinSkills();

  // 4d. Register builtin tools and load user tools
  const { registerBuiltinTools } = await import('./providers/tools/index.js');
  const { loadUserTools } = await import('./forge/tool-registry.js');
  registerBuiltinTools();
  loadUserTools();

  // 4c. Check for unembedded memories
  const unembedded = getUnembeddedMemoryCount();
  if (unembedded > 0) {
    logger.warn(
      { count: unembedded },
      'Memories without embeddings found. Run: npx tsx scripts/backfill-embeddings.ts',
    );
  }

  // 5. Run memory decay sweep + schedule recurring sweep
  runDecaySweep();
  const decayInterval = setInterval(() => {
    runDecaySweep();
  }, DAY_MS);

  // 6. Clean up old uploads
  const deletedUploads = cleanupOldUploads();
  if (deletedUploads > 0) {
    logger.info({ deleted: deletedUploads }, 'Cleaned up old uploads');
  }

  // 7. Initialize provider router
  const router = new ProviderRouter();
  logger.info({ defaultProvider: config.AI_PROVIDER }, 'Provider router initialized');

  // Track cleanup functions for graceful shutdown
  const cleanups: Array<() => void> = [];

  // 8. Create Telegram bot (if configured)
  let telegramBot: Awaited<ReturnType<typeof import('./platforms/telegram.js').createTelegramBot>> | undefined;
  if (config.TELEGRAM_BOT_TOKEN) {
    const { createTelegramBot } = await import('./platforms/telegram.js');
    telegramBot = createTelegramBot(router);
    logger.info('Telegram bot created');
  }

  // 9. Create Matrix bot (if configured)
  let matrixClient: Awaited<ReturnType<typeof import('./platforms/matrix.js').createMatrixBot>> | undefined;
  if (config.MATRIX_HOMESERVER && config.MATRIX_ACCESS_TOKEN) {
    const { createMatrixBot } = await import('./platforms/matrix.js');
    matrixClient = await createMatrixBot(router);
    logger.info('Matrix bot created');
  }

  // 10. Initialize scheduler with dual-platform notification callback
  const notifyFn = async (chatId: string, text: string): Promise<void> => {
    // Matrix room IDs start with '!' — route to Matrix
    if (chatId.startsWith('!') && matrixClient) {
      const { formatForMatrix } = await import('./platforms/matrix.js');
      const html = formatForMatrix(text);
      await matrixClient.sendMessage(chatId, {
        msgtype: 'm.notice',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: html,
      });
    } else if (telegramBot) {
      // Telegram chat IDs are numeric
      const { formatForTelegram, splitMessage } = await import('./platforms/telegram.js');
      const formatted = formatForTelegram(text);
      const chunks = splitMessage(formatted);
      for (const chunk of chunks) {
        await telegramBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }
    }
  };
  const stopScheduler = initScheduler(router, notifyFn);
  cleanups.push(stopScheduler);

  // 11. Register signal handlers for graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down clauded...');

    // Stop scheduler
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* best-effort */ }
    }

    // Stop decay interval
    clearInterval(decayInterval);

    // Stop Telegram bot
    if (telegramBot) {
      try {
        await telegramBot.stop();
        logger.info('Telegram bot stopped');
      } catch { /* best-effort */ }
    }

    // Stop Matrix client
    if (matrixClient) {
      try {
        matrixClient.stop();
        logger.info('Matrix bot stopped');
      } catch { /* best-effort */ }
    }

    // Close database
    closeDatabase();
    logger.info('Database closed');

    // Release PID lock
    releaseLock();

    logger.info('clauded stopped. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 12. Start bots
  if (telegramBot) {
    telegramBot.start({
      onStart: (botInfo) => {
        logger.info(
          { username: botInfo.username },
          'Telegram bot started',
        );
      },
    });
  }

  if (matrixClient) {
    await matrixClient.start();
    logger.info('Matrix bot started');
  }

  // Log final startup summary
  const platforms: string[] = [];
  if (telegramBot) platforms.push('Telegram');
  if (matrixClient) platforms.push('Matrix');

  logger.info(
    {
      pid: process.pid,
      platforms,
      provider: config.AI_PROVIDER,
      node: process.version,
    },
    'clauded is running',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'clauded failed to start');
  releaseLock();
  process.exit(1);
});
