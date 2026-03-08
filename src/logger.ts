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

      // Extract message and metadata from pino args
      for (const arg of inputArgs) {
        if (typeof arg === 'string') {
          entry.msg = arg;
        } else if (typeof arg === 'object' && arg !== null) {
          Object.assign(entry, arg);
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
