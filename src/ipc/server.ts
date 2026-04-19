/**
 * IPC Server — Child process side (Process 2 or Process 3).
 *
 * Listens for messages from Process 1 via the built-in IPC channel.
 * Routes tool execution requests to the local registry.
 * Handles user tool registration/unregistration dynamically.
 */

import type { ParentMessage } from './types.js';
import type { ToolEntry } from '../core/interfaces.js';
import { withTrace } from '../trace.js';

/** Local tool registry for this child process */
const localRegistry = new Map<string, ToolEntry>();

/**
 * Register a tool in the local child process registry.
 */
export function registerLocalTool(entry: ToolEntry): void {
  const name = entry.definition.function.name!;
  localRegistry.set(name, entry);
}

/**
 * Unregister a tool from the local child process registry.
 */
export function unregisterLocalTool(name: string): void {
  localRegistry.delete(name);
}

/**
 * Get the count of registered tools.
 */
export function getLocalToolCount(): number {
  return localRegistry.size;
}

/**
 * User tool registration callback — set by the process entry point
 * to handle register_user_tool messages with process-specific logic.
 */
let userToolHandler: ((msg: ParentMessage & { type: 'register_user_tool' }) => void) | null = null;

/**
 * Set the handler for user tool registration messages.
 * Called by tools-process.ts to wire up Worker sandbox / declarative HTTP execution.
 */
export function setUserToolHandler(
  handler: (msg: ParentMessage & { type: 'register_user_tool' }) => void,
): void {
  userToolHandler = handler;
}

/**
 * Start the IPC server. Call this from the child process entry point
 * after registering all builtin tools.
 *
 * @param processName - e.g. 'tools' or 'parsers'
 */
export function startIPCServer(processName: string): void {
  if (!process.send) {
    throw new Error('IPC server must be run as a child process (via fork)');
  }

  process.on('message', async (msg: ParentMessage) => {
    switch (msg.type) {
      case 'execute_tool': {
        const entry = localRegistry.get(msg.tool);
        if (!entry) {
          process.send!({
            type: 'error',
            id: msg.id,
            error: `[EN] Tool "${msg.tool}" not found in ${processName} process. `
              + `[ES] Herramienta "${msg.tool}" no encontrada en el proceso ${processName}.`,
          });
          return;
        }

        const run = async () => {
          try {
            const result = await entry.execute(msg.args, msg.chatId);
            process.send!({ type: 'result', id: msg.id, result });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.send!({
              type: 'error',
              id: msg.id,
              error: `[EN] Tool "${msg.tool}" failed in ${processName} process: ${message}. `
                + `[ES] Herramienta "${msg.tool}" fallo en el proceso ${processName}: ${message}.`,
            });
          }
        };

        if (msg.traceId) {
          await withTrace(msg.traceId, run);
        } else {
          await run();
        }
        break;
      }

      case 'register_user_tool': {
        if (userToolHandler) {
          userToolHandler(msg);
        }
        break;
      }

      case 'unregister_user_tool': {
        localRegistry.delete(msg.name);
        break;
      }

      case 'ping': {
        process.send!({ type: 'pong' });
        break;
      }

      case 'shutdown': {
        // Clean exit
        process.exit(0);
        break;
      }
    }
  });

  // Send ready signal
  process.send({
    type: 'ready',
    process: processName,
    toolCount: localRegistry.size,
  });
}
