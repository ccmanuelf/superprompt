/**
 * Background task queue — non-blocking execution for long-running operations.
 *
 * When a user requests a heavy computation (1000 Monte Carlo runs, large DOE),
 * the task is queued and executed asynchronously. The user gets:
 * 1. An immediate acknowledgment
 * 2. A notification when the task completes (with results)
 *
 * Architecture:
 * - Tasks run in the main Node.js event loop (not Worker threads)
 *   because they need access to the database and tool registry
 * - A simple FIFO queue with concurrent limit prevents overload
 * - Results are delivered via the app.notify() channel
 */

import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────

export interface BackgroundTask {
  id: string;
  chatId: string;
  description: string;
  execute: () => Promise<string>;  // Returns result text
  createdAt: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

type NotifyFn = (chatId: string, text: string) => Promise<void>;

// ── Queue ──────────────────────────────────────────────────

const MAX_CONCURRENT = 2; // Max simultaneous background tasks
/**
 * Hard cap on the queue depth. A single user spamming Monte Carlo runs would
 * otherwise grow this array without bound. 200 is well above any realistic
 * burst (humans queue dozens, not hundreds) but bounded enough that the
 * worst-case heap footprint stays predictable.
 */
const MAX_QUEUE_DEPTH = 200;
/** Per-chat cap so one user can't starve the rest of the queue. */
const MAX_QUEUE_PER_CHAT = 25;
const taskQueue: BackgroundTask[] = [];
const activeTasks = new Map<string, BackgroundTask>();
let notifyFn: NotifyFn | null = null;

export class BackgroundQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundQueueFullError';
  }
}

/**
 * Initialize the background task system.
 */
export function initBackgroundTasks(notify: NotifyFn): void {
  notifyFn = notify;
  logger.info('Background task queue initialized');
}

/**
 * Submit a task for background execution.
 * Returns immediately with a task ID and acknowledgment message.
 */
export function submitBackgroundTask(
  chatId: string,
  description: string,
  executeFn: () => Promise<string>,
): { taskId: string; message: string } {
  // Backpressure — refuse new work instead of growing the queue without
  // bound. Both checks return the same exception type so the platform layer
  // can render one error message either way.
  if (taskQueue.length >= MAX_QUEUE_DEPTH) {
    throw new BackgroundQueueFullError(
      `Background queue is at capacity (${MAX_QUEUE_DEPTH}). Wait for current tasks to finish before submitting more.`,
    );
  }
  const ownedByChat = taskQueue.reduce((n, t) => n + (t.chatId === chatId ? 1 : 0), 0);
  if (ownedByChat >= MAX_QUEUE_PER_CHAT) {
    throw new BackgroundQueueFullError(
      `You already have ${ownedByChat} tasks queued (cap: ${MAX_QUEUE_PER_CHAT}). Wait for some to finish.`,
    );
  }

  const id = randomBytes(8).toString('hex');

  const task: BackgroundTask = {
    id,
    chatId,
    description,
    execute: executeFn,
    createdAt: Date.now(),
    status: 'queued',
  };

  taskQueue.push(task);
  logger.info({ taskId: id, chatId, description, queueDepth: taskQueue.length }, 'Background task queued');

  // Trigger processing
  processQueue();

  const position = taskQueue.length;
  const message = `⏳ **Task queued / Tarea en cola**: ${description}\n` +
    `ID: \`${id}\`\n` +
    `Position / Posición: ${position} in queue / en cola, ${activeTasks.size} running / en ejecución\n` +
    `You'll be notified when it completes. / Se te notificará cuando termine.`;

  return { taskId: id, message };
}

/**
 * Get the status of all tasks for a chat.
 */
export function getBackgroundTaskStatus(chatId: string): Array<{
  id: string;
  description: string;
  status: string;
  elapsed?: string;
}> {
  const results: Array<{ id: string; description: string; status: string; elapsed?: string }> = [];

  // Active tasks
  for (const task of activeTasks.values()) {
    if (task.chatId === chatId) {
      const elapsed = Math.round((Date.now() - task.createdAt) / 1000);
      results.push({
        id: task.id,
        description: task.description,
        status: 'running',
        elapsed: `${elapsed}s`,
      });
    }
  }

  // Queued tasks
  for (const task of taskQueue) {
    if (task.chatId === chatId) {
      results.push({
        id: task.id,
        description: task.description,
        status: 'queued',
      });
    }
  }

  return results;
}

// ── Processing ─────────────────────────────────────────────

function processQueue(): void {
  while (activeTasks.size < MAX_CONCURRENT && taskQueue.length > 0) {
    const task = taskQueue.shift()!;
    task.status = 'running';
    activeTasks.set(task.id, task);

    // Execute asynchronously
    runTask(task).catch(() => {});
  }
}

async function runTask(task: BackgroundTask): Promise<void> {
  const startTime = Date.now();

  logger.info({ taskId: task.id, chatId: task.chatId }, 'Background task started');

  try {
    const result = await task.execute();
    task.status = 'completed';
    task.result = result;

    const durationSec = Math.round((Date.now() - startTime) / 1000);

    logger.info(
      { taskId: task.id, chatId: task.chatId, durationSec },
      'Background task completed',
    );

    // Notify user
    if (notifyFn) {
      const resultPreview = result.length > 500 ? result.slice(0, 500) + '...' : result;
      await notifyFn(
        task.chatId,
        `✅ **Task completed / Tarea completada** (${durationSec}s)\n` +
        `${task.description}\n\n${resultPreview}`,
      );
    }
  } catch (err) {
    task.status = 'failed';
    task.error = (err as Error).message;

    const durationSec = Math.round((Date.now() - startTime) / 1000);

    logger.error(
      { taskId: task.id, chatId: task.chatId, err, durationSec },
      'Background task failed',
    );

    if (notifyFn) {
      await notifyFn(
        task.chatId,
        `❌ **Task failed / Tarea fallida** (${durationSec}s)\n` +
        `${task.description}\n\nError: ${(err as Error).message}`,
      );
    }
  } finally {
    activeTasks.delete(task.id);
    // Process next task in queue
    processQueue();
  }
}
