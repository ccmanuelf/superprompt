/**
 * IPC Client — Process 1 side.
 *
 * Manages child process lifecycle (spawn, health check, restart)
 * and provides async tool execution via IPC.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { logger } from '../logger.js';
import { getTraceId } from '../trace.js';
import { buildChildEnv } from './env-whitelist.js';
import type { ParentMessage, ChildMessage } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default timeout for a single tool execution request */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Heartbeat interval */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** Heartbeat timeout — if no pong within this period, mark unhealthy */
const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Max consecutive missed heartbeats before restart */
const MAX_MISSED_HEARTBEATS = 3;

/** Max restarts within the restart window */
const MAX_RESTARTS = 5;

/** Restart window (ms) */
const RESTART_WINDOW_MS = 60_000;

/** Delay before restart (ms) */
const RESTART_DELAY_MS = 1_000;

/** Shutdown grace period (ms) */
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProcessClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private _ready = false;
  private _shuttingDown = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  private restartTimestamps: number[] = [];

  constructor(
    private readonly processName: string,
    private readonly scriptPath: string,
    private readonly envWhitelist: string[],
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Spawn the child process and wait for the 'ready' message.
   */
  async spawn(): Promise<void> {
    if (this.child) return;

    const env = buildChildEnv(this.envWhitelist);
    const scriptAbsolute = this.scriptPath.startsWith('/')
      ? this.scriptPath
      : resolve(__dirname, '..', '..', this.scriptPath);

    this.child = fork(scriptAbsolute, [], {
      env,
      execArgv: [], // strip debug flags
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    // Forward child stdout/stderr to parent logger
    this.child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info({ process: this.processName }, msg);
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn({ process: this.processName }, msg);
    });

    // Handle messages from child
    this.child.on('message', (msg: ChildMessage) => {
      this.handleMessage(msg);
    });

    // Handle unexpected exit
    this.child.on('exit', (code, signal) => {
      this._ready = false;
      this.stopHeartbeat();

      if (!this._shuttingDown) {
        logger.warn(
          { process: this.processName, code, signal },
          'Child process exited unexpectedly',
        );
        this.rejectAllPending(`${this.processName} process crashed (code ${code})`);
        this.scheduleRestart();
      }
    });

    // Wait for ready signal
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${this.processName} process did not send 'ready' within 10s`));
      }, 10_000);

      const onReady = (msg: ChildMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this._ready = true;
          this.startHeartbeat();
          logger.info(
            { process: this.processName, toolCount: msg.toolCount },
            'Child process ready',
          );
          resolveReady();
        }
      };

      // Temporarily listen for ready (the main handler also handles it)
      this.child!.once('message', onReady);
    });
  }

  /**
   * Gracefully shut down the child process.
   */
  async shutdown(): Promise<void> {
    if (!this.child || this._shuttingDown) return;
    this._shuttingDown = true;
    this.stopHeartbeat();

    // Send shutdown message
    this.send({ type: 'shutdown' });

    // Wait for exit or force kill
    await new Promise<void>((resolveShutdown) => {
      const timer = setTimeout(() => {
        if (this.child) {
          logger.warn({ process: this.processName }, 'Force-killing child process');
          this.child.kill('SIGKILL');
        }
        resolveShutdown();
      }, SHUTDOWN_TIMEOUT_MS);

      this.child!.once('exit', () => {
        clearTimeout(timer);
        resolveShutdown();
      });
    });

    this.rejectAllPending('Process shutting down');
    this.child = null;
    this._ready = false;
    logger.info({ process: this.processName }, 'Child process shut down');
  }

  // ── Tool Execution ─────────────────────────────────────────

  /**
   * Execute a tool in the child process via IPC.
   * Returns a promise that resolves with the tool result.
   */
  execute(
    tool: string,
    args: Record<string, unknown>,
    chatId: string,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!this._ready || !this.child) {
      return Promise.resolve({
        error: `[EN] ${this.processName} process is not available. Tool will execute locally as fallback. `
          + `[ES] El proceso ${this.processName} no esta disponible. La herramienta se ejecutara localmente como respaldo.`,
      });
    }

    const id = randomBytes(8).toString('hex');

    return new Promise((resolveRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveRequest({
          error: `[EN] Tool execution timed out in ${this.processName} process (${Math.round(timeoutMs / 1000)}s). `
            + `[ES] La ejecucion de la herramienta agoto el tiempo en el proceso ${this.processName} (${Math.round(timeoutMs / 1000)}s).`,
        });
      }, timeoutMs);

      this.pending.set(id, { resolve: resolveRequest, timer });

      this.send({
        type: 'execute_tool',
        id,
        tool,
        args,
        chatId,
        traceId: getTraceId(),
      });
    });
  }

  // ── User Tool Sync ─────────────────────────────────────────

  /**
   * Register a user tool in the child process.
   */
  registerUserTool(
    name: string,
    description: string,
    definition: import('ollama').Tool,
    toolType: 'declarative_http' | 'generated_code',
    config: string,
  ): void {
    this.send({
      type: 'register_user_tool',
      name,
      description,
      definition,
      toolType,
      config,
    });
  }

  /**
   * Unregister a user tool from the child process.
   */
  unregisterUserTool(name: string): void {
    this.send({ type: 'unregister_user_tool', name });
  }

  // ── Accessors ──────────────────────────────────────────────

  get isReady(): boolean {
    return this._ready;
  }

  get processName_(): string {
    return this.processName;
  }

  // ── Internal ───────────────────────────────────────────────

  private send(msg: ParentMessage): void {
    if (this.child?.connected) {
      this.child.send(msg);
    }
  }

  private handleMessage(msg: ChildMessage): void {
    switch (msg.type) {
      case 'result': {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve(msg.result);
        }
        break;
      }
      case 'error': {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve({ error: msg.error });
        }
        break;
      }
      case 'pong': {
        this.missedHeartbeats = 0;
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        break;
      }
      case 'ready': {
        this._ready = true;
        break;
      }
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;

    this.heartbeatInterval = setInterval(() => {
      if (!this.child?.connected) return;

      this.send({ type: 'ping' });

      this.heartbeatTimer = setTimeout(() => {
        this.missedHeartbeats++;
        logger.warn(
          { process: this.processName, missed: this.missedHeartbeats },
          'Missed heartbeat from child process',
        );

        if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          logger.error(
            { process: this.processName },
            'Child process unresponsive — killing and restarting',
          );
          this._ready = false;
          this.child?.kill('SIGKILL');
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Auto-Restart ───────────────────────────────────────────

  private scheduleRestart(): void {
    if (this._shuttingDown) return;

    // Check restart rate
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);

    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      logger.error(
        { process: this.processName, restarts: this.restartTimestamps.length },
        'Max restarts exceeded — giving up. Tools will execute locally.',
      );
      return;
    }

    this.restartTimestamps.push(now);

    setTimeout(async () => {
      if (this._shuttingDown) return;

      logger.info({ process: this.processName }, 'Restarting child process');
      this.child = null;
      this._ready = false;

      try {
        await this.spawn();
      } catch (err) {
        logger.error(
          { err, process: this.processName },
          'Failed to restart child process',
        );
      }
    }, RESTART_DELAY_MS);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ error: reason });
    }
    this.pending.clear();
  }
}
