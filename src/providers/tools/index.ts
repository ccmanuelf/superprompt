import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  registerTool,
  executeRegisteredTool,
  getToolDefinitions as getRegistryDefinitions,
  type ToolEntry,
} from '../../forge/tool-registry.js';

import { webSearchDefinition, webSearch } from './web-search.js';
import { readFileDefinition, readFileTool } from './read-file.js';
import { runCommandDefinition, runCommand } from './run-command.js';
import { queryMemoryDefinition, queryMemory } from './query-memory.js';
import { saveMemoryDefinition, saveMemory } from './save-memory.js';
import { getTimeDefinition, getTime } from './get-time.js';
import { systemInfoDefinition, systemInfo } from './system-info.js';
import { summarizeUrlDefinition, summarizeUrl } from './summarize-url.js';
import { parseFileDefinition, parseFileTool } from './parse-file.js';
import { generateDocumentDefinition, generateDocumentTool } from './generate-document.js';
import { readBotLogsDefinition, readBotLogs } from './read-bot-logs.js';
import { createReminderDefinition, createReminder } from './create-reminder.js';
import {
  githubListReposDefinition, githubListRepos,
  githubReadFileDefinition, githubReadFile,
  githubListIssuesDefinition, githubListIssues,
  githubListPrsDefinition, githubListPrs,
  githubCloneRepoDefinition, githubCloneRepo,
  githubDiffDefinition, githubDiff,
  githubCommitPushDefinition, githubCommitPush,
  githubCreatePrDefinition, githubCreatePr,
} from './github.js';
import {
  renderListServicesDefinition, renderListServices,
  renderDeployStatusDefinition, renderDeployStatus,
  renderGetLogsDefinition, renderGetLogs,
} from './render-status.js';
import { takeScreenshotDefinition, takeScreenshot } from './screenshot.js';
import { kanbanManageDefinition, kanbanManage } from './kanban-manage.js';
import {
  searchPapersDefinition, searchPapers,
  manageCitationsDefinition, manageCitations,
  reviewReportDefinition, reviewReport,
} from './research.js';
import { lineBalanceDefinition, lineBalance } from './balance.js';
import { sigmaAnalysisDefinition, sigmaAnalysis } from './sigma.js';
import { inventoryPlanDefinition, inventoryPlan } from './inventory.js';
import { spcSetupDefinition, spcSetup } from './spc-setup.js';
import { fmeaManageDefinition, fmeaManage } from './fmea.js';
import { rcaManageDefinition, rcaManage } from './rca.js';
import { simulationDefinition, productionSimulation } from './simulation.js';
import { minizincOptimizeDefinition, minizincOptimize } from './minizinc-tool.js';

/**
 * Register all built-in tools in the dynamic registry.
 * Call once on startup.
 */
