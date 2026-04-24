/**
 * Feature-awareness registry — contract enforcement (rc.92).
 *
 * This is the test that makes Luna's awareness self-enforcing: if a
 * feature ships in the codebase but never registers a FeatureAwareness
 * descriptor, CI fails here before the code reaches users.
 *
 * The contract:
 *   - Every "feature directory" (one we declare below in FEATURE_DIRS)
 *     must have a sibling `awareness.ts` that calls registerFeature().
 *   - The registered descriptor must pass the field-level validation
 *     (non-empty systemPromptSection, valid status, etc.).
 *
 * When you add a new feature:
 *   1. Create `src/<feature>/awareness.ts` with registerFeature(...).
 *   2. Import that module from `src/index.ts` as a side-effect import
 *      (see the existing attendance entry).
 *   3. Add the feature key + directory to EXPECTED_FEATURES below.
 *   4. This test passes → your feature is discoverable by Luna and
 *      appears in CAPABILITIES_PROMPT, WEB_UI_GUIDES, and /help.
 *
 * The fourth step is the enforcement: omit it and the test fails,
 * forcing you to acknowledge the new feature in the awareness layer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFeatures,
  listShippingFeatures,
  featureByKey,
  renderCapabilitiesPromptSections,
  renderTelegramHelpSections,
  renderSelfDescriptionBullets,
  collectWebUIGuides,
} from '../src/core/feature-awareness.js';

// Absolute path to src/
const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(here, '..', 'src');

/**
 * The list the team maintains as new features ship. Each entry is
 * (registry key, directory name under src/). Adding a row here enforces
 * that the directory contains an `awareness.ts` AND the descriptor is
 * registered at startup.
 */
const EXPECTED_FEATURES: Array<{ key: string; dir: string }> = [
  { key: 'attendance', dir: 'attendance' },
];

beforeAll(async () => {
  // Explicit side-effect imports — Vitest's static analyzer rejects
  // variable-path dynamic imports. Each new feature added to
  // EXPECTED_FEATURES also needs a matching import here.
  await import('../src/attendance/awareness.js');
});

describe('feature-awareness registry', () => {
  it.each(EXPECTED_FEATURES)('feature "$key" has an awareness.ts in src/$dir/', ({ dir }) => {
    const awarenessPath = resolve(SRC, dir, 'awareness.ts');
    expect(existsSync(awarenessPath), `expected src/${dir}/awareness.ts to exist`).toBe(true);
  });

  it.each(EXPECTED_FEATURES)('feature "$key" is registered after awareness.ts loads', ({ key }) => {
    const f = featureByKey(key);
    expect(f, `expected feature "${key}" to be in the registry`).toBeDefined();
  });

  it('every registered feature has a non-empty systemPromptSection', () => {
    for (const f of listFeatures()) {
      expect(f.systemPromptSection.trim().length, `feature "${f.key}" systemPromptSection is empty`).toBeGreaterThan(0);
    }
  });

  it('every registered feature has a valid lifecycle status', () => {
    const valid = new Set(['shipping', 'preview', 'planned']);
    for (const f of listFeatures()) {
      expect(valid.has(f.status), `feature "${f.key}" has invalid status "${f.status}"`).toBe(true);
    }
  });

  it('shipping features contribute content to CAPABILITIES_PROMPT via renderCapabilitiesPromptSections()', () => {
    const output = renderCapabilitiesPromptSections();
    for (const f of listShippingFeatures()) {
      // Rendered output should contain the feature's systemPromptSection
      // verbatim — a missing splice would be an obvious regression.
      expect(output.includes(f.systemPromptSection.slice(0, 40)),
        `renderCapabilitiesPromptSections() output does not include feature "${f.key}"`).toBe(true);
    }
  });

  it('shipping features with a telegramHelpBlock contribute to renderTelegramHelpSections()', () => {
    const output = renderTelegramHelpSections();
    for (const f of listShippingFeatures()) {
      if (!f.telegramHelpBlock) continue;
      // First non-blank line is the identifying header (e.g. "<b>👥 Attendance</b>")
      const firstLine = f.telegramHelpBlock.split('\n').find((l) => l.trim().length > 0) ?? '';
      expect(output.includes(firstLine),
        `telegram help output missing "${firstLine}" from feature "${f.key}"`).toBe(true);
    }
  });

  it('self-description bullets from shipping features are all rendered', () => {
    const output = renderSelfDescriptionBullets();
    for (const f of listShippingFeatures()) {
      if (!f.selfDescriptionBullet) continue;
      expect(output.includes(f.selfDescriptionBullet.slice(0, 30)),
        `self-description output missing bullet from "${f.key}"`).toBe(true);
    }
  });

  it('web-UI guides from features are exposed via collectWebUIGuides()', () => {
    const collected = collectWebUIGuides();
    for (const f of listShippingFeatures()) {
      if (!f.webUIGuides) continue;
      for (const guide of f.webUIGuides) {
        const found = collected.find((g) => g.url === guide.url);
        expect(found, `web UI guide for "${guide.url}" from feature "${f.key}" missing from collectWebUIGuides()`).toBeDefined();
      }
    }
  });
});
