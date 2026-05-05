/**
 * Application — the orchestration core of Luna.
 *
 * Composes subsystems via typed registration, manages lifecycle (startup/shutdown),
 * and provides the unified notification channel for autonomous behavior.
 *
 * This replaces the imperative startup sequence in src/index.ts with a
 * declarative, registry-based architecture.
 */

import { logger } from '../logger.js';
import type { ProviderRouter } from '../providers/router.js';
import type {
  StorageProvider,
  MemoryProvider,
  ToolProvider,
  PackProvider,
  Platform,
  Subsystem,
} from './interfaces.js';

export class Application {
  // ── Registered components ──────────────────────────────────

  private _storage: StorageProvider | null = null;
  private _platforms: Platform[] = [];
  private _subsystems: Subsystem[] = [];
  private _cleanups: Array<() => void | Promise<void>> = [];

  // ── Provider slots ─────────────────────────────────────────

  /** AI provider router (Claude + Ollama) */
  public router: ProviderRouter | null = null;
  /** Memory subsystem */
  public memory: MemoryProvider | null = null;
  /** Tool registry and executor */
  public tools: ToolProvider | null = null;
  /** Domain pack system */
  public packs: PackProvider | null = null;

  // ── Lifecycle state ────────────────────────────────────────

  private _started = false;
  private _shuttingDown = false;

  // ── Registration ───────────────────────────────────────────

  /**
   * Register the storage provider. Must be called before startup.
   * Only one storage provider is supported.
   */
  registerStorage(storage: StorageProvider): void {
    if (this._storage) {
      throw new Error('StorageProvider already registered');
    }
    this._storage = storage;
  }

  /**
   * Register a messaging platform (Telegram, Matrix, Web).
   * Platforms provide canHandle() + notify() for outbound routing.
   */
  registerPlatform(platform: Platform): void {
    this._platforms.push(platform);
    logger.debug({ platform: platform.name }, 'Platform registered');
  }

  /**
   * Register a subsystem with lifecycle hooks.
   * If the subsystem has a tables property, it's automatically registered
   * with the StorageProvider for table initialization.
   */
  registerSubsystem(subsystem: Subsystem): void {
    this._subsystems.push(subsystem);

    // Auto-register table initializer if provided
    if (subsystem.tables && this._storage) {
      this._storage.registerTables(subsystem.tables);
    }

    logger.debug({ subsystem: subsystem.name }, 'Subsystem registered');
  }

  /**
   * Add a cleanup function to be called during shutdown.
   * For interval timers, event listeners, and other resources.
   */
  addCleanup(fn: () => void | Promise<void>): void {
    this._cleanups.push(fn);
  }

  // ── Notification (Jarvis outbound channel) ─────────────────

  /**
   * Send a notification to a user through the appropriate platform.
   *
   * This is the unified outbound channel for all autonomous features:
   * scheduler, proactive messaging, order alerts, shortage warnings, etc.
   * Routes to the platform where canHandle(chatId) returns true.
   *
   * @returns true if a platform handled the message, false if no platform matched
   */
  async notify(chatId: string, text: string): Promise<boolean> {
    for (const platform of this._platforms) {
      if (platform.canHandle(chatId)) {
        try {
          await platform.notify(chatId, text);
          return true;
        } catch (err) {
          logger.warn(
            { err, platform: platform.name, chatId },
            'Platform notification failed',
          );
          return false;
        }
      }
    }

    logger.warn({ chatId }, 'No platform can handle notification for chatId');
    return false;
  }

  // ── Accessors ──────────────────────────────────────────────

  get storage(): StorageProvider {
    if (!this._storage) throw new Error('StorageProvider not registered');
    return this._storage;
  }

  get platforms(): readonly Platform[] {
    return this._platforms;
  }

  get subsystems(): readonly Subsystem[] {
    return this._subsystems;
  }

  get started(): boolean {
    return this._started;
  }

  // ── Startup ────────────────────────────────────────────────

