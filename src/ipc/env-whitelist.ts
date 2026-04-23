/**
 * Environment variable whitelists per child process.
 *
 * Security boundary: child processes only receive the env vars they need.
 * DB paths, bot tokens, and OAuth tokens never leave Process 1.
 */

/**
 * Process 2 (luna-tools): network + compute tools.
 * Gets API keys for web services but NO database path, NO bot tokens.
 */
export const TOOLS_PROCESS_ENV: string[] = [
  // Search backends (web_search tool)
  'SEARXNG_URL',
  'BRAVE_API_KEY',
  // API keys for network tools
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'RENDER_API_KEY',
  // Workspace paths (for read_file, run_command)
  'WORKSPACE_DIR',
  'UPLOADS_DIR',
  // Runtime config
  'NODE_ENV',
  'LOG_LEVEL',
  // Worker sandbox config
  'TOOL_TIMEOUT_MS',
  'TOOL_MAX_TIMEOUT_MS',
  // Chromium (for take_screenshot)
  'PUPPETEER_EXECUTABLE_PATH',
  'CHROME_PATH',
];

/**
 * Process 3 (luna-parsers): file parsing only.
 * Gets ONLY file paths — no API keys, no tokens, no network config.
 * Tightest sandbox: even if a parsing library is exploited,
 * the attacker has no credentials and no network access.
 */
export const PARSERS_PROCESS_ENV: string[] = [
  // File paths only
  'WORKSPACE_DIR',
  'UPLOADS_DIR',
  // Runtime config
  'NODE_ENV',
  'LOG_LEVEL',
];

/**
 * Build a restricted environment object for a child process.
 * Only includes whitelisted vars that are actually set.
 */
export function buildChildEnv(whitelist: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of whitelist) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  // Always include PATH for subprocess execution (git, gh, etc.)
  if (process.env.PATH) env.PATH = process.env.PATH;
  // Node.js needs HOME for various operations
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}
