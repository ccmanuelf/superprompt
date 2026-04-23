#!/usr/bin/env tsx
/**
 * CLI for managing scheduled tasks.
 *
 * Usage:
 *   npx tsx src/schedule-cli.ts create <chat_id> "prompt" "cron"
 *   npx tsx src/schedule-cli.ts list [chat_id]
 *   npx tsx src/schedule-cli.ts pause <task_id>
 *   npx tsx src/schedule-cli.ts resume <task_id>
 *   npx tsx src/schedule-cli.ts delete <task_id>
 *   npx tsx src/schedule-cli.ts show <task_id>
 */

import { randomBytes } from 'node:crypto';
import {
  createTask,
  getTasksByChat,
  getTask,
  pauseTask,
  resumeTask,
  deleteTask,
  getDueTasks,
} from './db-core.js';
import { initKnex, readDbConfig } from './db-knex.js';
import { computeNextRun, validateCron } from './scheduler.js';

// Initialize database via Knex
initKnex(readDbConfig());

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`
luna schedule-cli — Manage scheduled tasks

Commands:
  create <chat_id> "<prompt>" "<cron>"   Create a new task
  list [chat_id]                         List tasks (optionally by chat)
  show <task_id>                         Show task details
  pause <task_id>                        Pause a task
  resume <task_id>                       Resume a paused task
  delete <task_id>                       Delete a task
  due                                    Show tasks that are due now

Examples:
  create 123456 "Check the weather" "0 8 * * *"
  create 123456 "Summarize daily news" "0 7 * * 1-5"
  list
  list 123456
  pause abc123
  resume abc123
  delete abc123
  `.trim());
}

function formatDate(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function generateId(): string {
  return randomBytes(6).toString('hex');
}

(async () => {
switch (command) {
  case 'create': {
    const chatId = args[1];
    const prompt = args[2];
    const cron = args[3];

    if (!chatId || !prompt || !cron) {
      console.error('Usage: create <chat_id> "<prompt>" "<cron>"');
      process.exit(1);
    }

    const cronError = validateCron(cron);
    if (cronError) {
      console.error(cronError);
      process.exit(1);
    }

    const id = generateId();
    const nextRun = computeNextRun(cron);
    await createTask(id, chatId, prompt, cron, nextRun);

    console.log(`Task created:`);
    console.log(`  ID:       ${id}`);
    console.log(`  Chat:     ${chatId}`);
    console.log(`  Prompt:   ${prompt}`);
    console.log(`  Schedule: ${cron}`);
    console.log(`  Next run: ${formatDate(nextRun)}`);
    break;
  }

  case 'list': {
    const chatId = args[1];
    const tasks = chatId
      ? await getTasksByChat(chatId)
      : await getDueTasks();

    if (chatId) {
      const allTasks = await getTasksByChat(chatId);
      if (allTasks.length === 0) {
        console.log('No tasks found.');
        break;
      }
      console.log(`Tasks for chat ${chatId}:\n`);
      for (const t of allTasks) {
        console.log(`  [${t.status}] ${t.id} — "${t.prompt.slice(0, 60)}" (${t.schedule})`);
        console.log(`    Next: ${formatDate(t.next_run)} | Last: ${formatDate(t.last_run)}`);
      }
    } else {
      // List all due tasks
      if (tasks.length === 0) {
        console.log('No due tasks. Use "list <chat_id>" to see all tasks for a chat.');
        break;
      }
      console.log(`Due tasks:\n`);
      for (const t of tasks) {
        console.log(`  ${t.id} — chat:${t.chat_id} — "${t.prompt.slice(0, 60)}" (${t.schedule})`);
      }
    }
    break;
  }

  case 'show': {
    const taskId = args[1];
    if (!taskId) {
      console.error('Usage: show <task_id>');
      process.exit(1);
    }
    const task = await getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }
    console.log(`Task: ${task.id}`);
    console.log(`  Status:      ${task.status}`);
    console.log(`  Chat:        ${task.chat_id}`);
    console.log(`  Prompt:      ${task.prompt}`);
    console.log(`  Schedule:    ${task.schedule}`);
    console.log(`  Next run:    ${formatDate(task.next_run)}`);
    console.log(`  Last run:    ${formatDate(task.last_run)}`);
    console.log(`  Last result: ${task.last_result?.slice(0, 200) || '(none)'}`);
    console.log(`  Created:     ${formatDate(task.created_at)}`);
    break;
  }

  case 'pause': {
    const taskId = args[1];
    if (!taskId) {
      console.error('Usage: pause <task_id>');
      process.exit(1);
    }
    await pauseTask(taskId);
    console.log(`Task ${taskId} paused.`);
    break;
  }

  case 'resume': {
    const taskId = args[1];
    if (!taskId) {
      console.error('Usage: resume <task_id>');
      process.exit(1);
    }
    await resumeTask(taskId);
    console.log(`Task ${taskId} resumed.`);
    break;
  }

  case 'delete': {
    const taskId = args[1];
    if (!taskId) {
      console.error('Usage: delete <task_id>');
      process.exit(1);
    }
    await deleteTask(taskId);
    console.log(`Task ${taskId} deleted.`);
    break;
  }

  case 'due': {
    const tasks = await getDueTasks();
    if (tasks.length === 0) {
      console.log('No tasks are due right now.');
      break;
    }
    console.log(`${tasks.length} task(s) due:\n`);
    for (const t of tasks) {
      console.log(`  ${t.id} — chat:${t.chat_id} — "${t.prompt.slice(0, 60)}"`);
      console.log(`    Due since: ${formatDate(t.next_run)}`);
    }
    break;
  }

  default:
    usage();
    break;
}
})().catch(console.error);
