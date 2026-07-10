/**
 * luna-tools — Process 2 entry point.
 *
 * Stateless tool executor for DB-free tools:
 * - Network tools: web_search, summarize_url, github_*, render_*
 * - Compute tools: get_time, system_info, read_file, run_command
 * - Screenshot: take_screenshot (Chromium)
 * - User-generated code: Worker sandbox (SA1)
 * - User declarative HTTP tools
 *
 * Security boundary: NO database access, NO bot tokens.
 * Only receives whitelisted env vars (API keys for web services).
 *
 * Spawned by Process 1 via child_process.fork().
 */

import {
  registerLocalTool,
  setUserToolHandler,
  startIPCServer,
} from './ipc/server.js';

import { webSearchDefinition, webSearch } from './providers/tools/web-search.js';
import { readFileDefinition, readFileTool } from './providers/tools/read-file.js';
import { runCommandDefinition, runCommand } from './providers/tools/run-command.js';
import { getTimeDefinition, getTime } from './providers/tools/get-time.js';
import { systemInfoDefinition, systemInfo } from './providers/tools/system-info.js';
import { summarizeUrlDefinition, summarizeUrl } from './providers/tools/summarize-url.js';
import {
  githubListReposDefinition, githubListRepos,
  githubReadFileDefinition, githubReadFile,
  githubListIssuesDefinition, githubListIssues,
  githubListPrsDefinition, githubListPrs,
  githubCloneRepoDefinition, githubCloneRepo,
  githubDiffDefinition, githubDiff,
  githubCommitPushDefinition, githubCommitPush,
  githubCreatePrDefinition, githubCreatePr,
} from './providers/tools/github.js';
import {
  renderListServicesDefinition, renderListServices,
  renderDeployStatusDefinition, renderDeployStatus,
  renderGetLogsDefinition, renderGetLogs,
} from './providers/tools/render-status.js';
import { takeScreenshotDefinition, takeScreenshot } from './providers/tools/screenshot.js';
import {
  novalinkListQueriesDefinition, novalinkListQueries,
  novalinkQueryDefinition, novalinkQuery,
  novalinkHealthDefinition, novalinkHealth,
} from './providers/tools/novalink.js';
import {
  samSearchDefinition, samSearch,
  samGetAnalysisDefinition, samGetAnalysis,
  samCreateDefinition, samCreate,
  samGenerateDefinition, samGenerate,
  samSetStatusDefinition, samSetStatus,
  samExportDefinition, samExport,
  samHealthDefinition, samHealth,
} from './providers/tools/sam.js';

import { executeInWorker } from './forge/worker-sandbox.js';
import { executeDeclarativeHttp } from './forge/declarative-http.js';
import type { Tool } from 'ollama';

// ── Register DB-free builtin tools ──────────────────────────

/**
 * Bind a typed tool implementation to its definition. Runtime args arrive as
 * untyped JSON (validated by the model against def.parameters); this is the
 * single place that cast happens, so each call site below stays checked
 * against its tool's real argument interface.
 */
function tool<A>(def: Tool, fn: (args: A) => unknown) {
  return {
    def,
    exec: async (args: Record<string, unknown>) =>
      (await fn(args as A)) as Record<string, unknown>,
  };
}

const tools = [
  tool(webSearchDefinition, webSearch),
  tool(readFileDefinition, readFileTool),
  tool(runCommandDefinition, runCommand),
  tool(getTimeDefinition, getTime),
  tool(systemInfoDefinition, systemInfo),
  tool(summarizeUrlDefinition, summarizeUrl),
  tool(githubListReposDefinition, githubListRepos),
  tool(githubReadFileDefinition, githubReadFile),
  tool(githubListIssuesDefinition, githubListIssues),
  tool(githubListPrsDefinition, githubListPrs),
  tool(githubCloneRepoDefinition, githubCloneRepo),
  tool(githubDiffDefinition, githubDiff),
  tool(githubCommitPushDefinition, githubCommitPush),
  tool(githubCreatePrDefinition, githubCreatePr),
  tool(renderListServicesDefinition, renderListServices),
  tool(renderDeployStatusDefinition, renderDeployStatus),
  tool(renderGetLogsDefinition, renderGetLogs),
  tool(takeScreenshotDefinition, takeScreenshot),
  tool(novalinkListQueriesDefinition, novalinkListQueries),
  tool(novalinkQueryDefinition, novalinkQuery),
  tool(novalinkHealthDefinition, novalinkHealth),
  tool(samSearchDefinition, samSearch),
  tool(samGetAnalysisDefinition, samGetAnalysis),
  tool(samCreateDefinition, samCreate),
  tool(samGenerateDefinition, samGenerate),
  tool(samSetStatusDefinition, samSetStatus),
  tool(samExportDefinition, samExport),
  tool(samHealthDefinition, samHealth),
];

for (const { def, exec } of tools) {
  registerLocalTool({
    definition: def,
    execute: exec,
    source: 'builtin',
    process: 'tools',
  });
}

// ── Handle user tool registration from Process 1 ────────────

setUserToolHandler((msg) => {
  const config = JSON.parse(msg.config);

  if (msg.toolType === 'generated_code') {
    const code = config.code as string;
    if (!code) return;

    registerLocalTool({
      definition: msg.definition,
      execute: async (args) => executeInWorker(code, args),
      source: 'user',
      process: 'tools',
    });
  } else if (msg.toolType === 'declarative_http') {
    const endpoint = config.endpoint;
    if (!endpoint) return;

    registerLocalTool({
      definition: msg.definition,
      execute: async (args) => executeDeclarativeHttp(endpoint, args),
      source: 'user',
      process: 'tools',
    });
  }
});

// ── Start IPC server ────────────────────────────────────────

startIPCServer('tools');
