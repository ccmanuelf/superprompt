/**
 * Worker thread entry point for sandboxed tool execution.
 *
 * This file runs in a separate V8 isolate via Node.js Worker threads.
 * It has NO access to the parent process's globals, modules, or memory.
 *
 * User code receives: args, fetch (SSRF-safe + auto-heartbeat), heartbeat()
 */

import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('worker-entry.ts must be run as a Worker thread');
}

const port = parentPort;
const { code, args } = workerData as { code: string; args: Record<string, unknown> };

// --- Heartbeat ---

function sendHeartbeat(): void {
  port.postMessage({ type: 'heartbeat' });
}

// --- SSRF blocklist (self-contained, mirrors isInternalUrl from summarize-url.ts) ---

function isBlockedUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true;

    // Docker internal hostnames
    if (hostname === 'speaches' || hostname === 'synapse' || hostname === 'luna-bot' || hostname === 'luna-speaches' || hostname === 'luna-synapse') return true;

    // host.docker.internal
    if (hostname.includes('docker.internal')) return true;

    // Cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;

    // Private IP ranges (RFC 1918 + link-local)
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
    }

    // Block file:// protocol
    if (url.protocol === 'file:') return true;

    return false;
  } catch {
    // If URL can't be parsed, block it
    return true;
  }
}

// --- SSRF-safe fetch with auto-heartbeat ---

async function safeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (isBlockedUrl(url)) {
    throw new Error(
      '[EN] fetch() to internal or private network URLs is blocked for security reasons. '
      + 'Use a public API endpoint instead. '
      + '[ES] fetch() a URLs de red interna o privada esta bloqueado por razones de seguridad. '
      + 'Usa un endpoint de API publico en su lugar.',
    );
  }

  // Auto-heartbeat before request
  sendHeartbeat();

  const response = await fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });

  // Auto-heartbeat after response
  sendHeartbeat();

  return response;
}

// --- Execute user code ---

async function run(): Promise<void> {
  try {
    // Build an async function from user code with strict mode
    const fn = new Function('args', 'fetch', 'heartbeat', `
      'use strict';
      return (async () => {
        ${code}
      })();
    `);

    const result = await fn(args, safeFetch, sendHeartbeat);

    const payload = typeof result === 'object' && result !== null
      ? result
      : { result };

    port.postMessage({ type: 'result', success: true, result: payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({
      type: 'result',
      success: false,
      error: `[EN] Code execution failed: ${message}. `
        + 'Check the tool code for syntax or runtime errors. '
        + `[ES] La ejecucion del codigo fallo: ${message}. `
        + 'Revisa el codigo de la herramienta por errores de sintaxis o ejecucion.',
    });
  }
}

run();
