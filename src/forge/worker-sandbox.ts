import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the compiled worker entry script.
 * Workers require actual .js files — they can't use vitest's TS transform.
 * When running from dist/ (production), __dirname is dist/forge/.
 * When running from src/ (vitest), we redirect to dist/forge/.
 */
const WORKER_ENTRY = __dirname.includes('/src/')
  ? resolve(__dirname, '..', '..', 'dist', 'forge', 'worker-entry.js')
  : resolve(__dirname, 'worker-entry.js');

/** Default base window — Worker killed if no heartbeat within this period */
const DEFAULT_BASE_TIMEOUT_MS = 30_000;

/** Default hard ceiling — Worker killed regardless of heartbeats */
const DEFAULT_MAX_TIMEOUT_MS = 360_000; // 6 minutes

/** Absolute maximum for _timeout override — 30 minutes */
const ABSOLUTE_CAP_MS = 1_800_000;

/** Default memory limit per Worker (MB) */
const DEFAULT_WORKER_MEMORY_MB = 64;

/** Maximum memory override via _memory_mb — 512 MB */
const MAX_WORKER_MEMORY_MB = 512;

function getBaseTimeoutMs(): number {
  const env = readEnvFile();
  const val = parseInt(env.TOOL_TIMEOUT_MS || '', 10);
  return val > 0 ? val : DEFAULT_BASE_TIMEOUT_MS;
}

function getMaxTimeoutMs(): number {
  const env = readEnvFile();
  const val = parseInt(env.TOOL_MAX_TIMEOUT_MS || '', 10);
  return val > 0 ? val : DEFAULT_MAX_TIMEOUT_MS;
}

export interface WorkerSandboxOptions {
  /** Override base timeout (ms). For testing. */
  baseTimeoutMs?: number;
  /** Override hard ceiling (ms). For testing. */
  maxTimeoutMs?: number;
  /** Override memory limit (MB). For testing. */
  memoryMb?: number;
}

/**
 * Execute user-generated code in an isolated Worker thread.
 *
 * Provides:
 * - V8 isolate (no shared memory with parent)
 * - Adaptive timeout with heartbeat (base window resets on activity)
 * - Hard ceiling (configurable, default 6 minutes)
 * - Conversational _timeout override (per-execution, capped at 30 minutes)
 * - Memory limit (64 MB per Worker)
 * - SSRF-safe fetch with auto-heartbeat
 */
