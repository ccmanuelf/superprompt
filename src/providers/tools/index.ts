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
import type { ToolProvider, ToolPolicy } from '../../core/interfaces.js';
import { registerToolPolicy } from '../../policy-engine.js';

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
import { readDocumentationDefinition, readDocumentationTool } from './read-documentation.js';
import { searchDocumentationDefinition, searchDocumentationTool } from './search-documentation.js';
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
import {
  novalinkListQueriesDefinition, novalinkListQueries,
  novalinkQueryDefinition, novalinkQuery,
  novalinkHealthDefinition, novalinkHealth,
} from './novalink.js';
import { takeScreenshotDefinition, takeScreenshot } from './screenshot.js';
import { kanbanManageDefinition, kanbanManage } from './kanban-manage.js';
import {
  searchPapersDefinition, searchPapers,
  manageCitationsDefinition, manageCitations,
  reviewReportDefinition, reviewReport,
} from './research.js';

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
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: readFileDefinition,
      execute: async (args) => readFileTool(args as { path: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['filesystem:read'], requiresConfirmation: false },
    },
    {
      definition: runCommandDefinition,
      execute: async (args) => runCommand(args as { command: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'critical', scopes: ['command'], requiresConfirmation: true },
    },
    {
      definition: getTimeDefinition,
      execute: async () => getTime(),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'low', scopes: ['stateless'], requiresConfirmation: false },
    },
    {
      definition: systemInfoDefinition,
      execute: async () => systemInfo(),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'low', scopes: ['stateless'], requiresConfirmation: false },
    },
    {
      definition: summarizeUrlDefinition,
      execute: async (args) => summarizeUrl(args as { url: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: githubListReposDefinition,
      execute: async (args) => githubListRepos(args as { limit?: number }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: githubReadFileDefinition,
      execute: async (args) => githubReadFile(args as { repo: string; path: string; ref?: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: githubListIssuesDefinition,
      execute: async (args) => githubListIssues(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: githubListPrsDefinition,
      execute: async (args) => githubListPrs(args as { repo: string; state?: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: githubCloneRepoDefinition,
      execute: async (args) => githubCloneRepo(args as { repo: string; branch?: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'critical', scopes: ['network', 'filesystem:write'], requiresConfirmation: true },
    },
    {
      definition: githubDiffDefinition,
      execute: async (args) => githubDiff(args as { repo: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network', 'command'], requiresConfirmation: false },
    },
    {
      definition: githubCommitPushDefinition,
      execute: async (args) => githubCommitPush(args as { repo: string; message: string; branch?: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'critical', scopes: ['network', 'command'], requiresConfirmation: true },
    },
    {
      definition: githubCreatePrDefinition,
      execute: async (args) => githubCreatePr(args as { repo: string; title: string; body?: string; head: string; base?: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: renderListServicesDefinition,
      execute: async (args) => renderListServices(args as { limit?: number }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: renderDeployStatusDefinition,
      execute: async (args) => renderDeployStatus(args as { serviceId: string }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: renderGetLogsDefinition,
      execute: async (args) => renderGetLogs(args as { serviceId: string; limit?: number }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: novalinkListQueriesDefinition,
      execute: async () => novalinkListQueries(),
      source: 'builtin',
      process: 'tools',
      packName: 'novalink',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: novalinkQueryDefinition,
      execute: async (args) => novalinkQuery(args as { slug?: string; params?: string }),
      source: 'builtin',
      process: 'tools',
      packName: 'novalink',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: novalinkHealthDefinition,
      execute: async () => novalinkHealth(),
      source: 'builtin',
      process: 'tools',
      packName: 'novalink',
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
    },
    {
      definition: takeScreenshotDefinition,
      execute: async (args) => takeScreenshot(args as { url: string; selector?: string; fullPage?: boolean }),
      source: 'builtin',
      process: 'tools',
      policy: { riskLevel: 'high', scopes: ['browser', 'network'], requiresConfirmation: false },
    },
    // ── Process 3 (parsers): File I/O only, no network, no DB ──
    {
      definition: parseFileDefinition,
      execute: async (args) => parseFileTool(args as { path: string }),
      source: 'builtin',
      process: 'parsers',
      policy: { riskLevel: 'high', scopes: ['filesystem:read'], requiresConfirmation: false },
    },
    {
      definition: generateDocumentDefinition,
      execute: async (args) => generateDocumentTool(args),
      source: 'builtin',
      process: 'parsers',
      policy: { riskLevel: 'high', scopes: ['filesystem:write'], requiresConfirmation: false },
    },
    // rc.109 — doc-aware Luna: read-only access to the project's own
    // documentation. Server-side static files; manifest-gated; no PII;
    // safe to ship at low risk without confirmation.
    {
      definition: readDocumentationDefinition,
      execute: async (args) => readDocumentationTool(args as { filename: string; offset?: number }),
      source: 'builtin',
      process: 'parsers',
      policy: { riskLevel: 'low', scopes: ['filesystem:read'], requiresConfirmation: false },
    },
    {
      definition: searchDocumentationDefinition,
      execute: async (args) => searchDocumentationTool(args as { query: string; max?: number }),
      source: 'builtin',
      process: 'parsers',
      policy: { riskLevel: 'low', scopes: ['filesystem:read'], requiresConfirmation: false },
    },
    // ── Process 1 (core): DB-dependent tools ──
    {
      definition: queryMemoryDefinition,
      execute: async (args, chatId) =>
        queryMemory(args as { query: string; limit?: number }, chatId),
      source: 'builtin',
      policy: { riskLevel: 'low', scopes: ['database:read'], requiresConfirmation: false },
    },
    {
      definition: saveMemoryDefinition,
      execute: async (args, chatId) =>
        saveMemory(args as { content: string; sector?: string }, chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: readBotLogsDefinition,
      execute: async (args) => readBotLogs(args as { count?: number; level?: string }),
      source: 'builtin',
      policy: { riskLevel: 'low', scopes: ['filesystem:read'], requiresConfirmation: false },
    },
    {
      definition: createReminderDefinition,
      execute: async (args, chatId) =>
        createReminder(args as { message: string; cron: string; description: string }, chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: kanbanManageDefinition,
      execute: async (args, chatId) =>
        kanbanManage(args as Parameters<typeof kanbanManage>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: searchPapersDefinition,
      execute: async (args, chatId) =>
        searchPapers(args as Parameters<typeof searchPapers>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['network', 'database:write'], requiresConfirmation: false },
    },
    {
      definition: manageCitationsDefinition,
      execute: async (args, chatId) =>
        manageCitations(args as Parameters<typeof manageCitations>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: reviewReportDefinition,
      execute: async (args) =>
        reviewReport(args as Parameters<typeof reviewReport>[0]),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:read'], requiresConfirmation: false },
    },
  ];

  for (const entry of builtins) {
    registerTool(entry);
    if (entry.policy) {
      registerToolPolicy(entry.definition.function.name!, entry.policy);
    }
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
import { evaluatePolicy } from '../../policy-engine.js';

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  const startTime = Date.now();

  // SA4: Policy enforcement — check before execution
  const policyDecision = await evaluatePolicy(name, chatId);
  if (!policyDecision.allowed) {
    logger.info({ tool: name, chatId, action: 'blocked', reason: policyDecision.reason }, 'AUDIT: tool execution blocked by policy');
    return { error: policyDecision.reason || 'Tool execution blocked by policy' };
  }
  if (policyDecision.requiresConfirmation) {
    logger.info({ tool: name, chatId, action: 'pending_confirmation' }, 'AUDIT: tool awaiting user confirmation');
    return {
      _confirmation_required: true,
      _confirmation_prompt: policyDecision.confirmationPrompt,
      _tool: name,
      _args: args,
      _chatId: chatId,
    } as Record<string, unknown>;
  }

  const entry = getToolEntry(name);
  const targetProcess = entry?.process;

  let result: Record<string, unknown>;
  let executionProcess = 'core';

  try {
    // Route to Process 2 (tools) if classified and client ready
    if (targetProcess === 'tools' && toolsProcessClient?.isReady) {
      executionProcess = 'tools';
      result = await toolsProcessClient.execute(name, args, chatId);
    } else if (targetProcess === 'parsers' && parsersProcessClient?.isReady) {
      executionProcess = 'parsers';
      result = await parsersProcessClient.execute(name, args, chatId);
    } else {
      if (targetProcess && targetProcess !== 'core') {
        logger.debug({ tool: name, targetProcess }, 'Child process unavailable — executing locally');
      }
      result = await executeRegisteredTool(name, args, chatId);
    }

    // Audit log: successful execution
    const durationMs = Date.now() - startTime;
    const success = !('error' in result);
    logger.info({
      tool: name,
      chatId,
      action: success ? 'success' : 'error',
      process: executionProcess,
      durationMs,
      argsKeys: Object.keys(args),
    }, `AUDIT: tool ${success ? 'executed' : 'returned error'}`);

  } catch (err) {
    // Audit log: execution failure
    const durationMs = Date.now() - startTime;
    logger.error({
      tool: name,
      chatId,
      action: 'exception',
      process: executionProcess,
      durationMs,
      error: (err as Error).message,
    }, 'AUDIT: tool execution threw exception');
    throw err;
  }

  // Pack tuner: record outcome for BOTH providers (Claude + Ollama)
  try {
    const { getToolPackName, recordPackToolOutcome } = await import('../../pack-tuner.js');
    const packName = await getToolPackName(name, entry?.packName);
    if (packName) {
      await recordPackToolOutcome(packName, chatId, !('error' in result));
    }
  } catch { /* pack tuner not loaded */ }

  return result;
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

