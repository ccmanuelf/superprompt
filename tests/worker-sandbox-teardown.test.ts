import { describe, it, expect } from 'vitest';
import { executeInWorker } from '../src/forge/worker-sandbox.js';

describe('worker teardown on success', () => {
  it('returns promptly and tears down even when user code leaves a timer', async () => {
    // User code resolves a result but leaves an interval running.
    const code = `
      setInterval(() => {}, 1000); // dangling handle
      return { ok: true };
    `;
    const start = Date.now();
    const result = await executeInWorker(code, {});
    expect(result).toMatchObject({ ok: true });
    // Must resolve on the result, not block on the rolling/absolute timer.
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
