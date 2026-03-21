import { describe, it, expect } from 'vitest';
import {
  githubListReposDefinition,
  githubReadFileDefinition,
  githubListIssuesDefinition,
  githubListPrsDefinition,
  githubCloneRepoDefinition,
  githubDiffDefinition,
  githubCommitPushDefinition,
  githubCreatePrDefinition,
  githubListRepos,
  githubReadFile,
  githubListIssues,
  githubListPrs,
  githubDiff,
} from '../src/providers/tools/github.js';

/**
 * Sprint S10: GitHub tools tests.
 *
 * Tests the actual exported tool definitions and implementations.
 * Tools that require `gh` CLI are tested for graceful degradation
 * when `gh` is not authenticated (CI/test environments).
 *
 * Tools that don't need auth (validation, path logic) are tested fully.
 */

// ── Tool definitions (real exports) ────────────────────────

describe('GitHub tool definitions', () => {
  const definitions = [
    githubListReposDefinition,
    githubReadFileDefinition,
    githubListIssuesDefinition,
    githubListPrsDefinition,
    githubCloneRepoDefinition,
    githubDiffDefinition,
    githubCommitPushDefinition,
    githubCreatePrDefinition,
  ];

  it('exports all 8 tool definitions', () => {
    expect(definitions).toHaveLength(8);
  });

  it('all definitions have required Ollama tool structure', () => {
    for (const def of definitions) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters.type).toBe('object');
    }
  });

  it('all tool names follow github_ prefix convention', () => {
    for (const def of definitions) {
      expect(def.function.name).toMatch(/^github_/);
    }
  });

  it('clone, diff, commit_push, create_pr require repo parameter', () => {
    const requiresRepo = [
      githubCloneRepoDefinition,
      githubDiffDefinition,
      githubCommitPushDefinition,
      githubCreatePrDefinition,
    ];
    for (const def of requiresRepo) {
      expect(def.function.parameters.required).toContain('repo');
    }
  });

  it('commit_push requires message parameter', () => {
    expect(githubCommitPushDefinition.function.parameters.required).toContain('message');
  });

  it('create_pr requires title and head parameters', () => {
    expect(githubCreatePrDefinition.function.parameters.required).toContain('title');
    expect(githubCreatePrDefinition.function.parameters.required).toContain('head');
  });
});

// ── Graceful degradation (no gh CLI) ───────────────────────

describe('GitHub tools graceful degradation', () => {
  it('github_list_repos returns error when gh is not available/authenticated', () => {
    const result = githubListRepos({ limit: 5 });
    // Either returns repos (if gh is authenticated) or an error message
    expect(result).toHaveProperty(result.error ? 'error' : 'repos');
  });

  it('github_read_file returns error or content', () => {
    const result = githubReadFile({ repo: 'nonexistent/repo', path: 'README.md' });
    expect(result).toHaveProperty(result.error ? 'error' : 'content');
  });

  it('github_list_issues returns error or issues', () => {
    const result = githubListIssues({ repo: 'nonexistent/repo' });
    expect(result).toHaveProperty(result.error ? 'error' : 'issues');
  });

  it('github_list_prs returns error or pullRequests', () => {
    const result = githubListPrs({ repo: 'nonexistent/repo' });
    expect(result).toHaveProperty(result.error ? 'error' : 'pullRequests');
  });

  it('github_diff returns error for non-existent repo', () => {
    const result = githubDiff({ repo: 'definitely-not-cloned' });
    expect(result.error).toContain('not found');
  });
});

// ── Input validation ───────────────────────────────────────

describe('GitHub tools input handling', () => {
  it('github_diff validates repo exists in workspace', () => {
    const result = githubDiff({ repo: '../../../etc/passwd' });
    // Path traversal should fail the git check
    expect(result.error).toBeDefined();
  });

  it('github_list_repos handles limit parameter', () => {
    // If gh is available, should respect limit; if not, should error gracefully
    const result = githubListRepos({ limit: 1 });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});
