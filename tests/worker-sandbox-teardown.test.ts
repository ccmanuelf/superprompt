import { describe, it, expect } from 'vitest';
import { executeInWorker, activeWorkerCount } from '../src/forge/worker-sandbox.js';

/** Poll until the live-worker count drops to 0 or the deadline passes. */
async function waitForWorkersToDrain(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (activeWorkerCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return activeWorkerCount();
}

describe('worker teardown on success', () => {
  it('returns promptly and tears down the thread even when user code leaves a timer', async () => {
    // User code resolves a result but leaves an interval running. Without an
    // explicit terminate the worker thread (≤64 MB) lingers forever because
    // the dangling interval keeps its event loop alive.
    const code = `
      setInterval(() => {}, 1000); // dangling handle
      return { ok: true };
    `;
    const start = Date.now();
    const result = await executeInWorker(code, {});
    expect(result).toMatchObject({ ok: true });
    // Must resolve on the result, not block on the rolling/absolute timer.
    expect(Date.now() - start).toBeLessThan(5_000);

    // The real guard: the worker thread must actually be torn down. The `exit`
    // event is asynchronous relative to the resolved promise, so poll briefly.
    // Without the terminate-on-success fix the dangling interval keeps the
    // thread alive → count stays 1 → this fails.
    const remaining = await waitForWorkersToDrain(2_000);
    expect(remaining).toBe(0);
  });
});
