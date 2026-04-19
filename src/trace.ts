/**
 * Per-request trace context.
 *
 * One trace ID is generated when a message enters the system (Telegram or
 * Matrix handler) and propagates through every async hop on the call stack
 * via AsyncLocalStorage — including across IPC into the tools and parsers
 * processes (the receiving side re-establishes the context from the
 * envelope). Logger and DB writes read it transparently, so no function
 * signature has to change.
 *
 * Inspired by the Tracer Module in the Autogenesis paper (arXiv:2604.15034),
 * narrowed to the one piece that pays off without an evaluation loop:
 * cross-process failure attribution.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface TraceState {
  traceId: string;
}

const traceContext = new AsyncLocalStorage<TraceState>();

/** Generate a 16-char hex trace ID (8 bytes of entropy). */
export function generateTraceId(): string {
  return randomBytes(8).toString('hex');
}

/** Read the trace ID for the current async context, if any. */
export function getTraceId(): string | undefined {
  return traceContext.getStore()?.traceId;
}

/** Run `fn` inside a trace context bound to `traceId`. */
export function withTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  return traceContext.run({ traceId }, fn);
}
