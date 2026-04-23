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
  unregisterLocalTool,
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

import { executeInWorker } from './forge/worker-sandbox.js';
import { executeDeclarativeHttp } from './forge/declarative-http.js';

// ── Register DB-free builtin tools ──────────────────────────

const tools = [
  { def: webSearchDefinition, exec: async (args: any) => webSearch(args) },
  { def: readFileDefinition, exec: async (args: any) => readFileTool(args) },
  { def: runCommandDefinition, exec: async (args: any) => runCommand(args) },
  { def: getTimeDefinition, exec: async () => getTime() },
  { def: systemInfoDefinition, exec: async () => systemInfo() },
  { def: summarizeUrlDefinition, exec: async (args: any) => summarizeUrl(args) },
  { def: githubListReposDefinition, exec: async (args: any) => githubListRepos(args) },
  { def: githubReadFileDefinition, exec: async (args: any) => githubReadFile(args) },
  { def: githubListIssuesDefinition, exec: async (args: any) => githubListIssues(args) },
  { def: githubListPrsDefinition, exec: async (args: any) => githubListPrs(args) },
  { def: githubCloneRepoDefinition, exec: async (args: any) => githubCloneRepo(args) },
  { def: githubDiffDefinition, exec: async (args: any) => githubDiff(args) },
  { def: githubCommitPushDefinition, exec: async (args: any) => githubCommitPush(args) },
  { def: githubCreatePrDefinition, exec: async (args: any) => githubCreatePr(args) },
  { def: renderListServicesDefinition, exec: async (args: any) => renderListServices(args) },
  { def: renderDeployStatusDefinition, exec: async (args: any) => renderDeployStatus(args) },
  { def: renderGetLogsDefinition, exec: async (args: any) => renderGetLogs(args) },
  { def: takeScreenshotDefinition, exec: async (args: any) => takeScreenshot(args) },
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