export function registerBuiltinTools(): void {
  const builtins: ToolEntry[] = [
    {
      definition: webSearchDefinition,
      execute: async (args) => webSearch(args as { query: string }),
      source: 'builtin',
    },
    {
      definition: readFileDefinition,
      execute: async (args) => readFileTool(args as { path: string }),
      source: 'builtin',
    },
    {
      definition: runCommandDefinition,
      execute: async (args) => runCommand(args as { command: string }),
      source: 'builtin',
    },
    {
      definition: queryMemoryDefinition,
      execute: async (args, chatId) =>
        queryMemory(args as { query: string; limit?: number }, chatId),
      source: 'builtin',
    },
    {
      definition: saveMemoryDefinition,
      execute: async (args, chatId) =>
        saveMemory(args as { content: string; sector?: string }, chatId),
      source: 'builtin',
    },
    {
      definition: getTimeDefinition,
      execute: async () => getTime(),
      source: 'builtin',
    },
    {
      definition: systemInfoDefinition,
      execute: async () => systemInfo(),
      source: 'builtin',
    },
    {
      definition: summarizeUrlDefinition,
      execute: async (args) => summarizeUrl(args as { url: string }),
      source: 'builtin',
    },
    {
      definition: parseFileDefinition,
      execute: async (args) => parseFileTool(args as { path: string }),
      source: 'builtin',
    },
    {
      definition: generateDocumentDefinition,
      execute: async (args) => generateDocumentTool(args),
      source: 'builtin',
    },
    {
      definition: readBotLogsDefinition,
      execute: async (args) => readBotLogs(args as { count?: number; level?: string }),
      source: 'builtin',
    },
    {
      definition: createReminderDefinition,
      execute: async (args, chatId) =>
        createReminder(args as { message: string; cron: string; description: string }, chatId),
      source: 'builtin',
    },
    // ── GitHub tools ──
    {
      definition: githubListReposDefinition,
      execute: async (args) => githubListRepos(args as { limit?: number }),
      source: 'builtin',
    },
    {
      definition: githubReadFileDefinition,
      execute: async (args) => githubReadFile(args as { repo: string; path: string; ref?: string }),
      source: 'builtin',
    },
    {
      definition: githubListIssuesDefinition,
      execute: async (args) => githubListIssues(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
    },
    {
      definition: githubListPrsDefinition,
      execute: async (args) => githubListPrs(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
    },
    {
      definition: githubCloneRepoDefinition,
      execute: async (args) => githubCloneRepo(args as { repo: string; branch?: string }),
      source: 'builtin',
    },
    {
      definition: githubDiffDefinition,
      execute: async (args) => githubDiff(args as { repo: string }),
      source: 'builtin',
    },
    {
      definition: githubCommitPushDefinition,
      execute: async (args) => githubCommitPush(args as { repo: string; message: string; branch?: string }),
      source: 'builtin',
    },
    {
      definition: githubCreatePrDefinition,
      execute: async (args) => githubCreatePr(args as { repo: string; title: string; body?: string; head: string; base?: string }),
      source: 'builtin',
    },
    // ── Render tools ──
    {
      definition: renderListServicesDefinition,
      execute: async (args) => renderListServices(args as { limit?: number }),
      source: 'builtin',
    },
    {
      definition: renderDeployStatusDefinition,
      execute: async (args) => renderDeployStatus(args as { serviceId: string }),
      source: 'builtin',
    },
    {
      definition: renderGetLogsDefinition,
      execute: async (args) => renderGetLogs(args as { serviceId: string; limit?: number }),
      source: 'builtin',
    },
    // ── Screenshot tool ──
    {
      definition: takeScreenshotDefinition,
      execute: async (args) => takeScreenshot(args as { url: string; selector?: string; fullPage?: boolean }),
      source: 'builtin',
    },
    // ── Kanban board ──
    {
      definition: kanbanManageDefinition,
      execute: async (args, chatId) =>
        kanbanManage(args as Parameters<typeof kanbanManage>[0], chatId),
      source: 'builtin',
    },
    // ── Research tools ──
    {
      definition: searchPapersDefinition,
      execute: async (args, chatId) =>
        searchPapers(args as Parameters<typeof searchPapers>[0], chatId),
      source: 'builtin',
    },
    {
      definition: manageCitationsDefinition,
      execute: async (args, chatId) =>
        manageCitations(args as Parameters<typeof manageCitations>[0], chatId),
      source: 'builtin',
    },
    {
      definition: reviewReportDefinition,
      execute: async (args) =>
        reviewReport(args as Parameters<typeof reviewReport>[0]),
      source: 'builtin',
    },
    // ── Manufacturing tools ──
    {
      definition: lineBalanceDefinition,
      execute: async (args, chatId) =>
        lineBalance(args as Parameters<typeof lineBalance>[0], chatId),
      source: 'builtin',
    },
    {
      definition: sigmaAnalysisDefinition,
      execute: async (args, chatId) =>
        sigmaAnalysis(args as Parameters<typeof sigmaAnalysis>[0], chatId),
      source: 'builtin',
    },
    {
      definition: inventoryPlanDefinition,
      execute: async (args, chatId) =>
        inventoryPlan(args as Parameters<typeof inventoryPlan>[0], chatId),
      source: 'builtin',
    },
    {
      definition: spcSetupDefinition,
      execute: async (args, chatId) =>
        spcSetup(args as Record<string, unknown>, chatId),
      source: 'builtin',
    },
    {
      definition: fmeaManageDefinition,
      execute: async (args, chatId) =>
        fmeaManage(args as Record<string, unknown>, chatId),
      source: 'builtin',
    },
    {
      definition: rcaManageDefinition,
      execute: async (args, chatId) =>
        rcaManage(args as Record<string, unknown>, chatId),
      source: 'builtin',
    },
    // ── Simulation tools ──
    {
      definition: simulationDefinition,
      execute: async (args) =>
        productionSimulation(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: minizincOptimizeDefinition,
      execute: async (args) =>
        minizincOptimize(args as Record<string, unknown>),
      source: 'builtin',
    },
  ];

  for (const entry of builtins) {
    registerTool(entry);
  }

  logger.info({ count: builtins.length }, 'Built-in tools registered');
}

/** Get all tool definitions (builtin + user), optionally filtered */
export function getToolDefinitions(allowedTools?: string[]): Tool[] {
  return getRegistryDefinitions(allowedTools);
}

/**
 * Execute a tool by name with the given arguments.
 * Delegates to the dynamic registry.
 * Never throws — returns { error: ... } on failure.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  logger.debug({ tool: name, args }, 'Executing tool');
  return executeRegisteredTool(name, args, chatId);
}

