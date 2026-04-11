import type { Tool } from 'ollama';
import { randomBytes } from 'node:crypto';
import { createTask, getTasksByChat } from '../../db-core.js';
import { computeNextRun, validateCron } from '../../scheduler.js';
import { logger } from '../../logger.js';

export const createReminderDefinition: Tool = {
  type: 'function',
  function: {
    name: 'create_reminder',
    description:
      'Create a reminder for the user. Call this when the user says things like "remind me", "don\'t let me forget", "follow up on", "check back on", or anything that implies they want to be notified about something later. You must determine the appropriate time and convert it to a cron expression.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'The reminder message to send to the user. Write it as if you are reminding them, e.g., "Hey, you asked me to remind you about your dentist appointment."',
        },
        cron: {
          type: 'string',
          description:
            'Cron expression for when to trigger. Use 5-field format (min hour day month weekday). Examples: "0 9 * * *" = daily at 9am, "30 14 25 3 *" = March 25 at 2:30pm, "0 8 * * 1" = every Monday at 8am. For one-time reminders, use a specific date.',
        },
        description: {
          type: 'string',
          description:
            'Short description of what this reminder is about (for listing purposes).',
        },
      },
      required: ['message', 'cron', 'description'],
    },
  },
};

export async function createReminder(
  args: { message: string; cron: string; description: string },
  chatId: string,
): Promise<Record<string, unknown>> {
  const { message, cron, description } = args;

  // Validate cron expression
  const cronError = validateCron(cron);
  if (cronError) {
    return { error: `Invalid cron expression "${cron}": ${cronError}` };
  }

  // Limit: max 20 tasks per chat
  const existing = await getTasksByChat(chatId);
  if (existing.length >= 20) {
    return {
      error: 'Too many scheduled tasks (max 20). Delete some with /schedule delete <id>.',
    };
  }

  // Create the task
  const taskId = randomBytes(8).toString('hex');
  const nextRun = computeNextRun(cron);

  // The prompt is the reminder message — when the scheduler runs it,
  // the notifyFn sends it directly to the user
  await createTask(taskId, chatId, message, cron, nextRun);

  const nextDate = new Date(nextRun);

  logger.info(
    { taskId, chatId, cron, nextRun: nextDate.toISOString(), description },
    'Reminder created via AI tool',
  );

  return {
    success: true,
    taskId: taskId.slice(0, 8),
    description,
    nextRun: nextDate.toLocaleString(),
    cron,
    message: `Reminder set! I'll notify you: "${description}" — next: ${nextDate.toLocaleString()}`,
  };
}
