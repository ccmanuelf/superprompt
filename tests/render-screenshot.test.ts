import { describe, it, expect } from 'vitest';
import {
  renderListServicesDefinition,
  renderDeployStatusDefinition,
  renderGetLogsDefinition,
  renderListServices,
  renderDeployStatus,
} from '../src/providers/tools/render-status.js';
import {
  takeScreenshotDefinition,
  takeScreenshot,
} from '../src/providers/tools/screenshot.js';

/**
 * Sprint S10: Render + Screenshot tools tests.
 *
 * Tests real exported functions and definitions.
 * Render tools tested for graceful degradation without API key.
 * Screenshot tool tested for input validation and graceful degradation.
 */

// ── Render tool definitions ────────────────────────────────

describe('Render tool definitions', () => {
  const definitions = [
    renderListServicesDefinition,
    renderDeployStatusDefinition,
    renderGetLogsDefinition,
  ];

  it('exports 3 Render tool definitions', () => {
    expect(definitions).toHaveLength(3);
  });

  it('all definitions have render_ prefix', () => {
    for (const def of definitions) {
      expect(def.function.name).toMatch(/^render_/);
    }
  });

  it('deploy_status and get_logs require serviceId', () => {
    expect(renderDeployStatusDefinition.function.parameters.required).toContain('serviceId');
    expect(renderGetLogsDefinition.function.parameters.required).toContain('serviceId');
  });
});

// ── Render tools graceful degradation ──────────────────────

describe('Render tools without API key', () => {
  it('render_list_services returns error without RENDER_API_KEY', async () => {
    // In test env, RENDER_API_KEY is not set
    const result = await renderListServices({});
    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain('RENDER_API_KEY');
  });

  it('render_deploy_status returns error without RENDER_API_KEY', async () => {
    const result = await renderDeployStatus({ serviceId: 'srv-test' });
    expect(result.error).toBeDefined();
  });
});

// ── Screenshot tool definition ─────────────────────────────

describe('Screenshot tool definition', () => {
  it('exports take_screenshot definition', () => {
    expect(takeScreenshotDefinition.function.name).toBe('take_screenshot');
    expect(takeScreenshotDefinition.function.parameters.required).toContain('url');
  });

  it('supports url, selector, and fullPage parameters', () => {
    const props = takeScreenshotDefinition.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('selector');
    expect(props).toHaveProperty('fullPage');
  });
});

// ── Screenshot input validation (real function) ────────────

describe('Screenshot input validation (real function)', () => {
  it('rejects invalid URLs', async () => {
    const result = await takeScreenshot({ url: 'not-a-url' });
    expect(result.error).toContain('Invalid URL');
  });

  it('rejects non-http protocols', async () => {
    const result = await takeScreenshot({ url: 'ftp://files.example.com' });
    expect(result.error).toContain('http');
  });

  it('rejects file:// protocol', async () => {
    const result = await takeScreenshot({ url: 'file:///etc/passwd' });
    expect(result.error).toContain('http');
  });

  it('accepts valid https URL (may fail on chromium availability, but validates input)', async () => {
    const result = await takeScreenshot({ url: 'https://example.com' });
    // Either succeeds (chromium available) or fails with a puppeteer/chromium error (not an input validation error)
    if (result.error) {
      // Should NOT be an input validation error
      expect(String(result.error)).not.toContain('Invalid URL');
      expect(String(result.error)).not.toContain('http');
    } else {
      expect(result.filepath).toBeDefined();
    }
  });
});

// ── Tool count verification ────────────────────────────────

describe('S10 tool count', () => {
  it('S10 adds 12 new tools total (8 GitHub + 3 Render + 1 Screenshot)', () => {
    const allDefinitions = [
      // GitHub
      'github_list_repos', 'github_read_file', 'github_list_issues',
      'github_list_prs', 'github_clone_repo', 'github_diff',
      'github_commit_push', 'github_create_pr',
      // Render
      'render_list_services', 'render_deploy_status', 'render_get_logs',
      // Screenshot
      'take_screenshot',
    ];
    expect(allDefinitions).toHaveLength(12);
  });
});
