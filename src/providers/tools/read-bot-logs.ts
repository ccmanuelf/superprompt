import type { Tool } from 'ollama';
import { getRecentLogs } from '../../logger.js';

export const readBotLogsDefinition: Tool = {
  type: 'function',
  function: {
    name: 'read_bot_logs',
    description: 'Read recent bot logs for diagnostics and debugging. Returns log entries with timestamps, levels, and messages.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of log entries to retrieve (default: 50, max: 200)',
        },
        level: {
          type: 'string',
          description: 'Minimum log level filter: trace, debug, info, warn, error (default: info)',
        },
      },
    },
  },
};

export function readBotLogs(
  args: { count?: number; level?: string },
): Record<string, unknown> {
  const count = Math.min(args.count ?? 50, 200);
  const level = args.level || 'info';
  const logs = getRecentLogs(count, level);

  return {
    count: logs.length,
    level,
    entries: logs.map((entry) => ({
      timestamp: new Date(entry.timestamp).toISOString(),
      level: entry.level,
      msg: entry.msg,
      ...(entry.err ? { error: String(entry.err) } : {}),
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.chatId ? { chatId: entry.chatId } : {}),
    })),
  };
}
