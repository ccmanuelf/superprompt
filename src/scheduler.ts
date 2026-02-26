import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, type ScheduledTask } from './db.js';
import { logger } from './logger.js';
import type { ProviderRouter } from './providers/router.js';

export type NotifyFn = (chatId: string, text: string) => Promise<void>;

const POLL_INTERVAL_MS = 60_000; // Poll every 60 seconds

let pollTimer: ReturnType<typeof setInterval> | undefined;
let notifyCallback: NotifyFn | undefined;

/**
 * Compute the next run timestamp for a cron expression.
 * Returns epoch milliseconds.
 */
export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression);
  return expr.next().getTime();
}

/**
 * Validate a cron expression.
 * Returns null if valid, or an error message if invalid.
 */
export function validateCron(cronExpression: string): string | null {
  try {
    CronExpressionParser.parse(cronExpression);
    return null;
  } catch (err) {
    return `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run all due tasks. Called by the poll loop.
 */
async function runDueTasks(router: ProviderRouter): Promise<void> {
  const tasks = getDueTasks();

  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const task of tasks) {
    await runTask(task, router);
  }
}

async function runTask(
  task: ScheduledTask,
  router: ProviderRouter,
): Promise<void> {
  logger.info(
    { taskId: task.id, chatId: task.chat_id, prompt: task.prompt.slice(0, 80) },
    'Executing scheduled task',
  );

  try {
    const response = await router.sendMessage({
      chatId: task.chat_id,
      message: task.prompt,
    });

    const resultText = response.text || '(no response)';

    // Compute next run
    const nextRun = computeNextRun(task.schedule);
    updateTaskAfterRun(task.id, nextRun, resultText.slice(0, 1000));

    // Notify the user with the result
    if (notifyCallback) {
      try {
        await notifyCallback(task.chat_id, resultText);
      } catch (err) {
        logger.warn({ err, taskId: task.id }, 'Failed to notify user of scheduled task result');
      }
    }

    logger.info(
      { taskId: task.id, nextRun: new Date(nextRun).toISOString() },
      'Scheduled task completed',
    );
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Scheduled task failed');

    // Still advance next_run so we don't keep retrying a broken task
    try {
      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(
        task.id,
        nextRun,
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // If cron parsing also fails, something is very wrong
      logger.error({ taskId: task.id }, 'Failed to compute next run for task');
    }
  }
}

/**
 * Initialize the scheduler. Starts polling for due tasks.
 *
 * @param router - The provider router to send task messages through.
 * @returns A function to stop the scheduler.
 */
export function initScheduler(router: ProviderRouter, notifyFn?: NotifyFn): () => void {
  notifyCallback = notifyFn;

  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS },
    'Scheduler initialized',
  );

  // Run immediately on startup
  runDueTasks(router).catch((err) => {
    logger.error({ err }, 'Initial due task run failed');
  });

  // Then poll on interval
  pollTimer = setInterval(() => {
    runDueTasks(router).catch((err) => {
      logger.error({ err }, 'Scheduled task poll failed');
    });
  }, POLL_INTERVAL_MS);

  return () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      logger.info('Scheduler stopped');
    }
  };
}
