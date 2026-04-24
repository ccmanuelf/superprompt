/**
 * Router prompt-build path (rc.92 + sanity sweep).
 *
 * Every user message that reaches a provider runs through a sequence of
 * pure prompt-assembly functions in `router.ts`:
 *
 *   [getCapabilitiesPrompt(), packCaps, webAppsPrompt, buildWebUIAwarenessPrompt()]
 *     .filter(Boolean).join('\n\n')
 *
 * A runtime error in any of these takes down every message. Before this
 * file, no test exercised them end-to-end — a broken `require()` inside
 * `getAllWebUIGuides()` shipped in rc.92 and blocked every chat until a
 * user hit it in production. This suite asserts each hot-path function
 * produces a non-empty string without throwing, and that rc.92 feature-
 * registry contributions survive the splice/merge.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  getCapabilitiesPrompt,
  getSelfDescription,
} from '../src/capabilities.js';
import {
  buildWebUIAwarenessPrompt,
  getWebUIOnboarding,
  getAllWebUIGuides,
} from '../src/web-ui-guide.js';

beforeAll(async () => {
  // Register the attendance feature before we test registry-driven splices.
  await import('../src/attendance/awareness.js');
});

describe('router prompt-build hot path', () => {
  it('getCapabilitiesPrompt() returns a non-empty string with no marker leftover', () => {
    const out = getCapabilitiesPrompt();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(200);
    expect(out).not.toContain('FEATURE_AWARENESS_SECTIONS_MARKER');
  });

  it('getSelfDescription() returns a non-empty string with no marker leftover', () => {
    const out = getSelfDescription();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(100);
    expect(out).not.toContain('FEATURE_AWARENESS_SELF_DESC_MARKER');
  });

  it('getAllWebUIGuides() resolves without throwing and includes every hardcoded entry', () => {
    const guides = getAllWebUIGuides();
    expect(Array.isArray(guides)).toBe(true);
    expect(guides.length).toBeGreaterThan(0);
    // Sanity anchors — core dashboards that shipped before rc.92.
    const urls = guides.map((g) => g.url);
    expect(urls).toContain('/sim');
    expect(urls).toContain('/board.html');
  });

  it('buildWebUIAwarenessPrompt() produces a non-empty string — the rc.92 regression site', () => {
    // This is the call that threw `ReferenceError: require is not defined`
    // when shipped against the ESM dist/ build. A plain "does not throw"
    // assertion would have been enough to catch it.
    const out = buildWebUIAwarenessPrompt();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(100);
    expect(out).toContain('Web Dashboard Awareness');
  });

  it('getWebUIOnboarding() resolves for a known URL', () => {
    const out = getWebUIOnboarding('/sim', 'en');
    expect(out).not.toBeNull();
    expect(typeof out).toBe('string');
  });

  it('attendance-registry contributions appear in both splice outputs', () => {
    const caps = getCapabilitiesPrompt();
    const self = getSelfDescription();
    expect(caps.toLowerCase()).toContain('attendance');
    expect(self.toLowerCase()).toContain('attendance');
  });

  it('attendance web-UI guide is merged via the feature-awareness registry', () => {
    const guides = getAllWebUIGuides();
    const attendance = guides.find((g) => g.url === '/attendance/admin');
    expect(attendance, 'attendance guide should come in through collectWebUIGuides()').toBeDefined();
  });
});
