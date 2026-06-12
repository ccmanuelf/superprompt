import { describe, it, expect } from 'vitest';
import { executeInWorker } from '../src/forge/worker-sandbox.js';

describe('worker-sandbox', () => {
  // --- Core execution ---

  it('executes simple synchronous code and returns result', async () => {
    const result = await executeInWorker(
      'return { sum: args.a + args.b };',
      { a: 2, b: 3 },
    );
    expect(result).toEqual({ sum: 5 });
  });

  it('executes async code and returns result', async () => {
    const result = await executeInWorker(
      'const val = await Promise.resolve(42); return { val };',
      {},
    );
    expect(result).toEqual({ val: 42 });
  });

  it('passes args correctly through structured clone', async () => {
    const result = await executeInWorker(
      'return { name: args.name, items: args.items, nested: args.nested };',
      { name: 'test', items: [1, 2, 3], nested: { x: true } },
    );
    expect(result).toEqual({ name: 'test', items: [1, 2, 3], nested: { x: true } });
  });

  it('wraps non-object return values in { result }', async () => {
    const result = await executeInWorker('return 42;', {});
    expect(result).toEqual({ result: 42 });
  });

  it('wraps string return values in { result }', async () => {
    const result = await executeInWorker('return "hello";', {});
    expect(result).toEqual({ result: 'hello' });
  });

  it('wraps null return as object', async () => {
    const result = await executeInWorker('return null;', {});
    expect(result).toEqual({ result: null });
  });

  it('returns error for code that throws — bilingual with actual message', async () => {
    const result = await executeInWorker(
      'throw new Error("test failure");',
      {},
    );
    const err = result.error as string;
    expect(err).toContain('test failure');
    expect(err).toContain('[EN]');
    expect(err).toContain('[ES]');
  });

  it('returns error for syntax errors in code', async () => {
    const result = await executeInWorker(
      'const x = {{{;',
      {},
    );
    expect(result.error).toBeDefined();
  });

  // --- Adaptive timeout ---
  //
  // NOTE on sleeps: the `setTimeout` calls below live INSIDE the worker code
  // strings — they are deliberate simulated workloads that exercise the REAL
  // heartbeat/rolling-timeout machinery in src/forge/worker-sandbox.ts. They
  // are not test-level waits: each test already awaits the executeInWorker
  // promise, which settles event-driven when the worker finishes or is killed.
  // Do not replace them with condition polling or fake timers.

  it('kills infinite loop at base timeout (no heartbeat)', async () => {
    const start = Date.now();
    const result = await executeInWorker(
      'while(true) {}',
      {},
      { baseTimeoutMs: 500, maxTimeoutMs: 2000 },
    );
    const elapsed = Date.now() - start;

    expect(result.error).toContain('timed out');
    expect(result.error).toContain('no activity');
    expect(result.error).toContain('[EN]');
    expect(result.error).toContain('[ES]');
    expect(result.error).toContain('_timeout');
    expect(result.error).toContain('reintentar');
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it('heartbeat extends lifetime beyond base window', async () => {
    // Base timeout 300ms, but code sends heartbeats every 100ms for 600ms total
    const result = await executeInWorker(
      `
      for (let i = 0; i < 6; i++) {
        heartbeat();
        await new Promise(r => setTimeout(r, 100));
      }
      return { done: true };
      `,
      {},
      { baseTimeoutMs: 300, maxTimeoutMs: 5000 },
    );
    expect(result).toEqual({ done: true });
  }, 5000);

  it('hard ceiling kills Worker regardless of heartbeats', async () => {
    const start = Date.now();
    const result = await executeInWorker(
      `
      while (true) {
        heartbeat();
        await new Promise(r => setTimeout(r, 50));
      }
      `,
      {},
      { baseTimeoutMs: 500, maxTimeoutMs: 1000 },
    );
    const elapsed = Date.now() - start;

    expect(result.error).toContain('timed out');
    expect(result.error).toContain('hard ceiling');
    // Should die around 1000ms, not 500ms (heartbeats keep rolling timer alive)
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(3000);
  }, 5000);

  // --- Conversational _timeout override ---

  it('_timeout overrides hard ceiling for that invocation', async () => {
    // Default max would be 500ms, but _timeout: 2 (seconds) extends to 2000ms.
    // The in-worker 800ms sleep is deliberate workload: it must outlive the
    // 500ms ceiling to prove the override took effect.
    const result = await executeInWorker(
      `
      heartbeat();
      await new Promise(r => setTimeout(r, 800));
      return { done: true };
      `,
      { _timeout: 2 },
      { baseTimeoutMs: 5000, maxTimeoutMs: 500 },
    );
    expect(result).toEqual({ done: true });
  }, 5000);

  it('_timeout is stripped from args before passing to user code', async () => {
    const result = await executeInWorker(
      'return { keys: Object.keys(args) };',
      { _timeout: 60, name: 'test' },
    );
    expect(result).toEqual({ keys: ['name'] });
  });

  it('without _timeout, rolling timer kills idle code at base window', async () => {
    // No _timeout = base window is the kill threshold for idle code
    const start = Date.now();
    const result = await executeInWorker(
      'while(true) {}', // no heartbeat = dies at base timeout
      {}, // no _timeout override
      { baseTimeoutMs: 500, maxTimeoutMs: 2000 },
    );
    const elapsed = Date.now() - start;

    expect(result.error).toContain('timed out');
    expect(result.error).toContain('no activity');
    // Should die at ~500ms (base timeout), not wait for 2000ms ceiling
    expect(elapsed).toBeLessThan(1500);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  }, 5000);

  it('_timeout extends base window — user-requested patience is honored', async () => {
    // _timeout: 2 (seconds) means user wants to wait up to 2s
    // Code takes 800ms with heartbeat (deliberate in-worker workload —
    // must exceed the 200ms base/max) — should succeed even though baseTimeoutMs is tiny
    const result = await executeInWorker(
      `
      heartbeat();
      await new Promise(r => setTimeout(r, 800));
      return { waited: true };
      `,
      { _timeout: 2 },
      { baseTimeoutMs: 200, maxTimeoutMs: 200 }, // both tiny, but _timeout overrides
    );
    expect(result).toEqual({ waited: true });
  }, 5000);

  // --- Security ---

  it('SSRF blocklist rejects fetch to localhost with bilingual message', async () => {
    const result = await executeInWorker(
      'const r = await fetch("http://localhost:3000/api"); return { ok: true };',
      {},
      { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
    );
    expect(result.error).toContain('blocked');
    expect(result.error).toContain('[EN]');
    expect(result.error).toContain('[ES]');
    expect(result.error).toContain('bloqueado');
  }, 10000);

  it('SSRF blocklist rejects fetch to internal IPs', async () => {
    const result = await executeInWorker(
      'const r = await fetch("http://192.168.1.1/secret"); return { ok: true };',
      {},
      { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
    );
    expect(result.error).toContain('blocked');
  }, 10000);

  it('SSRF blocklist rejects fetch to Docker internal', async () => {
    const result = await executeInWorker(
      'const r = await fetch("http://speaches:8080/api"); return { ok: true };',
      {},
      { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
    );
    expect(result.error).toContain('blocked');
  }, 10000);

  it('SSRF blocklist rejects fetch to cloud metadata', async () => {
    const result = await executeInWorker(
      'const r = await fetch("http://169.254.169.254/latest/meta-data"); return { ok: true };',
      {},
      { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
    );
    expect(result.error).toContain('blocked');
  }, 10000);

  // --- Memory limit ---

  it('enforces memory limit with actionable error message', async () => {
    const result = await executeInWorker(
      `
      const arrays = [];
      for (let i = 0; i < 1000; i++) {
        arrays.push(new Array(1_000_000).fill('x'));
      }
      return { len: arrays.length };
      `,
      {},
      { baseTimeoutMs: 10000, maxTimeoutMs: 15000 },
    );
    // EN content
    expect(result.error).toContain('[EN]');
    expect(result.error).toContain('out of memory');
    expect(result.error).toContain('64MB');
    expect(result.error).toContain('_memory_mb');
    expect(result.error).toContain('128'); // suggests doubling: 64 → 128
    expect(result.error).toContain('512MB'); // mentions max cap
    // ES content
    expect(result.error).toContain('[ES]');
    expect(result.error).toContain('sin memoria');
    expect(result.error).toContain('lotes');
  }, 20000);

  it('_memory_mb overrides memory limit for that invocation', async () => {
    // With default 64MB this would OOM, but _memory_mb: 256 gives enough room
    const result = await executeInWorker(
      `
      const arrays = [];
      for (let i = 0; i < 20; i++) {
        arrays.push(new Array(1_000_000).fill('x'));
      }
      return { count: arrays.length };
      `,
      { _memory_mb: 256 },
      { baseTimeoutMs: 10000, maxTimeoutMs: 15000 },
    );
    expect(result).toEqual({ count: 20 });
  }, 20000);

  it('_memory_mb is stripped from args before passing to user code', async () => {
    const result = await executeInWorker(
      'return { keys: Object.keys(args) };',
      { _memory_mb: 128, name: 'test' },
    );
    expect(result).toEqual({ keys: ['name'] });
  });

  it('_memory_mb is clamped to 512MB maximum', async () => {
    // Pass _memory_mb: 9999, still works (clamped to 512)
    const result = await executeInWorker(
      'return { ok: true };',
      { _memory_mb: 9999 },
    );
    expect(result).toEqual({ ok: true });
  });

  // --- Cleanup ---

  it('handles rapid sequential executions without leaking Workers', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await executeInWorker('return { i: args.i };', { i }));
    }
    expect(results).toEqual([
      { i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 },
    ]);
  }, 15000);

  it('handles concurrent executions', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      executeInWorker('return { i: args.i };', { i }),
    );
    const results = await Promise.all(promises);
    expect(results).toEqual([
      { i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 },
    ]);
  }, 15000);
});