  /**
   * Start the application.
   *
   * Lifecycle order:
   * 1. Storage: init() + initAllTables()
   * 2. Subsystems: init() in registration order
   * 3. Subsystems: setup(app) — active subsystems receive app reference
   * 4. Platforms: start() — messaging channels open
   */
  async startup(): Promise<void> {
    if (this._started) {
      throw new Error('Application already started');
    }

    if (!this._storage) {
      throw new Error('Cannot start: no StorageProvider registered');
    }

    // 1. Initialize storage
    this._storage.init();
    await this._storage.initAllTables();
    logger.info('Storage initialized');

    // 2. Initialize subsystems (DB is ready, tables exist)
    for (const subsystem of this._subsystems) {
      if (subsystem.init) {
        await subsystem.init();
        logger.debug({ subsystem: subsystem.name }, 'Subsystem initialized');
      }
    }

    // 3. Setup phase — active subsystems receive app reference for autonomous behavior
    for (const subsystem of this._subsystems) {
      if (subsystem.setup) {
        await subsystem.setup(this);
        logger.debug({ subsystem: subsystem.name }, 'Subsystem setup complete');
      }
    }

    // 4. Start platforms
    for (const platform of this._platforms) {
      await platform.start();
      logger.info({ platform: platform.name }, 'Platform started');
    }

    this._started = true;
    logger.info(
      {
        platforms: this._platforms.map((p) => p.name),
        subsystems: this._subsystems.map((s) => s.name),
      },
      'Application started',
    );
  }

  // ── Shutdown ───────────────────────────────────────────────

  /**
   * Gracefully shut down the application.
   *
   * Shutdown order (reverse of startup):
   * 1. Stop platforms
   * 2. Run cleanup functions
   * 3. Shutdown subsystems (reverse registration order)
   * 4. Close storage
   */
  async shutdown(signal?: string): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    logger.info({ signal }, 'Shutting down Luna...');

    // 1. Stop platforms
    for (const platform of this._platforms) {
      try {
        await platform.stop();
        logger.info({ platform: platform.name }, 'Platform stopped');
      } catch (err) {
        logger.warn({ err, platform: platform.name }, 'Platform stop failed');
      }
    }

    // 2. Run cleanup functions
    for (const cleanup of this._cleanups) {
      try {
        await cleanup();
      } catch {
        // Best-effort cleanup
      }
    }

    // 3. Shutdown subsystems in reverse order
    for (const subsystem of [...this._subsystems].reverse()) {
      if (subsystem.shutdown) {
        try {
          await subsystem.shutdown();
          logger.debug({ subsystem: subsystem.name }, 'Subsystem shut down');
        } catch (err) {
          logger.warn({ err, subsystem: subsystem.name }, 'Subsystem shutdown failed');
        }
      }
    }

    // 4. Close storage
    if (this._storage) {
      try {
        this._storage.close();
        logger.info('Storage closed');
      } catch (err) {
        logger.warn({ err }, 'Storage close failed');
      }
    }

    this._started = false;
    logger.info('Luna stopped. Goodbye.');
  }

  // ── Signal Handlers ────────────────────────────────────────

  /**
   * Register process signal handlers for graceful shutdown.
   * Call this after startup.
   */
  registerSignalHandlers(): void {
    const handler = (signal: string) => {
      this.shutdown(signal).then(() => process.exit(0));
    };

    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));

    // Surface unhandled errors instead of letting Node print them to stderr
    // and exit silently. Both routes through the structured logger so the
    // failure shows up in shipped log streams; we keep running because in
    // production a single rogue rejection should not take the whole bot down.
    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
      const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      logger.error({ reason: msg, promise: String(promise) }, 'Unhandled promise rejection');
    });
    process.on('uncaughtException', (err: Error) => {
      logger.fatal({ err: err.stack ?? err.message }, 'Uncaught exception — shutting down');
      this.shutdown('uncaughtException').finally(() => process.exit(1));
    });
  }
}
