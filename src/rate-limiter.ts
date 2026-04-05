/**
 * Rate Limiter — per-user, per-provider call tracking.
 *
 * Prevents cost spirals on Claude subscription and excessive Ollama
 * inference load at company-wide scale. Configurable limits with
 * bilingual degradation messages.
 *
 * Inspired by frankbria/ralph-claude-code's rate limiting pattern.
 */

import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Max calls per window for Claude provider */
  claudeMaxPerWindow: number;
  /** Max calls per window for Ollama provider */
  ollamaMaxPerWindow: number;
  /** Window size in milliseconds (default: 1 hour) */
  windowMs: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
  message?: string;
}

interface CallRecord {
  timestamps: number[];
}

// ── Defaults ─────────────────────────────────────────────────

const DEFAULT_CONFIG: RateLimitConfig = {
  claudeMaxPerWindow: 100,   // 100 Claude calls per hour per user
  ollamaMaxPerWindow: 200,   // 200 Ollama calls per hour per user
  windowMs: 60 * 60 * 1000,  // 1 hour
};

// ── Rate Limiter ─────────────────────────────────────────────

export class RateLimiter {
  private records = new Map<string, CallRecord>();
  private config: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Override from env if set
    const envClaudeMax = parseInt(process.env.RATE_LIMIT_CLAUDE_MAX || '', 10);
    const envOllamaMax = parseInt(process.env.RATE_LIMIT_OLLAMA_MAX || '', 10);
    const envWindowMin = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || '', 10);

    if (envClaudeMax > 0) this.config.claudeMaxPerWindow = envClaudeMax;
    if (envOllamaMax > 0) this.config.ollamaMaxPerWindow = envOllamaMax;
    if (envWindowMin > 0) this.config.windowMs = envWindowMin * 60 * 1000;
  }

  /**
   * Check if a call should be allowed for this chat + provider.
   * Does NOT consume a call — call record() after successful execution.
   */
  check(chatId: string, provider: 'claude' | 'ollama'): RateLimitCheck {
    const key = `${chatId}:${provider}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const record = this.records.get(key);
    if (!record) {
      const max = provider === 'claude' ? this.config.claudeMaxPerWindow : this.config.ollamaMaxPerWindow;
      return { allowed: true, remaining: max - 1, resetInMs: this.config.windowMs };
    }

    // Prune old timestamps outside the window
    record.timestamps = record.timestamps.filter((t) => t > windowStart);

    const max = provider === 'claude' ? this.config.claudeMaxPerWindow : this.config.ollamaMaxPerWindow;
    const count = record.timestamps.length;
    const remaining = max - count;

    if (remaining <= 0) {
      const oldestInWindow = record.timestamps[0];
      const resetInMs = oldestInWindow + this.config.windowMs - now;
      const resetMin = Math.ceil(resetInMs / 60000);

      const providerName = provider === 'claude' ? 'Claude' : 'Ollama';
      const message =
        `[EN] Rate limit reached for ${providerName} (${max} calls per hour). ` +
        `Try again in ~${resetMin} minutes, or switch provider with /${provider === 'claude' ? 'ollama' : 'claude'}. ` +
        `[ES] Limite de uso alcanzado para ${providerName} (${max} llamadas por hora). ` +
        `Intenta de nuevo en ~${resetMin} minutos, o cambia de proveedor con /${provider === 'claude' ? 'ollama' : 'claude'}.`;

      logger.warn({ chatId, provider, count, max }, 'Rate limit reached');
      return { allowed: false, remaining: 0, resetInMs, message };
    }

    return { allowed: true, remaining, resetInMs: this.config.windowMs };
  }

  /**
   * Record a successful call for this chat + provider.
   * Call AFTER the AI response is received.
   */
  record(chatId: string, provider: 'claude' | 'ollama'): void {
    const key = `${chatId}:${provider}`;
    const now = Date.now();

    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }

    record.timestamps.push(now);

    // Periodic cleanup: prune timestamps older than 2x window
    const cutoff = now - this.config.windowMs * 2;
    record.timestamps = record.timestamps.filter((t) => t > cutoff);
  }

  /**
   * Get usage stats for a chat (all providers).
   */
  getUsage(chatId: string): {
    claude: { count: number; max: number; remaining: number };
    ollama: { count: number; max: number; remaining: number };
  } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const claudeKey = `${chatId}:claude`;
    const ollamaKey = `${chatId}:ollama`;

    const claudeRecord = this.records.get(claudeKey);
    const ollamaRecord = this.records.get(ollamaKey);

    const claudeCount = claudeRecord
      ? claudeRecord.timestamps.filter((t) => t > windowStart).length
      : 0;
    const ollamaCount = ollamaRecord
      ? ollamaRecord.timestamps.filter((t) => t > windowStart).length
      : 0;

    return {
      claude: {
        count: claudeCount,
        max: this.config.claudeMaxPerWindow,
        remaining: this.config.claudeMaxPerWindow - claudeCount,
      },
      ollama: {
        count: ollamaCount,
        max: this.config.ollamaMaxPerWindow,
        remaining: this.config.ollamaMaxPerWindow - ollamaCount,
      },
    };
  }

  /**
   * Format usage stats as bilingual message.
   */
  formatUsage(chatId: string): string {
    const usage = this.getUsage(chatId);
    const windowMin = Math.round(this.config.windowMs / 60000);

    return [
      `[EN] API usage this hour (${windowMin}-minute window):`,
      `  Claude: ${usage.claude.count}/${usage.claude.max} (${usage.claude.remaining} remaining)`,
      `  Ollama: ${usage.ollama.count}/${usage.ollama.max} (${usage.ollama.remaining} remaining)`,
      `[ES] Uso de API esta hora (ventana de ${windowMin} minutos):`,
      `  Claude: ${usage.claude.count}/${usage.claude.max} (${usage.claude.remaining} restantes)`,
      `  Ollama: ${usage.ollama.count}/${usage.ollama.max} (${usage.ollama.remaining} restantes)`,
    ].join('\n');
  }

  /**
   * Reset all records (for testing or manual reset).
   */
  reset(): void {
    this.records.clear();
  }
}

// ── Singleton ────────────────────────────────────────────────

let instance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!instance) {
    instance = new RateLimiter();
  }
  return instance;
}
