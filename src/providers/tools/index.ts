import type { Tool } from 'ollama';
import { logger } from '../../logger.js';

import { webSearchDefinition, webSearch } from './web-search.js';
import { readFileDefinition, readFileTool } from './read-file.js';
import { runCommandDefinition, runCommand } from './run-command.js';
import { queryMemoryDefinition, queryMemory } from './query-memory.js';
import { saveMemoryDefinition, saveMemory } from './save-memory.js';
import { getTimeDefinition, getTime } from './get-time.js';
import { systemInfoDefinition, systemInfo } from './system-info.js';
import { summarizeUrlDefinition, summarizeUrl } from './summarize-url.js';

/** All tool definitions for Ollama's tool calling API */
export const toolDefinitions: Tool[] = [
  webSearchDefinition,
  readFileDefinition,
  runCommandDefinition,
  queryMemoryDefinition,
  saveMemoryDefinition,
  getTimeDefinition,
  systemInfoDefinition,
  summarizeUrlDefinition,
];

/**
 * Execute a tool by name with the given arguments.
 * Returns a JSON-serializable result object.
 * Never throws — returns { error: ... } on failure.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  logger.debug({ tool: name, args }, 'Executing tool');

  try {
    switch (name) {
      case 'web_search':
        return await webSearch(args as { query: string });

      case 'read_file':
        return readFileTool(args as { path: string });

      case 'run_command':
        return runCommand(args as { command: string });

      case 'query_memory':
        return queryMemory(
          args as { query: string; limit?: number },
          chatId,
        );

      case 'save_memory':
        return saveMemory(
          args as { content: string; sector?: string },
          chatId,
        );

      case 'get_time':
        return getTime();

      case 'system_info':
        return systemInfo();

      case 'summarize_url':
        return await summarizeUrl(args as { url: string });

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    logger.error({ err, tool: name }, 'Tool execution failed');
    return {
      error: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
