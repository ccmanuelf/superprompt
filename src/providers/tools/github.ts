import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool } from 'ollama';
import { WORKSPACE_DIR } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * GitHub tools for Ollama — wraps `gh` CLI commands.
 *
 * These provide basic GitHub access for Ollama. Claude gets the richer
 * GitHub MCP server interface. Both providers can work with GitHub,
 * each using their native mechanism.
 *
 * Requires `gh` CLI installed and authenticated (GH_TOKEN env var).
 */

const GH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8_000;

/**
 * Sanitize a string for safe use in shell commands.
 * Wraps in single quotes with proper escaping (the only safe shell quoting method).
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Sanitize repo name to prevent path traversal.
 * Only allows alphanumeric, hyphens, underscores, and dots.
 */
function sanitizeRepoName(name: string): string {
  // Extract just the repo name (last segment of owner/repo)
  const repoName = name.split('/').pop() || name;
  // Strip anything that's not safe for a directory name
  return repoName.replace(/[^a-zA-Z0-9._-]/g, '');
}

function runGh(args: string): string {
  try {
    const output = execSync(`gh ${args}`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: '' }, // Disable pager
    }).trim();

    if (output.length > MAX_OUTPUT) {
      return output.slice(0, MAX_OUTPUT) + '\n...(truncated)';
    }
    return output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract just the stderr message, not the full stack
    const stderrMatch = msg.match(/stderr:\s*"?([^"]+)"?/);
    throw new Error(stderrMatch?.[1]?.trim() || msg.slice(0, 300));
  }
}

function isGhAvailable(): boolean {
  try {
    execSync('gh --version', { timeout: 5000, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

// ── Tool Definitions ────────────────────────────────────────

export const githubListReposDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_list_repos',
    description: 'List GitHub repositories for the authenticated user. Returns repo names, descriptions, and visibility.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max repos to return (default 20)',
        },
      },
    },
  },
};

export const githubReadFileDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_read_file',
    description: 'Read a file from a GitHub repository without cloning it. Use owner/repo format.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/repo format (e.g., "ccmanuelf/superprompt")',
        },
        path: {
          type: 'string',
          description: 'File path within the repo (e.g., "src/index.ts")',
        },
        ref: {
          type: 'string',
          description: 'Branch or commit ref (default: default branch)',
        },
      },
      required: ['repo', 'path'],
    },
  },
};

export const githubListIssuesDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_list_issues',
    description: 'List issues on a GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/repo format',
        },
        state: {
          type: 'string',
          description: 'Filter by state: open, closed, or all (default: open)',
        },
        limit: {
          type: 'number',
          description: 'Max issues to return (default 10)',
        },
      },
      required: ['repo'],
    },
  },
};

export const githubListPrsDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_list_prs',
    description: 'List pull requests on a GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/repo format',
        },
        state: {
          type: 'string',
          description: 'Filter by state: open, closed, merged, or all (default: open)',
        },
        limit: {
          type: 'number',
          description: 'Max PRs to return (default 10)',
        },
      },
      required: ['repo'],
    },
  },
};

export const githubCloneRepoDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_clone_repo',
    description: 'Clone a GitHub repository to the local workspace. Use this before making code changes.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/repo format',
        },
        branch: {
          type: 'string',
          description: 'Branch to clone (default: default branch)',
        },
      },
      required: ['repo'],
    },
  },
};

export const githubDiffDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_diff',
    description: 'Show the git diff of uncommitted changes in a cloned repository. Use before committing to preview changes.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name (the folder name in workspace)',
        },
      },
      required: ['repo'],
    },
  },
};

export const githubCommitPushDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_commit_push',
    description: 'Stage all changes, commit with a message, and push to the remote. Use github_diff first to preview changes.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name (the folder name in workspace)',
        },
        message: {
          type: 'string',
          description: 'Commit message',
        },
        branch: {
          type: 'string',
          description: 'Branch to push to (default: current branch)',
        },
      },
      required: ['repo', 'message'],
    },
  },
};

