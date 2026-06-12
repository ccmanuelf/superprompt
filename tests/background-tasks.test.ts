import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  initBackgroundTasks,
  submitBackgroundTask,
  getBackgroundTaskStatus,
} from '../src/background-tasks.js';

/** Poll until `cond` holds — event-driven wait instead of fixed sleeps (flake-proof on slow CI). */
async function waitFor(cond: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 10));
  }
}

describe('background-tasks', () => {
  let notifications: Array<{ chatId: string; text: string }>;

  beforeEach(() => {
    notifications = [];
    initBackgroundTasks(async (chatId, text) => {
      notifications.push({ chatId, text });
    });
  });

  it('submits a task and returns acknowledgment', async () => {
    const { taskId, message } = submitBackgroundTask(
      'chat1',
      'Run 1000 Monte Carlo simulations',
      async () => 'Results: 95% CI = [340, 485]',
    );

    expect(taskId).toHaveLength(16);
    expect(message).toContain('Task queued');
    expect(message).toContain('Monte Carlo');

    // Drain: the queue is module-global, so an undrained task would complete
    // during a later test and pollute that test's notifications array.
    await waitFor(() => notifications.length === 1);
  });

  it('executes task and notifies on completion', async () => {
    submitBackgroundTask(
      'chat1',
      'Heavy computation',
      async () => {
        await new Promise(r => setTimeout(r, 50)); // simulated workload (proves async execution)
        return 'Done: result = 42';
      },
    );

    // Wait for task to complete (event-driven, not a fixed sleep)
    await waitFor(() => notifications.length === 1);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].chatId).toBe('chat1');
    expect(notifications[0].text).toContain('completed');
    expect(notifications[0].text).toContain('Done: result = 42');
  });

  it('notifies on task failure', async () => {
    submitBackgroundTask(
      'chat1',
      'Will fail',
      async () => { throw new Error('Out of memory'); },
    );

    await waitFor(() => notifications.length === 1);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].text).toContain('failed');
    expect(notifications[0].text).toContain('Out of memory');
  });

  it('shows task status', async () => {
    submitBackgroundTask('chat1', 'Task A', async () => 'a');
    submitBackgroundTask('chat1', 'Task B', async () => 'b');
    submitBackgroundTask('chat2', 'Task C', async () => 'c');

    const status = getBackgroundTaskStatus('chat1');
    // At least one should be running or queued for chat1
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status.every(s => s.description.includes('Task A') || s.description.includes('Task B'))).toBe(true);

    // Drain all three before the next test (module-global queue — see above).
    await waitFor(() => notifications.length === 3);
  });

  it('respects max concurrent limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const makeTask = () => submitBackgroundTask('chat1', 'concurrent', async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 100)); // simulated workload — must overlap so concurrency is observable
      running--;
      return 'done';
    });

    // Submit 4 tasks — max concurrent is 2
    makeTask();
    makeTask();
    makeTask();
    makeTask();

    await waitFor(() => notifications.length === 4);

    // Max concurrent should be 2
    expect(maxRunning).toBeLessThanOrEqual(2);
    // All 4 should have completed
    expect(notifications).toHaveLength(4);
  });
});
