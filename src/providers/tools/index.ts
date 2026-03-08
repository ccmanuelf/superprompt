import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  registerTool,
  executeRegisteredTool,
  getToolDefinitions as getRegistryDefinitions,
  type ToolEntry,
} from '../../forge/tool-registry.js';

import { webSearchDefinition, webSearch } from './web-search.js';
import { readFileDefinition, readFileTool } from './read-file.js';
import { runCommandDefinition, runCommand } from './run-command.js';
import { queryMemoryDefinition, queryMemory } from './query-memory.js';
import { saveMemoryDefinition, saveMemory } from './save-memory.js';
import { getTimeDefinition, getTime } from './get-time.js';
import { systemInfoDefinition, systemInfo } from './system-info.js';
import { summarizeUrlDefinition, summarizeUrl } from './summarize-url.js';
import { parseFileDefinition, parseFileTool } from './parse-file.js';
import { generateDocumentDefinition, generateDocumentTool } from './generate-document.js';
import { readBotLogsDefinition, readBotLogs } from './read-bot-logs.js';

/**
 * Register all built-in tools in the dynamic registry.
 * Call once on startup.
 */
export function registerBuiltinTools(): void {
  const builtins: ToolEntry[] = [
    {
      definition: webSearchDefinition,
      execute: async (args) => webSearch(args as { query: string }),
      source: 'builtin',
    },
    {
      definition: readFileDefinition,
      execute: async (args) => readFileTool(args as { path: string }),
      source: 'builtin',
    },
    {
      definition: runCommandDefinition,
      execute: async (args) => runCommand(args as { command: string }),
      source: 'builtin',
    },
    {
      definition: queryMemoryDefinition,
      execute: async (args, chatId) =>
        queryMemory(args as { query: string; limit?: number }, chatId),
      source: 'builtin',
    },
    {
      definition: saveMemoryDefinition,
      execute: async (args, chatId) =>
        saveMemory(args as { content: string; sector?: string }, chatId),
      source: 'builtin',
    },
    {
      definition: getTimeDefinition,
      execute: async () => getTime(),
      source: 'builtin',
    },
    {
      definition: systemInfoDefinition,
      execute: async () => systemInfo(),
      source: 'builtin',
    },
    {
      definition: summarizeUrlDefinition,
      execute: async (args) => summarizeUrl(args as { url: string }),
      source: 'builtin',
    },
    {
      definition: parseFileDefinition,
      execute: async (args) => parseFileTool(args as { path: string }),
      source: 'builtin',
    },
    {
      definition: generateDocumentDefinition,
      execute: async (args) => generateDocumentTool(args),
      source: 'builtin',
    },
    {
      definition: readBotLogsDefinition,
      execute: async (args) => readBotLogs(args as { count?: number; level?: string }),
      source: 'builtin',
    },
  ];

  for (const entry of builtins) {
    registerTool(entry);
  }

  logger.info({ count: builtins.length }, 'Built-in tools registered');
}

/** Get all tool definitions (builtin + user), optionally filtered */
export function getToolDefinitions(allowedTools?: string[]): Tool[] {
  return getRegistryDefinitions(allowedTools);
}

/**
 * Execute a tool by name with the given arguments.
 * Delegates to the dynamic registry.
 * Never throws — returns { error: ... } on failure.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  logger.debug({ tool: name, args }, 'Executing tool');
  return executeRegisteredTool(name, args, chatId);
}