export async function executeInWorker(
  code: string,
  args: Record<string, unknown>,
  options?: WorkerSandboxOptions,
): Promise<Record<string, unknown>> {
  // Extract reserved parameters before passing to user code
  const cleanArgs = { ...args };

  // _timeout (seconds) → hard ceiling override
  let userMaxOverride: number | undefined;
  if ('_timeout' in cleanArgs) {
    const raw = Number(cleanArgs._timeout);
    if (raw > 0) {
      userMaxOverride = Math.min(raw * 1000, ABSOLUTE_CAP_MS);
    }
    delete cleanArgs._timeout;
  }

  // _memory_mb → per-execution memory limit override
  let userMemoryMb: number | undefined;
  if ('_memory_mb' in cleanArgs) {
    const raw = Number(cleanArgs._memory_mb);
    if (raw > 0) {
      userMemoryMb = Math.min(Math.round(raw), MAX_WORKER_MEMORY_MB);
    }
    delete cleanArgs._memory_mb;
  }

  const defaultBaseMs = options?.baseTimeoutMs ?? getBaseTimeoutMs();
  const maxTimeoutMs = userMaxOverride ?? options?.maxTimeoutMs ?? getMaxTimeoutMs();
  const memoryMb = userMemoryMb ?? options?.memoryMb ?? DEFAULT_WORKER_MEMORY_MB;

  // When user explicitly requests more time via _timeout, also extend the base window.
  // Otherwise "try again with 10 minutes" still dies at the 30s rolling timer.
  const baseTimeoutMs = userMaxOverride && userMaxOverride > defaultBaseMs
    ? Math.min(userMaxOverride, maxTimeoutMs)
    : defaultBaseMs;

  return new Promise((resolvePromise) => {
    let settled = false;
    let rollingTimer: ReturnType<typeof setTimeout>;
    let absoluteTimer: ReturnType<typeof setTimeout>;

    const worker = new Worker(WORKER_ENTRY, {
      workerData: { code, args: cleanArgs },
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
      },
    });

    function finish(result: Record<string, unknown>): void {
      if (settled) return;
      settled = true;
      clearTimeout(rollingTimer);
      clearTimeout(absoluteTimer);
      worker.removeAllListeners();
      resolvePromise(result);
    }

    function onTimeout(elapsed: string, reason: string): void {
      worker.terminate().catch(() => {});
      finish({
        error: `[EN] Tool execution timed out after ${elapsed} (${reason}). `
          + 'If this tool needs more time, you can retry with a longer timeout '
          + 'by passing _timeout (in seconds) in the tool arguments. '
          + `[ES] La herramienta agoto el tiempo de ejecucion despues de ${elapsed} (${reason}). `
          + 'Si necesita mas tiempo, puedes reintentar con un tiempo mayor '
          + 'pasando _timeout (en segundos) en los argumentos de la herramienta.',
      });
    }

    // Rolling timer — resets on every heartbeat
    function resetRollingTimer(): void {
      clearTimeout(rollingTimer);
      rollingTimer = setTimeout(
        () => onTimeout(`${Math.round(baseTimeoutMs / 1000)}s`, 'no activity'),
        baseTimeoutMs,
      );
    }

    // Absolute timer — never resets
    absoluteTimer = setTimeout(
      () => onTimeout(`${Math.round(maxTimeoutMs / 1000)}s`, 'hard ceiling'),
      maxTimeoutMs,
    );

    // Start the rolling timer
    resetRollingTimer();

    worker.on('message', (msg: { type: string; success?: boolean; result?: unknown; error?: string }) => {
      if (msg.type === 'heartbeat') {
        resetRollingTimer();
        return;
      }

      if (msg.type === 'result') {
        if (msg.success) {
          const result = msg.result;
          finish(
            typeof result === 'object' && result !== null
              ? (result as Record<string, unknown>)
              : { result },
          );
        } else {
          finish({ error: msg.error || 'Unknown worker error' });
        }
      }
    });

    worker.on('error', (err) => {
      const isOOM = (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
        || err.message.includes('out of memory');

      if (isOOM) {
        const suggestedMb = Math.min(memoryMb * 2, MAX_WORKER_MEMORY_MB);
        logger.info({ memoryMb }, 'Worker hit memory limit — tool needs more memory or smaller batches');
        finish({
          error: `[EN] Tool ran out of memory (${memoryMb}MB limit). `
            + `You can retry with more memory by passing _memory_mb (e.g. _memory_mb: ${suggestedMb}) `
            + 'in the tool arguments, or the tool should process data in smaller batches. '
            + `Maximum allowed: ${MAX_WORKER_MEMORY_MB}MB. `
            + `[ES] La herramienta se quedo sin memoria (limite de ${memoryMb}MB). `
            + `Puedes reintentar con mas memoria pasando _memory_mb (ej. _memory_mb: ${suggestedMb}) `
            + 'en los argumentos de la herramienta, o la herramienta deberia procesar los datos en lotes mas pequenos. '
            + `Maximo permitido: ${MAX_WORKER_MEMORY_MB}MB.`,
        });
      } else {
        logger.warn({ err }, 'Worker thread error');
        finish({
          error: `[EN] Code execution failed: ${err.message}. `
            + 'Check the tool code for errors or contact the tool author. '
            + `[ES] La ejecucion del codigo fallo: ${err.message}. `
            + 'Revisa el codigo de la herramienta o contacta al autor.',
        });
      }
    });

    worker.on('exit', (exitCode) => {
      if (!settled) {
        finish({
          error: `[EN] Worker exited unexpectedly with code ${exitCode}. `
            + 'The tool may have a critical error. Try again or check the tool code. '
            + `[ES] El worker termino inesperadamente con codigo ${exitCode}. `
            + 'La herramienta puede tener un error critico. Intenta de nuevo o revisa el codigo.',
        });
      }
    });
  });
}
