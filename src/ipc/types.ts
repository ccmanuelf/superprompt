/**
 * IPC Message Protocol — shared between all processes.
 *
 * Process 1 (luna-core) communicates with Process 2 (luna-tools)
 * and Process 3 (luna-parsers) via child_process.fork() IPC channels.
 *
 * All messages use discriminated unions for type-safe handling.
 */

import type { Tool } from 'ollama';

// ── Process 1 → Child (P2 or P3) ───────────────────────────

export interface ExecuteToolMessage {
  type: 'execute_tool';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  chatId: string;
  /** Per-request trace ID propagated from the originating message handler. */
  traceId?: string;
}

export interface RegisterUserToolMessage {
  type: 'register_user_tool';
  name: string;
  description: string;
  definition: Tool;
  toolType: 'declarative_http' | 'generated_code';
  config: string; // JSON-serialized tool config
}

export interface UnregisterUserToolMessage {
  type: 'unregister_user_tool';
  name: string;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export interface PingMessage {
  type: 'ping';
}

export type ParentMessage =
  | ExecuteToolMessage
  | RegisterUserToolMessage
  | UnregisterUserToolMessage
  | ShutdownMessage
  | PingMessage;

// ── Child (P2 or P3) → Process 1 ───────────────────────────

export interface ToolResultMessage {
  type: 'result';
  id: string;
  result: Record<string, unknown>;
}

export interface ToolErrorMessage {
  type: 'error';
  id: string;
  error: string;
}

export interface ReadyMessage {
  type: 'ready';
  process: string; // e.g. 'tools' or 'parsers'
  toolCount: number;
}

export interface PongMessage {
  type: 'pong';
}

export type ChildMessage =
  | ToolResultMessage
  | ToolErrorMessage
  | ReadyMessage
  | PongMessage;

// ── Tool process classification ─────────────────────────────

/**
 * Which process should execute this tool.
 * - 'core': DB-dependent tools — execute in Process 1 (default)
 * - 'tools': DB-free compute/network tools — execute in Process 2
 * - 'parsers': File parsing tools — execute in Process 3 (tightest sandbox)
 */
export type ToolProcess = 'core' | 'tools' | 'parsers';
