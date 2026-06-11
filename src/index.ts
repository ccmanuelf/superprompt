#!/usr/bin/env node
/**
 * Luna (Inge Luna) — Personal AI Assistant Daemon
 *
 * Entry point. Composes subsystems via the Application core and manages lifecycle.
 *
 * Startup sequence:
 * 1. Show banner
 * 2. Validate required config
 * 3. Run rebrand data-file migration (rc.85; see src/migrations/)
 * 4. Acquire PID lock
 * 5. Create Application + register storage, table initializers, subsystems, platforms
 * 6. app.startup() — init storage → init tables → init subsystems → setup (autonomous) → start platforms
 * 7. Register signal handlers
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, PROJECT_ROOT, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { createStorageProvider, getUnembeddedMemoryCount } from './db-core.js';
import { Application } from './core/app.js';
import { migrateRebrandDataFiles } from './migrations/rebrand-data-files.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PID_FILE = resolve(STORE_DIR, 'luna.pid');

// ── PID Lock ─────────────────────────────────────���───────────

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(Number(oldPid), 0);
      logger.error(
        { pid: oldPid },
        'Another Luna instance is running. Remove store/luna.pid if stale.',
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
  // A short legacy token defeats the web auth rate limiter by brute force.
  if (config.VOICE_WEB_PORT && config.VOICE_WEB_TOKEN && config.VOICE_WEB_TOKEN.length < 16) {
    logger.fatal(
      'VOICE_WEB_TOKEN is set but shorter than 16 characters. Use a long random token (or unset it and use per-user /webtoken tokens).',
    );
    process.exit(1);
  }

  // 3. Rebrand migration (rc.85): rename legacy data files to luna.*.
  // Must run BEFORE acquireLock() and BEFORE any DB open, so an upgraded instance
  // finds its data under the new name on first boot. See
  // src/migrations/rebrand-data-files.ts for the file-level mapping.
  mkdirSync(STORE_DIR, { recursive: true });
  migrateRebrandDataFiles(STORE_DIR, logger);

  // 4. Acquire PID lock
  acquireLock();

  // 4. Create Application and register all components
  const app = new Application();

  // ── Storage (Knex — supports SQLite/MariaDB/PostgreSQL via DB_DRIVER) ──
  const storage = createStorageProvider();
  app.registerStorage(storage);

  // ── Table initializers (core subsystems) ──
  const { coreTableInit } = await import('./db-core.js');
  const { learningTableInit } = await import('./learning/db.js');
  const { citationTableInit } = await import('./citations.js');
  const { kanbanTableInit } = await import('./kanban.js');

  storage.registerTables(coreTableInit); // sessions, memories, episodes, skills, tools, tasks
  storage.registerTables(learningTableInit);
  storage.registerTables(citationTableInit);
  storage.registerTables(kanbanTableInit);

  // ── Manufacturing pack (Level 3 — owns 15 domain modules) ──
  const manufacturingPack = await import('./packs/manufacturing/index.js');
  storage.registerTables(manufacturingPack.tableInit);

  // Auto-skills tables (skill_triggers, skill_proposals)
  const { autoSkillsTableInit } = await import('./auto-skills.js');
  storage.registerTables(autoSkillsTableInit);

  // Policy engine tables (tool_trust)
  const { policyTableInit } = await import('./policy-engine.js');
  storage.registerTables(policyTableInit);

  // Pack subscription tables
  const { packSubscriptionTableInit } = await import('./packs.js');
  storage.registerTables(packSubscriptionTableInit);

  // Attendance reconciliation (rc.88, Phase A) — sites, modules, shifts,
  // breaks, absence codes, data-source config, employees, badge records,
  // attendance records, report snapshots, ingestion reports.
  const { attendanceTableInit } = await import('./attendance/schema.js');
  storage.registerTables(attendanceTableInit);

  // rc.92 — feature-awareness registrations. Side-effect imports only.
  // Each feature module self-registers with the feature-awareness
  // registry on load; capabilities.ts / web-ui-guide.ts / telegram-help
  // all read from that registry. Missing an import here means the
  // feature ships without Luna knowing — the test in
  // tests/feature-awareness-registry.test.ts catches that case at CI.
  await import('./attendance/awareness.js');

  // Guardrails tables (permanent learned constraints)
  const { guardrailsTableInit } = await import('./guardrails.js');
  storage.registerTables(guardrailsTableInit);

  // Pack tuner tables (self-tuning pack weights)
  const packTunerMod = await import('./pack-tuner.js');
  storage.registerTables(packTunerMod.packTunerTableInit);

  // Web tokens tables (per-user auth for web UIs)
  const { webTokenTableInit } = await import('./web/web-tokens.js');
  storage.registerTables(webTokenTableInit);

  // Event triggers tables (reactive autonomy)
  const { eventTriggerTableInit } = await import('./event-triggers.js');
  storage.registerTables(eventTriggerTableInit);

  // rc.95 — provider usage observability (api_usage). Counts user turns
  // per provider per month so /usage can show local-handled percentage.
  const { apiUsageTableInit } = await import('./usage.js');
  storage.registerTables(apiUsageTableInit);

  // rc.98 — forge eval pipeline (Phase 1). Tables: forge_evals,
  // forge_eval_runs, forge_eval_assertions. See
  // docs/SKILL_CREATOR_V2_INTEGRATION.md for the 4-phase plan.
  const { evalTableInit } = await import('./forge/eval/index.js');
  storage.registerTables(evalTableInit);

  // rc.100 — dual-view calculation architecture, Phase 2. Tables:
  // luna_assumptions, luna_assumption_changes,
  // luna_metric_assumption_dependencies. See
  // docs/audit/calculation-modules-audit.md.
  const { assumptionsTableInit } = await import('./assumptions.js');
  storage.registerTables(assumptionsTableInit);

  // Wire pack tuner into pack intent scoring
  const { setPackTunerModule } = await import('./packs.js');
  setPackTunerModule({ applyTunedWeight: packTunerMod.applyTunedWeight });

  // ── Subsystems ───────────────────────────────────────────

  // Skills subsystem — creates builtin skills on init
  const { initBuiltinSkills } = await import('./skills.js');
  app.registerSubsystem({
    name: 'skills',
    init: () => initBuiltinSkills(),
  });

  // Tool registry — registers builtin tools, loads user tools, auto-imports forge, loads packs
  const { registerBuiltinTools, createToolProvider } = await import('./providers/tools/index.js');
  const { loadUserTools } = await import('./forge/tool-registry.js');
  const { autoImportForge } = await import('./forge/auto-import.js');
  const { loadAllPacks, createPackProvider } = await import('./packs.js');

  app.registerSubsystem({
    name: 'tools',
    init: async () => {
      registerBuiltinTools();
      // Register manufacturing pack tools (SA5 — Level 3 pack)
      manufacturingPack.registerTools();
      loadUserTools();

      // Auto-import skills & tools from forge/ directory
      autoImportForge();
      loadUserTools(); // reload after auto-import

      // Load domain packs
      const packList = await loadAllPacks();
      if (packList.length > 0) {
        logger.info({ packs: packList.map((p) => p.name) }, 'Domain packs loaded');
        loadUserTools(); // reload after pack import
      }

      // Register typed providers on the application
      app.tools = createToolProvider();
      app.packs = createPackProvider();
    },
  });

  // Memory subsystem — decay sweep + recurring interval
  const { runDecaySweep, createMemoryProvider } = await import('./memory.js');
  let decayInterval: ReturnType<typeof setInterval>;

  app.registerSubsystem({
    name: 'memory',
    init: async () => {
      // Check for unembedded memories
      const unembedded = await getUnembeddedMemoryCount();
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

      // Register typed provider on the application
      app.memory = createMemoryProvider();
    },
    shutdown: () => {
      clearInterval(decayInterval);
    },
  });

  // Recent calculation results (rc.100 /explain) — periodic sweep so idle
  // chatIds don't keep stale entries in the in-memory map forever.
  const { startRecentResultsSweep, stopRecentResultsSweep } = await import('./calculations/recent-results.js');
  app.registerSubsystem({
    name: 'recent-results-sweep',
    init: () => {
      startRecentResultsSweep();
    },
    shutdown: () => {
      stopRecentResultsSweep();
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

  // Initialize event trigger system (reactive autonomy)
  const { initEventSystem } = await import('./event-triggers.js');
  initEventSystem(router, async (chatId, text) => {
    await app.notify(chatId, text);
  });

  // Initialize background task queue
  const { initBackgroundTasks } = await import('./background-tasks.js');
  initBackgroundTasks(async (chatId, text) => {
    await app.notify(chatId, text);
  });

  // ── Child Processes (SA3: Process Separation) ─────────────
  const { ProcessClient } = await import('./ipc/client.js');
  const { TOOLS_PROCESS_ENV, PARSERS_PROCESS_ENV } = await import('./ipc/env-whitelist.js');
  const { setProcessClients } = await import('./providers/tools/index.js');

  app.registerSubsystem({
    name: 'tools-process',
    setup: async () => {
      const toolsClient = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      const parsersClient = new ProcessClient('parsers', 'dist/parsers-process.js', PARSERS_PROCESS_ENV);

      try {
        await toolsClient.spawn();
        logger.info('Tools process (P2) spawned');
      } catch (err) {
        logger.warn({ err }, 'Tools process (P2) failed to start — tools will execute locally');
      }

      try {
        await parsersClient.spawn();
        logger.info('Parsers process (P3) spawned');
      } catch (err) {
        logger.warn({ err }, 'Parsers process (P3) failed to start — parsers will execute locally');
      }

      // Wire IPC clients into tool execution routing
      setProcessClients(
        toolsClient.isReady ? toolsClient : null,
        parsersClient.isReady ? parsersClient : null,
      );

      // Sync user tools to Process 2
      if (toolsClient.isReady) {
        const userTools = await (await import('./db-core.js')).listUserTools();
        for (const tool of userTools) {
          if (!tool.enabled) continue;
          const config = JSON.parse(tool.config);
          toolsClient.registerUserTool(
            tool.name,
            tool.description,
            { type: 'function', function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: {}, required: [] } } },
            tool.tool_type as 'declarative_http' | 'generated_code',
            tool.config,
          );
        }
      }

      app.addCleanup(async () => {
        await toolsClient.shutdown();
        await parsersClient.shutdown();
      });
    },
  });

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

  // ── Platform Context ──────────────────────────────────────
  // Build the context facade that platforms use to access all subsystems
  const { buildPlatformContext } = await import('./core/context.js');
  const ctx = await buildPlatformContext(router);

  // ── Platforms ────────────────────────────────────────────

  // Telegram
  if (config.TELEGRAM_BOT_TOKEN) {
    const { createTelegramBot, formatForTelegram, splitMessage } = await import('./platforms/telegram.js');
    const bot = createTelegramBot(ctx);

    /**
     * Send a Telegram message with 429 (TooManyRequests) handling. Telegram's
     * global rate limit is ~30msg/sec; bursts of proactive notifications,
     * digests, or task-completion broadcasts can hit it. grammy v1.42 raises
     * a `GrammyError` with `error_code === 429` and a `parameters.retry_after`
     * (seconds) value — we honor that, capped at 3 attempts so we never block
     * the notify pipeline forever.
     */
    const sendWithRetry = async (chatId: string, text: string): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
          return;
        } catch (err) {
          const e = err as { error_code?: number; parameters?: { retry_after?: number } };
          if (e?.error_code === 429 && attempt < 2) {
            const retryAfterSec = Math.max(1, Math.min(e.parameters?.retry_after ?? 1, 30));
            logger.warn({ chatId, attempt: attempt + 1, retryAfterSec }, 'Telegram 429 — backing off before retry');
            await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
            continue;
          }
          throw err;
        }
      }
    };

    app.registerPlatform({
      name: 'telegram',
      canHandle: (chatId: string) => !chatId.startsWith('!'),
      notify: async (chatId: string, text: string) => {
        const formatted = formatForTelegram(text);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          await sendWithRetry(chatId, chunk);
        }
      },
      start: async () => {
        if (config.TELEGRAM_WEBHOOK_URL) {
          // Webhook mode — production (requires HTTPS via Caddy)
          const webhookUrl = config.TELEGRAM_WEBHOOK_URL;
          const secret = (config.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
          if (!secret) {
            throw new Error(
              'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is set. '
              + 'An empty secret disables Telegram payload verification and lets any caller forge updates.',
            );
          }

          // Register webhook handler on the web server
          const { webhookCallback } = await import('grammy');
          const { registerWebhookHandler } = await import('./web/server.js');
          const webhookPath = new URL(webhookUrl).pathname;
          const callback = webhookCallback(bot, 'http', { secretToken: secret });
          registerWebhookHandler(webhookPath, async (req, res) => {
            await callback(req, res);
          });

          await bot.api.setWebhook(webhookUrl, {
            secret_token: secret,
            drop_pending_updates: true,
          });
          logger.info({ webhookUrl, webhookPath }, 'Telegram bot started (webhook mode)');
        } else {
          // Long-polling mode — development
          bot.start({
            onStart: (botInfo) => {
              logger.info({ username: botInfo.username }, 'Telegram bot started (polling mode)');
            },
          });
        }
      },
      stop: async () => {
        if (config.TELEGRAM_WEBHOOK_URL) {
          await bot.api.deleteWebhook();
        }
        await bot.stop();
        logger.info('Telegram bot stopped');
      },
    });
  }

  // Matrix
  if (config.MATRIX_HOMESERVER && config.MATRIX_ACCESS_TOKEN) {
    const { createMatrixBot, formatForMatrix } = await import('./platforms/matrix.js');
    const matrixClient = await createMatrixBot(ctx);

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
    'Luna is running',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'Luna failed to start');
  releaseLock();
  process.exit(1);
});
