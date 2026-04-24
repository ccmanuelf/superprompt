/**
 * Feature awareness registry (rc.92).
 *
 * Luna has four surfaces where a user-facing feature must be declared:
 *   1. `CAPABILITIES_PROMPT` — the system prompt Luna sees on every turn
 *   2. `WEB_UI_GUIDES` — the web-UI awareness map she uses to recommend URLs
 *   3. Telegram `/start` + `/help` (and Matrix `!help`) command listings
 *   4. User-facing docs (`docs/user-help-guide.md`, `docs/commands.md`)
 *
 * Before this registry existed, those four surfaces were maintained by
 * hand. A new feature could ship fully invisible to Luna and nothing in
 * the test suite would catch it — the only signal was "a user asks about
 * the feature and Luna makes up an answer". That's exactly the bug we
 * hit with Phase A: I had to remember to edit capabilities.ts manually.
 *
 * This module makes the awareness **declarative**. Each feature exports
 * a `FeatureAwareness` descriptor, registers it at startup, and every
 * awareness surface builds its content by iterating the registry.
 *
 * Enforcement comes from two things:
 *   - The test in `tests/feature-awareness-registry.test.ts` asserts
 *     that every feature the project considers "shipping" is registered
 *     with a non-empty systemPromptSection.
 *   - A feature is only reachable if its index module is imported
 *     somewhere (conventionally in `src/index.ts` at startup); that same
 *     import is the registration point, so you literally can't ship a
 *     working feature without teaching Luna about it.
 *
 * The descriptor is intentionally flat — no inheritance, no lifecycle
 * hooks beyond registration. The point is a simple contract anyone on
 * the team can satisfy on their first day.
 */

import type { WebUIGuide } from '../web-ui-guide.js';

/**
 * Lifecycle of a feature. Only `shipping` features contribute to Luna's
 * public awareness — the prompt and /help listings gate on this so a
 * half-built feature can live in the codebase without promising
 * functionality to users.
 */
export type FeatureStatus = 'shipping' | 'preview' | 'planned';

export interface FeatureAwareness {
  /**
   * Machine-readable identifier. One per feature directory. Used for
   * de-duplication and for the enforcement test. Lowercase, hyphenated.
   */
  key: string;

  /** Human-readable name (no brand-prefix; the prompt template adds context). */
  name: string;

  /**
   * Lifecycle status — only `shipping` contributes to user-facing output.
   * `preview` descriptors are still registered for internal traceability
   * (so the enforcement test sees them) but are filtered out of the
   * generated prompt.
   */
  status: FeatureStatus;

  /**
   * Fenced section appended to `CAPABILITIES_PROMPT`. Should open with a
   * level-2 markdown heading (e.g., `## Attendance Reconciliation`) so
   * the downstream system prompt's heading hierarchy stays readable.
   * Kept as plain text so it can be inlined without escaping gymnastics.
   */
  systemPromptSection: string;

  /**
   * Optional entries merged into `WEB_UI_GUIDES`. Use this when the
   * feature exposes one or more dashboards; skip it for command-only
   * features.
   */
  webUIGuides?: WebUIGuide[];

  /**
   * HTML-formatted block appended to the Telegram `/help` output.
   * Lead with a bold header emoji + name (e.g.
   * `<b>👥 Attendance</b>`) for visual parity with existing blocks.
   */
  telegramHelpBlock?: string;

  /**
   * Plain-text block appended to Matrix `!help`. Typically shorter than
   * the Telegram version because Matrix doesn't render HTML.
   */
  matrixHelpBlock?: string;

  /**
   * One-line bullet for `SELF_DESCRIPTION` ("what can you do?"). Keep
   * under ~150 chars so the self-description stays scannable.
   */
  selfDescriptionBullet?: string;
}

// ── Registry ──────────────────────────────────────────────────

const _registry = new Map<string, FeatureAwareness>();

/**
 * Register a feature's awareness descriptor. Idempotent: repeat
 * registration with the same `key` overwrites (useful during hot-reload
 * in dev; inert in prod where nothing re-registers).
 *
 * Call this from the feature's own awareness.ts at module load time:
 *
 *   // src/attendance/awareness.ts
 *   import { registerFeature } from '../core/feature-awareness.js';
 *   registerFeature({ key: 'attendance', ... });
 *
 * Then import the awareness.ts from your feature's barrel (index.ts, or
 * src/index.ts) so the side-effect fires during startup.
 */
export function registerFeature(feature: FeatureAwareness): void {
  if (!feature.key) throw new Error('registerFeature: key is required');
  if (!feature.name) throw new Error('registerFeature: name is required');
  if (!feature.systemPromptSection?.trim()) {
    throw new Error(`registerFeature(${feature.key}): systemPromptSection is required`);
  }
  _registry.set(feature.key, feature);
}

export function listFeatures(): FeatureAwareness[] {
  return [..._registry.values()];
}

export function listShippingFeatures(): FeatureAwareness[] {
  return listFeatures().filter((f) => f.status === 'shipping');
}

export function featureByKey(key: string): FeatureAwareness | undefined {
  return _registry.get(key);
}

/** For tests only — reset between runs. Never call from production code. */
export function _resetRegistry(): void {
  _registry.clear();
}

// ── Rendering helpers ─────────────────────────────────────────

/**
 * Build the "Feature capabilities" section appended to
 * `CAPABILITIES_PROMPT`. Iterates shipping features in registration
 * order — authors should import in the order they want the sections to
 * appear.
 */
export function renderCapabilitiesPromptSections(): string {
  const features = listShippingFeatures();
  if (features.length === 0) return '';
  return features
    .map((f) => f.systemPromptSection.trimEnd())
    .join('\n\n');
}

/** Build the Telegram /help attendance / features block. */
export function renderTelegramHelpSections(): string {
  const blocks = listShippingFeatures()
    .map((f) => f.telegramHelpBlock?.trim())
    .filter((b): b is string => Boolean(b));
  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

/** Build the Matrix !help sections. */
export function renderMatrixHelpSections(): string {
  const blocks = listShippingFeatures()
    .map((f) => f.matrixHelpBlock?.trim())
    .filter((b): b is string => Boolean(b));
  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

/** Build the SELF_DESCRIPTION bullets that come from registered features. */
export function renderSelfDescriptionBullets(): string {
  const bullets = listShippingFeatures()
    .map((f) => f.selfDescriptionBullet?.trim())
    .filter((b): b is string => Boolean(b));
  if (bullets.length === 0) return '';
  return bullets.join('\n');
}

/** Web-UI guide entries contributed by registered features. */
export function collectWebUIGuides(): WebUIGuide[] {
  const out: WebUIGuide[] = [];
  for (const f of listShippingFeatures()) {
    if (f.webUIGuides) out.push(...f.webUIGuides);
  }
  return out;
}
