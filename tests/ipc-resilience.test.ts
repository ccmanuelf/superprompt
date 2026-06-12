/**
 * IPC Resilience — crash recovery, pending-request settlement, shutdown races.
 *
 * No mocks. These tests fork REAL child processes and kill them for real.
 * Requires `npm run build` before running (child processes need compiled JS).
 *
 * Dropped as untestable without modifying src/ipc/client.ts:
 * - Restart cap / backoff metadata: ProcessClient exposes no restart count or
 *   backoff state (only `isReady` / `processName_`), and exercising
 *   MAX_RESTARTS=5 would require ~31s of real exponential backoff. Skipped
 *   rather than mocking the real restart timers.
 * - Heartbeat-miss detection (3 missed pongs -> SIGKILL): needs >40s of real
 *   time (10s interval + 5s timeout per miss) or fake timers fighting real
 *   IPC. Skipped as inherently flaky in integration form.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ProcessClient } from '../src/ipc/client.js';
import { TOOLS_PROCESS_ENV } from '../src/ipc/env-whitelist.js';

/** Reach into the client to get the live child pid (no public accessor). */
function childPid(client: ProcessClient): number {
  const child = (client as unknown as { child: { pid?: number } | null }).child;
  if (!child?.pid) throw new Error('child process is not running');
  return child.pid;
}

/** Poll a condition until true or deadline. */
async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('IPC resilience — crash, restart, shutdown races', () => {
  const clients: ProcessClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      try { await client.shutdown(); } catch { /* best effort */ }
    }
    clients.length = 0;
  });

  it('restarts automatically after a SIGKILL crash and serves tools again', async () => {
    const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
    clients.push(client);

    await client.spawn();
    expect(client.isReady).toBe(true);
    const pidBefore = childPid(client);

    // Kill the child out-of-band — simulates a hard crash.
    process.kill(pidBefore, 'SIGKILL');

    // The exit handler marks the client not-ready almost immediately...
    await waitFor(() => !client.isReady, 5_000);

    // ...then the restart path (1s backoff for a first crash) respawns it.
    await waitFor(() => client.isReady, 15_000);

    const pidAfter = childPid(client);
    expect(pidAfter).not.toBe(pidBefore);

    // The restarted process must serve tools again.
    const result = await client.execute('get_time', {}, 'test-chat');
    expect(result.error).toBeUndefined();
  }, 20_000);

  it('settles in-flight requests with an error envelope when the child dies', async () => {
    const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
    clients.push(client);

    await client.spawn();
    const pid = childPid(client);

    // Start a request, then kill the child in the same tick — the IPC
    // message cannot have been answered yet, so the request is in-flight.
    const inFlight = client.execute('get_time', {}, 'test-chat');
    process.kill(pid, 'SIGKILL');

    // The implementation RESOLVES pending requests with an error envelope
    // (it never rejects), so the promise must settle — not hang.
    const result = await inFlight;
    expect(result.error).toBeDefined();
    expect(result.error).toContain('crashed');

    // Let the auto-restart finish so afterEach shutdown is clean and fast.
    await waitFor(() => client.isReady, 15_000);
  }, 20_000);

  it('shutdown() during an in-flight request resolves and the request settles', async () => {
    const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
    clients.push(client);

    await client.spawn();

    const inFlight = client.execute('get_time', {}, 'test-chat');
    await client.shutdown();

    expect(client.isReady).toBe(false);

    // Depending on ordering the child may answer before exiting (real result)
    // or the pending map is flushed with 'Process shutting down' — either way
    // the promise settles with an object, never hangs.
    const result = await inFlight;
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  }, 15_000);

  it('shutdown() during the restart backoff window resolves and cancels the restart', async () => {
    const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
    clients.push(client);

    await client.spawn();
    process.kill(childPid(client), 'SIGKILL');
    await waitFor(() => !client.isReady, 5_000, 25);

    // While the child is down (restart pending), execute degrades gracefully
    // with the bilingual unavailable envelope instead of throwing or hanging.
    const downResult = await client.execute('get_time', {}, 'test-chat');
    expect(downResult.error).toBeDefined();
    expect(downResult.error).toContain('not available');
    expect(downResult.error).toContain('[EN]');
    expect(downResult.error).toContain('[ES]');

    // Shut down inside the 1s backoff window. The child already exited, so
    // shutdown resolves via its 5s SIGKILL fallback — it must not hang.
    await client.shutdown();
    expect(client.isReady).toBe(false);

    // Wait past the original 1s restart backoff: no respawn may occur.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(client.isReady).toBe(false);
  }, 15_000);
});
