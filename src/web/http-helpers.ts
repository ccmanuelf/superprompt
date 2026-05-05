/**
 * Shared HTTP helpers for the web/api modules.
 *
 * Centralizes the request-body reader so the size cap is enforced once.
 * Previously, every *-api.ts file inlined its own unbounded reader, letting
 * a single oversized POST body exhaust the process before parsing.
 */

import type { IncomingMessage } from 'node:http';

/** Default JSON body size cap (10MB). Realistic write payloads are <100KB. */
export const DEFAULT_JSON_BODY_LIMIT = 10 * 1024 * 1024;

/**
 * Error thrown by readJsonBody when the request body exceeds the size cap.
 * Callers can catch and respond with HTTP 413.
 */
export class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Read a JSON request body with a size cap. Aborts the stream and rejects
 * with PayloadTooLargeError when the cap is exceeded — the buffer is
 * released without ever parsing the oversized payload.
 *
 * Returns `{}` for an empty body (matches the pre-rc.102 behavior of every
 * caller).
 */
export function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_JSON_BODY_LIMIT,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    const abort = (err: Error): void => {
      if (aborted) return;
      aborted = true;
      // Drain remaining bytes off the socket so it can be closed cleanly.
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume();
      reject(err);
    };

    req.on('data', (chunk: unknown) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      received += buf.length;
      if (received > maxBytes) {
        abort(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', (err) => abort(err));
  });
}
