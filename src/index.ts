#!/usr/bin/env node
/**
 * clauded — Personal AI Assistant Daemon
 *
 * Entry point. Composes subsystems via the Application core and manages lifecycle.
 *
 * Startup sequence:
 * 1. Show banner
 * 2. Validate required config
 * 3. Acquire PID lock
 * 4. Create Application + register storage, table initializers, subsystems, platforms
 * 5. app.startup() — init storage → init tables → init subsystems → setup (autonomous) → start platforms
 * 6. Register signal handlers
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, PROJECT_ROOT, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { createStorageProvider, getUnembeddedMemoryCount } from './db.js';
import { Application } from './core/app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PID_FILE = resolve(STORE_DIR, 'clauded.pid');

// ── PID Lock ─────────────────────────────────────���───────────

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(Number(oldPid), 0);
      logger.error(
        { pid: oldPid },
        'Another clauded instance is running. Remove store/clauded.pid if stale.',
      );
      process.exit(1);
    } catch {
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

  // 4. Create Application and register all components
  const app = new Application();

  // ── Storage ──────────────────────────────────────────────
  const storage = createStorageProvider();
  app.registerStorage(storage);

  // ── Table initializers (domain subsystems register their DB schemas) ──
  const { learningTableInit } = await import('./learning/db.js');
  const { citationTableInit } = await import('./citations.js');
  const { balanceTableInit } = await import('./balance.js');
  const { sigmaTableInit } = await import('./sigma.js');
  const { inventoryTableInit } = await import('./inventory.js');
  const { controlPlanTableInit } = await import('./control-plan.js');
  const { fmeaTableInit } = await import('./fmea.js');
  const { rcaTableInit } = await import('./rca.js');
  const { kanbanTableInit } = await import('./kanban.js');
  const { simulationTableInit } = await import('./simulation/index.js');
  const { capacityTableInit } = await import('./capacity/index.js');
  const { sequencerTableInit } = await import('./sequencer/index.js');
  const { vsmTableInit } = await import('./vsm/index.js');
  const { tocTableInit } = await import('./toc/index.js');
  const { conwipTableInit } = await import('./conwip/index.js');
  const { doeTableInit } = await import('./doe/index.js');
  const { fsmTableInit } = await import('./fsm/index.js');

  storage.registerTables(learningTableInit);
  storage.registerTables(citationTableInit);
  storage.registerTables(balanceTableInit);
  storage.registerTables(sigmaTableInit);
  storage.registerTables(inventoryTableInit);
  storage.registerTables(controlPlanTableInit);
  storage.registerTables(fmeaTableInit);
  storage.registerTables(rcaTableInit);
  storage.registerTables(kanbanTableInit);
  storage.registerTables(simulationTableInit);
  storage.registerTables(capacityTableInit);
  storage.registerTables(sequencerTableInit);
  storage.registerTables(vsmTableInit);
  storage.registerTables(tocTableInit);
  storage.registerTables(conwipTableInit);
  storage.registerTables(doeTableInit);
  storage.registerTables(fsmTableInit);

  // ── Subsystems ───────────────────────────────────────────

  // Skills subsystem — creates builtin skills on init
  const { initBuiltinSkills } = await import('./skills.js');
  app.registerSubsystem({
    name: 'skills',
    init: () => initBuiltinSkills(),
  });

  // Tool registry — registers builtin tools, loads user tools, auto-imports forge, loads packs
  const { registerBuiltinTools } = await import('./providers/tools/index.js');
  const { loadUserTools } = await import('./forge/tool-registry.js');
  const { autoImportForge } = await import('./forge/auto-import.js');
  const { loadAllPacks } = await import('./packs.js');

  app.registerSubsystem({
    name: 'tools',
    init: () => {
      registerBuiltinTools();
      loadUserTools();

      // Auto-import skills & tools from forge/ directory
      autoImportForge();
      loadUserTools(); // reload after auto-import

      // Load domain packs
      const packList = loadAllPacks();
      if (packList.length > 0) {
        logger.info({ packs: packList.map((p) => p.name) }, 'Domain packs loaded');
        loadUserTools(); // reload after pack import
      }
    },
  });

  // Memory subsystem — decay sweep + recurring interval
  const { runDecaySweep } = await import('./memory.js');
  let decayInterval: ReturnType<typeof setInterval>;

  app.registerSubsystem({
    name: 'memory',
    init: () => {
      // Check for unembedded memories
      const unembedded = getUnembeddedMemoryCount();
      if (unembedded > 0) {
        logger.warn(
          { count: unembedded },
          'Memories without embeddings found. Run: npx tsx scripts/backfill-embeddings.ts',
        );
      }

      // Run initial decay sweep (fire-and-forget)
      runDecaySweep().catch((err) => logger.warn({ err }, 'Initial decay sweep failed'));

      // Schedule recurring sweep
      decayInterval = setInterval(() => {
        runDecaySweep().catch((err) => logger.warn({ err }, 'Decay sweep failed'));
      }, DAY_MS);
    },
    shutdown: () => {
      clearInterval(decayInterval);
    },
  });

  // Media cleanup
  const { cleanupOldUploads } = await import('./media.js');
  app.registerSubsystem({
    name: 'media',
    init: () => {
      const deleted = cleanupOldUploads();
      if (deleted > 0) {
        logger.info({ deleted }, 'Cleaned up old uploads');
      }
    },
  });

  // Provider router
  const { ProviderRouter } = await import('./providers/router.js');
  const router = new ProviderRouter();
  app.router = router;
  logger.info({ defaultProvider: config.AI_PROVIDER }, 'Provider router initialized');

  // Scheduler — active subsystem, needs app.notify() for autonomous task execution
  const { initScheduler } = await import('./scheduler.js');
  app.registerSubsystem({
    name: 'scheduler',
    setup: (appRef) => {
      const notifyFn = async (chatId: string, text: string) => {
        await appRef.notify(chatId, text);
      };
      const stopScheduler = initScheduler(router, notifyFn);
      appRef.addCleanup(stopScheduler);
    },
  });

  // Proactive messaging — active subsystem, needs app.notify() for follow-ups and digests
  const { initProactiveMessaging } = await import('./proactive.js');
  app.registerSubsystem({
    name: 'proactive',
    setup: (appRef) => {
      const notifyFn = async (chatId: string, text: string) => {
        await appRef.notify(chatId, text);
      };
      const stopProactive = initProactiveMessaging(notifyFn, router);
      appRef.addCleanup(stopProactive);
    },
  });

  // Learning session cleanup
  const { initSessionCleanup } = await import('./learning/session.js');
  app.registerSubsystem({
    name: 'learning',
    setup: () => {
      const stopSessionCleanup = initSessionCleanup();
      app.addCleanup(stopSessionCleanup);
    },
  });

  // ── Platforms ────────────────────────────────────────────

  // Telegram
  if (config.TELEGRAM_BOT_TOKEN) {
    const { createTelegramBot, formatForTelegram, splitMessage } = await import('./platforms/telegram.js');
    const bot = createTelegramBot(router);

    app.registerPlatform({
      name: 'telegram',
      canHandle: (chatId: string) => !chatId.startsWith('!'),
      notify: async (chatId: string, text: string) => {
        const formatted = formatForTelegram(text);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        }
      },
      start: async () => {
        bot.start({
          onStart: (botInfo) => {
            logger.info({ username: botInfo.username }, 'Telegram bot started');
          },
        });
      },
      stop: async () => {
        await bot.stop();
        logger.info('Telegram bot stopped');
      },
    });
  }

  // Matrix
  if (config.MATRIX_HOMESERVER && config.MATRIX_ACCESS_TOKEN) {
    const { createMatrixBot, formatForMatrix } = await import('./platforms/matrix.js');
    const matrixClient = await createMatrixBot(router);

    app.registerPlatform({
      name: 'matrix',
      canHandle: (chatId: string) => chatId.startsWith('!'),
      notify: async (chatId: string, text: string) => {
        const html = formatForMatrix(text);
        await matrixClient.sendMessage(chatId, {
          msgtype: 'm.notice',
          body: text,
          format: 'org.matrix.custom.html',
          formatted_body: html,
        });
      },
      start: async () => {
        await matrixClient.start();
        logger.info('Matrix bot started');
      },
      stop: async () => {
        matrixClient.stop();
        logger.info('Matrix bot stopped');
      },
    });
  }

  // Voice web server — starts during setup phase (after DB and tools are ready)
  if (config.VOICE_WEB_PORT) {
    app.registerSubsystem({
      name: 'voice-web',
      setup: async () => {
        const { startVoiceWebServer } = await import('./web/server.js');
        const voiceWeb = startVoiceWebServer(router);
        app.addCleanup(() => voiceWeb.close());
      },
    });
  }

  // 5. Start the application
  await app.startup();

  // 6. Register signal handlers
  app.registerSignalHandlers();
  // Also release PID lock on shutdown
  app.addCleanup(() => releaseLock());

  // Log final startup summary
  logger.info(
    {
      pid: process.pid,
      platforms: app.platforms.map((p) => p.name),
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
