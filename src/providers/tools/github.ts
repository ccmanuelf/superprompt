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
    const refFlag = args.ref ? `--ref ${args.ref}` : '';
    const output = runGh(`api repos/${args.repo}/contents/${args.path} ${refFlag} --jq '.content' | base64 -d 2>/dev/null || gh api repos/${args.repo}/contents/${args.path} ${refFlag} --jq '.content'`);
    // gh api returns base64 content, try to decode
    try {
      const decoded = Buffer.from(output.trim(), 'base64').toString('utf-8');
      if (decoded && !decoded.includes('\ufffd')) return { content: decoded, path: args.path };
    } catch { /* not base64, return raw */ }
    return { content: output, path: args.path };
  } catch (err) {
    // Fallback: use raw content endpoint
    try {
      const refFlag = args.ref ? `?ref=${args.ref}` : '';
      const output = runGh(`api repos/${args.repo}/contents/${args.path}${refFlag} -H "Accept: application/vnd.github.raw+json"`);
      return { content: output, path: args.path };
    } catch (err2) {
      return { error: `Failed to read file: ${err2 instanceof Error ? err2.message : String(err2)}` };
    }
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

  try {
    // Ensure workspace dir exists
    execSync(`mkdir -p ${REPOS_DIR}`, { encoding: 'utf-8' });

    const repoName = args.repo.split('/').pop() || args.repo;
    const repoPath = `${REPOS_DIR}/${repoName}`;

    // Check if already cloned
    try {
      execSync(`test -d ${repoPath}/.git`, { encoding: 'utf-8' });
      // Already exists — pull latest
      const branchFlag = args.branch ? `&& git checkout ${args.branch}` : '';
      execSync(`cd ${repoPath} && git pull ${branchFlag}`, {
        timeout: GH_TIMEOUT_MS,
        encoding: 'utf-8',
      });
      return { path: repoPath, message: `Repository updated (already cloned). Path: ${repoPath}` };
    } catch {
      // Not cloned yet
    }

    const branchFlag = args.branch ? `--branch ${args.branch}` : '';
    runGh(`repo clone ${args.repo} ${repoPath} -- ${branchFlag}`);

    logger.info({ repo: args.repo, path: repoPath }, 'Repository cloned');
    return { path: repoPath, message: `Cloned ${args.repo} to ${repoPath}` };
  } catch (err) {
    return { error: `Failed to clone: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function githubDiff(args: { repo: string }): Record<string, unknown> {
  const repoPath = `${REPOS_DIR}/${args.repo}`;

  try {
    execSync(`test -d ${repoPath}/.git`, { encoding: 'utf-8' });
  } catch {
    return { error: `Repository "${args.repo}" not found in workspace. Clone it first with github_clone_repo.` };
  }

  try {
    const diff = execSync(`cd ${repoPath} && git diff`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    }).trim();

    if (!diff) {
      // Check for staged changes
      const staged = execSync(`cd ${repoPath} && git diff --cached`, {
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
  const repoPath = `${REPOS_DIR}/${args.repo}`;

  try {
    execSync(`test -d ${repoPath}/.git`, { encoding: 'utf-8' });
  } catch {
    return { error: `Repository "${args.repo}" not found in workspace.` };
  }

  try {
    // Check for changes first
    const status = execSync(`cd ${repoPath} && git status --porcelain`, {
      encoding: 'utf-8',
    }).trim();

    if (!status) return { message: 'No changes to commit.' };

    // Stage, commit, push
    const branchCmd = args.branch ? `git checkout -B ${args.branch} && ` : '';
    execSync(
      `cd ${repoPath} && ${branchCmd}git add -A && git commit -m "${args.message.replace(/"/g, '\\"')}"`,
      { timeout: GH_TIMEOUT_MS, encoding: 'utf-8' },
    );

    const pushBranch = args.branch || 'HEAD';
    execSync(`cd ${repoPath} && git push origin ${pushBranch}`, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
    });

    const hash = execSync(`cd ${repoPath} && git rev-parse --short HEAD`, {
      encoding: 'utf-8',
    }).trim();

    logger.info({ repo: args.repo, hash, message: args.message }, 'Committed and pushed');
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
    const output = runGh(
      `pr create -R ${args.repo} --title "${args.title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --head ${args.head} --base ${base}`,
    );
    return { url: output.trim(), message: `PR created: ${output.trim()}` };
  } catch (err) {
    return { error: `Failed to create PR: ${err instanceof Error ? err.message : String(err)}` };
  }
}
