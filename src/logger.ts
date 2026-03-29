import pino from 'pino';
import { config } from './config.js';

// ── Log Ring Buffer ─────────────────────────────────────

export interface LogEntry {
  timestamp: number;
  level: string;
  msg: string;
  [key: string]: unknown;
}

const DEFAULT_BUFFER_SIZE = 500;

class LogRingBuffer {
  private buffer: LogEntry[];
  private maxSize: number;
  private writeIdx: number = 0;
  private count: number = 0;

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(entry: LogEntry): void {
    this.buffer[this.writeIdx] = entry;
    this.writeIdx = (this.writeIdx + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  getRecent(count?: number, level?: string): LogEntry[] {
    const limit = Math.min(count ?? this.count, this.count);
    const entries: LogEntry[] = [];

    // Read backwards from the most recent entry
    for (let i = 0; i < this.count && entries.length < limit; i++) {
      const idx = (this.writeIdx - 1 - i + this.maxSize) % this.maxSize;
      const entry = this.buffer[idx];
      if (entry) {
        if (level) {
          if (matchLevel(entry.level, level)) {
            entries.push(entry);
          }
        } else {
          entries.push(entry);
        }
      }
    }

    return entries.reverse(); // chronological order
  }

  clear(): void {
    this.buffer = new Array(this.maxSize);
    this.writeIdx = 0;
    this.count = 0;
  }
}

// Map pino numeric levels to string names
const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Check if an entry's level matches or exceeds the filter level.
 * E.g., filter "warn" matches warn, error, fatal.
 */
function matchLevel(entryLevel: string, filterLevel: string): boolean {
  const entryVal = LEVEL_VALUES[entryLevel] ?? 30;
  const filterVal = LEVEL_VALUES[filterLevel] ?? 30;
  return entryVal >= filterVal;
}

// Singleton ring buffer
const ringBuffer = new LogRingBuffer(DEFAULT_BUFFER_SIZE);

/**
 * Get recent log entries from the ring buffer.
 */
export function getRecentLogs(count: number = 50, level?: string): LogEntry[] {
  return ringBuffer.getRecent(count, level);
}

/**
 * Clear the ring buffer (for testing).
 */
export function clearLogBuffer(): void {
  ringBuffer.clear();
}

// ── Log Sanitization ───────────────────────────────────

/** Keys whose values should be redacted in log ring buffer */
const SENSITIVE_KEYS = new Set([
  'token', 'access_token', 'api_key', 'apiKey', 'secret',
  'password', 'authorization', 'cookie', 'session_id',
  'TELEGRAM_BOT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'VOICE_WEB_TOKEN',
  'MATRIX_ACCESS_TOKEN', 'GH_TOKEN', 'RENDER_API_KEY', 'BRAVE_API_KEY',
]);

/** Regex patterns to redact from string values */
const SENSITIVE_PATTERNS = [
  /\b(ghp_[a-zA-Z0-9]{36})\b/g,                    // GitHub PAT
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,                      // OpenAI/Anthropic keys
  /\b(rnd_[a-zA-Z0-9]{20,})\b/g,                     // Render keys
  /\b(\d{8,10}:[a-zA-Z0-9_-]{35})\b/g,               // Telegram bot tokens
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,                       // Slack tokens
];

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    let v = value;
    for (const pattern of SENSITIVE_PATTERNS) {
      v = v.replace(pattern, '[REDACTED]');
    }
    return v;
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeLogEntry(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeLogEntry(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeValue(value);
    }
  }
  return result;
}

// ── Pino Logger ─────────────────────────────────────────

// Build pino with a custom hook to tee into the ring buffer
export const logger = pino({
  level: config.LOG_LEVEL,
  hooks: {
    logMethod(inputArgs, method, level) {
      // Capture log entry into ring buffer
      const levelName = LEVEL_NAMES[level] || 'info';
      const entry: LogEntry = {
        timestamp: Date.now(),
        level: levelName,
        msg: '',
      };

      // Extract message and metadata from pino args (sanitize sensitive fields)
      for (const arg of inputArgs) {
        if (typeof arg === 'string') {
          entry.msg = arg;
        } else if (typeof arg === 'object' && arg !== null) {
          const sanitized = sanitizeLogEntry(arg as Record<string, unknown>);
          Object.assign(entry, sanitized);
        }
      }

      ringBuffer.push(entry);

      // Call original method
      method.apply(this, inputArgs as Parameters<typeof method>);
    },
  },
  ...(config.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});