export const githubCreatePrDefinition: Tool = {
  type: 'function',
  function: {
    name: 'github_create_pr',
    description: 'Create a pull request on a GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository in owner/repo format',
        },
        title: {
          type: 'string',
          description: 'PR title',
        },
        body: {
          type: 'string',
          description: 'PR description',
        },
        head: {
          type: 'string',
          description: 'Branch with changes',
        },
        base: {
          type: 'string',
          description: 'Branch to merge into (default: main)',
        },
      },
      required: ['repo', 'title', 'head'],
    },
  },
};

// ── Tool Implementations ────────────────────────────────────

const REPOS_DIR = resolve(WORKSPACE_DIR, 'repos');

export function githubListRepos(args: { limit?: number }): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed or not authenticated. Set GH_TOKEN in .env.' };

  try {
    const limit = args.limit || 20;
    const output = runGh(`repo list --limit ${limit} --json name,description,visibility,updatedAt`);
    return { repos: JSON.parse(output) };
  } catch (err) {
    return { error: `Failed to list repos: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubReadFile(args: { repo: string; path: string; ref?: string }): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed.' };

  try {
    // Use raw content Accept header — returns file content directly without base64 encoding
    const refQuery = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
    const safePath = args.path.replace(/[^a-zA-Z0-9._\/-]/g, '');
    const output = runGh(
      `api repos/${args.repo}/contents/${safePath}${refQuery} -H "Accept: application/vnd.github.raw+json"`,
    );
    return { content: output, path: args.path };
  } catch (err) {
    return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubListIssues(args: { repo: string; state?: string; limit?: number }): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed.' };

  try {
    const state = args.state || 'open';
    const limit = args.limit || 10;
    const output = runGh(`issue list -R ${args.repo} --state ${state} --limit ${limit} --json number,title,state,author,createdAt,labels`);
    return { issues: JSON.parse(output) };
  } catch (err) {
    return { error: `Failed to list issues: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubListPrs(args: { repo: string; state?: string; limit?: number }): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed.' };

  try {
    const state = args.state || 'open';
    const limit = args.limit || 10;
    const output = runGh(`pr list -R ${args.repo} --state ${state} --limit ${limit} --json number,title,state,author,createdAt,headRefName`);
    return { pullRequests: JSON.parse(output) };
  } catch (err) {
    return { error: `Failed to list PRs: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubCloneRepo(args: { repo: string; branch?: string }): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed.' };

  // Validate repo format: must be owner/repo (prevents CLI flag injection)
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    return { error: `Invalid repository format: "${args.repo}". Expected: owner/repo (e.g., "octocat/hello-world")` };
  }

  try {
    // Ensure workspace dir exists
    execSync(`mkdir -p ${shellEscape(REPOS_DIR)}`, { encoding: 'utf-8' });

    const repoName = sanitizeRepoName(args.repo);
    const repoPath = resolve(REPOS_DIR, repoName);

    // Check if already cloned
    try {
      execSync(`test -d ${shellEscape(repoPath)}/.git`, { encoding: 'utf-8' });
      // Already exists — pull latest
      if (args.branch) {
        const safeBranch = args.branch.replace(/[^a-zA-Z0-9._\/-]/g, '');
        execSync(`cd ${shellEscape(repoPath)} && git checkout ${shellEscape(safeBranch)}`, {
          timeout: GH_TIMEOUT_MS,
          encoding: 'utf-8',
        });
      }
      execSync(`cd ${shellEscape(repoPath)} && git pull`, {
        timeout: GH_TIMEOUT_MS,
        encoding: 'utf-8',
      });
      return { path: repoPath, message: `Repository updated (already cloned). Path: ${repoPath}` };
    } catch {
      // Not cloned yet
    }

    const branchFlag = args.branch ? `--branch ${args.branch.replace(/[^a-zA-Z0-9._\/-]/g, '')}` : '';
    runGh(`repo clone ${args.repo} ${shellEscape(repoPath)} -- ${branchFlag}`);

    logger.info({ repo: args.repo, path: repoPath }, 'Repository cloned');
    return { path: repoPath, message: `Cloned ${args.repo} to ${repoPath}` };
  } catch (err) {
    return { error: `Failed to clone: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubDiff(args: { repo: string }): Record<string, unknown> {
  const safeRepo = sanitizeRepoName(args.repo);
  const repoPath = resolve(REPOS_DIR, safeRepo);

  try {
    execSync(`test -d ${shellEscape(repoPath)}/.git`, { encoding: 'utf-8' });
  } catch {
    return { error: `Repository "${safeRepo}" not found in workspace. Clone it first with github_clone_repo.` };
  }

  try {
    const diff = execSync(`cd ${shellEscape(repoPath)} && git diff`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    }).trim();

    if (!diff) {
      const staged = execSync(`cd ${shellEscape(repoPath)} && git diff --cached`, {
        timeout: GH_TIMEOUT_MS,
        encoding: 'utf-8',
      }).trim();

      if (!staged) return { message: 'No changes to show.' };
      return { diff: staged.slice(0, MAX_OUTPUT), type: 'staged' };
    }

    return { diff: diff.slice(0, MAX_OUTPUT), type: 'unstaged' };
  } catch (err) {
    return { error: `Failed to get diff: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubCommitPush(args: { repo: string; message: string; branch?: string }): Record<string, unknown> {
  const safeRepo = sanitizeRepoName(args.repo);
  const repoPath = resolve(REPOS_DIR, safeRepo);

  try {
    execSync(`test -d ${shellEscape(repoPath)}/.git`, { encoding: 'utf-8' });
  } catch {
    return { error: `Repository "${safeRepo}" not found in workspace.` };
  }

  try {
    // Configure git user if not set (required for commits inside container)
    try {
      execSync(`cd ${shellEscape(repoPath)} && git config user.name`, { encoding: 'utf-8' });
    } catch {
      execSync(`cd ${shellEscape(repoPath)} && git config user.name 'luna' && git config user.email 'luna@bot.local'`, { encoding: 'utf-8' });
    }

    // Check for changes first
    const status = execSync(`cd ${shellEscape(repoPath)} && git status --porcelain`, {
      encoding: 'utf-8',
    }).trim();

    if (!status) return { message: 'No changes to commit.' };

    // Stage changes
    execSync(`cd ${shellEscape(repoPath)} && git add -A`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
    });

    // Checkout branch if specified
    if (args.branch) {
      const safeBranch = args.branch.replace(/[^a-zA-Z0-9._\/-]/g, '');
      execSync(`cd ${shellEscape(repoPath)} && git checkout -B ${shellEscape(safeBranch)}`, {
        timeout: GH_TIMEOUT_MS,
        encoding: 'utf-8',
      });
    }

    // Commit with safe quoting (prevents command injection via message)
    execSync(`cd ${shellEscape(repoPath)} && git commit -m ${shellEscape(args.message)}`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
    });

    const pushBranch = args.branch ? args.branch.replace(/[^a-zA-Z0-9._\/-]/g, '') : 'HEAD';
    execSync(`cd ${shellEscape(repoPath)} && git push origin ${shellEscape(pushBranch)}`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
    });

    const hash = execSync(`cd ${shellEscape(repoPath)} && git rev-parse --short HEAD`, {
      encoding: 'utf-8',
    }).trim();

    logger.info({ repo: safeRepo, hash, message: args.message }, 'Committed and pushed');
    return { success: true, hash, message: `Committed and pushed: ${hash} — ${args.message}` };
  } catch (err) {
    return { error: `Failed to commit/push: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubCreatePr(args: {
  repo: string; title: string; body?: string; head: string; base?: string;
}): Record<string, unknown> {
  if (!isGhAvailable()) return { error: 'gh CLI is not installed.' };

  try {
    const base = args.base || 'main';
    const body = args.body || '';
    const safeHead = args.head.replace(/[^a-zA-Z0-9._\/-]/g, '');
    const safeBase = base.replace(/[^a-zA-Z0-9._\/-]/g, '');
    // Use shellEscape for user-provided text to prevent injection
    const output = runGh(
      `pr create -R ${args.repo} --title ${shellEscape(args.title)} --body ${shellEscape(body)} --head ${shellEscape(safeHead)} --base ${shellEscape(safeBase)}`,
    );
    return { url: output.trim(), message: `PR created: ${output.trim()}` };
  } catch (err) {
    return { error: `Failed to create PR: ${err instanceof Error ? err.message : String(err)}` };
  }
}
