import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  registerTool,
  unregisterTool,
  getToolEntry,
  executeRegisteredTool,
  getToolDefinitions as getRegistryDefinitions,
  listRegisteredTools,
  loadUserTools,
  type ToolEntry,
} from '../../forge/tool-registry.js';
import type { ToolProvider } from '../../core/interfaces.js';

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
import { capacityDefinition, capacityPlanning } from './capacity.js';
import { sequencerDefinition, jobSequencer } from './sequencer.js';
import { vsmDefinition, valueStreamMap } from './vsm.js';
import { tocDefinition, tocAnalysis } from './toc.js';
import { conwipDefinition, conwipHeijunka } from './conwip.js';
import { doeDefinition, designOfExperiments } from './doe.js';
import { fsmDefinition, stateMachineSimulator } from './fsm.js';

/**
 * Register all built-in tools in the dynamic registry.
 * Call once on startup.
 */
export function registerBuiltinTools(): void {
  const builtins: ToolEntry[] = [
    // ── Process 2 (tools): Network + compute, no DB ──
    {
      definition: webSearchDefinition,
      execute: async (args) => webSearch(args as { query: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: readFileDefinition,
      execute: async (args) => readFileTool(args as { path: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: runCommandDefinition,
      execute: async (args) => runCommand(args as { command: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: getTimeDefinition,
      execute: async () => getTime(),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: systemInfoDefinition,
      execute: async () => systemInfo(),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: summarizeUrlDefinition,
      execute: async (args) => summarizeUrl(args as { url: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubListReposDefinition,
      execute: async (args) => githubListRepos(args as { limit?: number }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubReadFileDefinition,
      execute: async (args) => githubReadFile(args as { repo: string; path: string; ref?: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubListIssuesDefinition,
      execute: async (args) => githubListIssues(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubListPrsDefinition,
      execute: async (args) => githubListPrs(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubCloneRepoDefinition,
      execute: async (args) => githubCloneRepo(args as { repo: string; branch?: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubDiffDefinition,
      execute: async (args) => githubDiff(args as { repo: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubCommitPushDefinition,
      execute: async (args) => githubCommitPush(args as { repo: string; message: string; branch?: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: githubCreatePrDefinition,
      execute: async (args) => githubCreatePr(args as { repo: string; title: string; body?: string; head: string; base?: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: renderListServicesDefinition,
      execute: async (args) => renderListServices(args as { limit?: number }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: renderDeployStatusDefinition,
      execute: async (args) => renderDeployStatus(args as { serviceId: string }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: renderGetLogsDefinition,
      execute: async (args) => renderGetLogs(args as { serviceId: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
    },
    {
      definition: takeScreenshotDefinition,
      execute: async (args) => takeScreenshot(args as { url: string; selector?: string; fullPage?: boolean }),
      source: 'builtin',
      process: 'tools',
    },
    // ── Process 3 (parsers): File I/O only, no network, no DB ──
    {
      definition: parseFileDefinition,
      execute: async (args) => parseFileTool(args as { path: string }),
      source: 'builtin',
      process: 'parsers',
    },
    {
      definition: generateDocumentDefinition,
      execute: async (args) => generateDocumentTool(args),
      source: 'builtin',
      process: 'parsers',
    },
    // ── Process 1 (core): DB-dependent tools ──
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
    {
      definition: kanbanManageDefinition,
      execute: async (args, chatId) =>
        kanbanManage(args as Parameters<typeof kanbanManage>[0], chatId),
      source: 'builtin',
    },
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
    // ── Manufacturing domain tools (core — all need DB) ──
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
    {
      definition: capacityDefinition,
      execute: async (args) =>
        capacityPlanning(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: sequencerDefinition,
      execute: async (args) =>
        jobSequencer(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: vsmDefinition,
      execute: async (args) =>
        valueStreamMap(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: tocDefinition,
      execute: async (args) =>
        tocAnalysis(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: conwipDefinition,
      execute: async (args) =>
        conwipHeijunka(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: doeDefinition,
      execute: async (args) =>
        designOfExperiments(args as Record<string, unknown>),
      source: 'builtin',
    },
    {
      definition: fsmDefinition,
      execute: async (args) =>
        stateMachineSimulator(args as Record<string, unknown>),
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

// ── IPC routing for multi-process architecture (SA3) ────────

import type { ProcessClient } from '../../ipc/client.js';

let toolsProcessClient: ProcessClient | null = null;
let parsersProcessClient: ProcessClient | null = null;

/**
 * Set the IPC clients for Process 2 (tools) and Process 3 (parsers).
 * Called from index.ts after spawning child processes.
 */
export function setProcessClients(
  tools: ProcessClient | null,
  parsers: ProcessClient | null,
): void {
  toolsProcessClient = tools;
  parsersProcessClient = parsers;
}

/**
 * Execute a tool by name with the given arguments.
 *
 * Routes to the appropriate process based on the tool's `process` classification:
 * - 'tools' → Process 2 via IPC (DB-free compute/network tools)
 * - 'parsers' → Process 3 via IPC (file parsing, tightest sandbox)
 * - 'core' or undefined → local execution in Process 1 (DB-dependent tools)
 *
 * Falls back to local execution if the target process is unavailable.
 * Never throws — returns { error: ... } on failure.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  logger.debug({ tool: name, args }, 'Executing tool');

  const entry = getToolEntry(name);
  const targetProcess = entry?.process;

  // Route to Process 2 (tools) if classified and client ready
  if (targetProcess === 'tools' && toolsProcessClient?.isReady) {
    return toolsProcessClient.execute(name, args, chatId);
  }

  // Route to Process 3 (parsers) if classified and client ready
  if (targetProcess === 'parsers' && parsersProcessClient?.isReady) {
    return parsersProcessClient.execute(name, args, chatId);
  }

  // Fallback: execute locally in Process 1
  // This handles: core tools, unclassified tools, or when child process is unavailable
  if (targetProcess && targetProcess !== 'core') {
    logger.debug({ tool: name, targetProcess }, 'Child process unavailable — executing locally');
  }

  return executeRegisteredTool(name, args, chatId);
}

/**
 * Create a ToolProvider backed by the in-memory tool registry.
 * Wraps existing registry functions behind the ToolProvider interface.
 */
export function createToolProvider(): ToolProvider {
  return {
    register: registerTool,
    unregister: unregisterTool,
    get: getToolEntry,
    execute: executeTool, // Uses IPC routing, not direct registry
    getDefinitions: getRegistryDefinitions,
    list: listRegisteredTools,
    loadUserTools,
  };
}

