/**
 * Circuit Breaker — prevents runaway tool loops and subprocess hangs.
 *
 * Inspired by frankbria/ralph-claude-code's Nygard circuit breaker pattern.
 * Adapted for clauded's dual-provider architecture:
 *
 * Ollama: Full loop-level protection (repetition, errors, stagnation)
 * Claude: Subprocess-level protection (timeout, quality gate)
 *
 * States: CLOSED (normal) → HALF_OPEN (one more try) → OPEN (stopped)
 */

import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'half_open' | 'open';

export interface BreakerConfig {
  /** Max times same tool + args can be called before breaking */
  maxRepetitions: number;
  /** Max consecutive tool errors before breaking */
  maxConsecutiveErrors: number;
  /** Max iterations with no output progress before breaking */
  maxStaleIterations: number;
}

interface ToolCall {
  tool: string;
  argsHash: string;
  success: boolean;
}

const DEFAULT_CONFIG: BreakerConfig = {
  maxRepetitions: 3,
  maxConsecutiveErrors: 3,
  maxStaleIterations: 3,
};

// ── Circuit Breaker Class ────────────────────────────────────

export class CircuitBreaker {
  private _state: BreakerState = 'closed';
  private consecutiveErrors = 0;
  private staleIterations = 0;
  private lastOutputLength = 0;
  private toolCallHistory: ToolCall[] = [];
  private config: BreakerConfig;
  private openReason = '';

  constructor(config?: Partial<BreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get state(): BreakerState {
    return this._state;
  }

  get reason(): string {
    return this.openReason;
  }

  /**
   * Check if a tool execution should be allowed.
   * Called BEFORE each tool execution in the agentic loop.
   */
  shouldAllowExecution(toolName: string, args: Record<string, unknown>): { allow: boolean; reason?: string } {
    if (this._state === 'open') {
      return { allow: false, reason: this.openReason };
    }

    // Check for tool repetition
    const argsHash = stableStringify(args);
    const repetitions = this.toolCallHistory.filter(
      (tc) => tc.tool === toolName && tc.argsHash === argsHash,
    ).length;

    if (repetitions >= this.config.maxRepetitions) {
      this.trip(
        `[EN] Tool "${toolName}" called ${repetitions + 1} times with identical arguments — likely stuck in a retry loop. `
        + `[ES] Herramienta "${toolName}" llamada ${repetitions + 1} veces con argumentos identicos — probablemente atrapada en un bucle de reintento.`,
      );
      return { allow: false, reason: this.openReason };
    }

    return { allow: true };
  }

  /**
   * Record the result of a tool execution.
   * Called AFTER each tool execution in the agentic loop.
   */
  recordResult(toolName: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
    const isError = 'error' in result || '_confirmation_required' in result;
    const argsHash = stableStringify(args);

    this.toolCallHistory.push({ tool: toolName, argsHash, success: !isError });

    if (isError) {
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        this.trip(
          `[EN] ${this.consecutiveErrors} consecutive tool errors — stopping to prevent cascading failures. `
          + `[ES] ${this.consecutiveErrors} errores consecutivos de herramientas — deteniendo para evitar fallas en cascada.`,
        );
      }
    } else {
      this.consecutiveErrors = 0;

      // Success in HALF_OPEN → recover to CLOSED
      if (this._state === 'half_open') {
        this._state = 'closed';
        logger.info('Circuit breaker recovered to CLOSED');
      }
    }
  }

  /**
   * Record the end of an iteration (after all tool calls in one loop pass).
   * Detects output stagnation.
   */
  recordIterationEnd(outputLength: number): void {
    if (this._state === 'open') return;

    // Check for stale output (within ±10% of previous)
    if (this.lastOutputLength > 0) {
      const delta = Math.abs(outputLength - this.lastOutputLength);
      const threshold = this.lastOutputLength * 0.1;

      if (delta <= threshold) {
        this.staleIterations++;
      } else {
        this.staleIterations = 0;
      }

      if (this.staleIterations >= this.config.maxStaleIterations) {
        this.trip(
          `[EN] No meaningful progress after ${this.staleIterations} iterations — the approach may need to change. `
          + `[ES] Sin progreso significativo despues de ${this.staleIterations} iteraciones — el enfoque puede necesitar cambiar.`,
        );
      }
    }

    this.lastOutputLength = outputLength;
  }

  /**
   * Trip the breaker — transition to OPEN or HALF_OPEN.
   */
  private trip(reason: string): void {
    if (this._state === 'half_open') {
      // Already tried recovery, go fully OPEN
      this._state = 'open';
      this.openReason = reason;
      logger.warn({ reason: reason.slice(0, 100) }, 'Circuit breaker OPEN (recovery failed)');
    } else {
      // First trip — go to HALF_OPEN (allow one more attempt)
      this._state = 'half_open';
      this.openReason = reason;
      logger.info({ reason: reason.slice(0, 100) }, 'Circuit breaker HALF_OPEN');
    }
  }

  /**
   * Reset the breaker (on successful loop completion or new conversation).
   */
  reset(): void {
    this._state = 'closed';
    this.consecutiveErrors = 0;
    this.staleIterations = 0;
    this.lastOutputLength = 0;
    this.toolCallHistory = [];
    this.openReason = '';
  }
}

// ── Claude Subprocess Timeout ────────────────────────────────

/** Default Claude subprocess timeout (milliseconds) */
const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Get the Claude subprocess timeout from env or default.
 */
export function getClaudeTimeoutMs(): number {
  const envVal = process.env.CLAUDE_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_CLAUDE_TIMEOUT_MS;
}

/**
 * Build a bilingual timeout error for Claude subprocess.
 */
export function buildClaudeTimeoutError(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `[EN] Claude response timed out after ${seconds}s. The request may be too complex or the service may be temporarily unavailable. Try simplifying the request or switch to Ollama with /ollama. `
    + `[ES] La respuesta de Claude agoto el tiempo despues de ${seconds}s. La solicitud puede ser muy compleja o el servicio puede estar temporalmente no disponible. Intenta simplificar la solicitud o cambia a Ollama con /ollama.`
  );
}

// ── Utility ──────────────────────────────────────────────────

/**
 * Stable JSON stringify for args comparison.
 * Sorts keys so {a:1, b:2} and {b:2, a:1} produce the same hash.
 */
function stableStringify(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}
