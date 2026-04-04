import type { Tool } from 'ollama';
import { logger } from '../logger.js';
import { listUserTools, type UserTool } from '../db.js';
import { executeDeclarativeHttp } from './declarative-http.js';
import { executeInWorker } from './worker-sandbox.js';
import type { DeclarativeHttpEndpoint, ToolParameter } from './tool-parser.js';

export interface ToolEntry {
  definition: Tool;
  execute: (args: Record<string, unknown>, chatId: string) => Promise<Record<string, unknown>>;
  source: 'builtin' | 'user';
  /** Which process executes this tool: 'core' (default), 'tools' (P2), 'parsers' (P3) */
  process?: 'core' | 'tools' | 'parsers';
}

const registry = new Map<string, ToolEntry>();

export function registerTool(entry: ToolEntry): void {
  const name = entry.definition.function.name!;
  registry.set(name, entry);
  logger.debug({ tool: name, source: entry.source }, 'Tool registered');
}

export function unregisterTool(name: string): void {
  registry.delete(name);
  logger.debug({ tool: name }, 'Tool unregistered');
}

export function getToolEntry(name: string): ToolEntry | undefined {
  return registry.get(name);
}

/**
 * Execute a tool by name. Returns { error: ... } if not found.
 */
export async function executeRegisteredTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  const entry = registry.get(name);
  if (!entry) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    return await entry.execute(args, chatId);
  } catch (err) {
    logger.error({ err, tool: name }, 'Tool execution failed');
    return {
      error: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Get tool definitions, optionally filtered by allowed tool names.
 */
export function getToolDefinitions(allowedTools?: string[]): Tool[] {
  const all = Array.from(registry.values()).map((e) => e.definition);
  if (!allowedTools) return all;
  return all.filter((t) => t.function.name && allowedTools.includes(t.function.name));
}

/**
 * List all registered tools with source info.
 */
export function listRegisteredTools(): Array<{ name: string; description: string; source: string }> {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    description: entry.definition.function.description || '',
    source: entry.source,
  }));
}

/**
 * Load user tools from DB and register them.
 * Call on startup and after /reload.
 */
export function loadUserTools(envVars?: Record<string, string>): number {
  // Remove all existing user tools first
  for (const [name, entry] of registry.entries()) {
    if (entry.source === 'user') {
      registry.delete(name);
    }
  }

  const userTools = listUserTools();
  let loaded = 0;

  for (const tool of userTools) {
    if (!tool.enabled) continue;

    try {
      const entry = createUserToolEntry(tool, envVars);
      if (entry) {
        registerTool(entry);
        loaded++;
      }
    } catch (err) {
      logger.warn({ err, tool: tool.name }, 'Failed to load user tool');
    }
  }

  logger.info({ loaded, total: userTools.length }, 'User tools loaded');
  return loaded;
}

/**
 * Create a ToolEntry from a UserTool DB record.
 */
function createUserToolEntry(
  tool: UserTool,
  envVars?: Record<string, string>,
): ToolEntry | null {
  const config = JSON.parse(tool.config);

  if (tool.tool_type === 'declarative_http') {
    const endpoint = config.endpoint as DeclarativeHttpEndpoint;
    const parameters = (config.parameters || []) as ToolParameter[];

    const definition: Tool = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: parameters.filter((p) => p.required).map((p) => p.name),
        },
      },
    };

    return {
      definition,
      execute: async (args) => executeDeclarativeHttp(endpoint, args, envVars),
      source: 'user',
    };
  }

  if (tool.tool_type === 'generated_code') {
    const code = config.code as string;
    const parameters = (config.parameters || []) as ToolParameter[];

    if (!code) {
      logger.warn({ tool: tool.name }, 'Generated code tool has no code');
      return null;
    }

    const definition: Tool = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: parameters.filter((p) => p.required).map((p) => p.name),
        },
      },
    };

    return {
      definition,
      execute: async (args) => executeInWorker(code, args),
      source: 'user',
    };
  }

  return null;
}

