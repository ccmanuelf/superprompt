#!/usr/bin/env node
/**
 * dist/ smoke test — catches ESM-vs-runtime mismatches that type-check
 * and vitest let through.
 *
 * History: rc.92 shipped a `require('./core/feature-awareness.js')`
 * inside an ESM module. TypeScript was happy (require is in @types/node),
 * vitest was happy (its loader is permissive), unit tests never called
 * the function. The failure only manifested when Node ran the built
 * `dist/*.js` in `"type": "module"` mode inside the container — every
 * user message crashed with `ReferenceError: require is not defined`.
 *
 * This script imports modules directly from `dist/` and invokes every
 * hot-path function that assembles prompt text. Run it after `tsc` to
 * confirm the built output is executable in real ESM before deploying.
 *
 * Usage:
 *   npm run build && node scripts/dist-smoke.mjs
 * Exit code 0 = healthy. Any thrown error = broken dist.
 */

import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

if (!existsSync(distDir)) {
  console.error(`dist/ not found at ${distDir} — run \`npm run build\` first.`);
  process.exit(2);
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('import dist/attendance/awareness.js (registers feature)', async () => {
  await import(resolve(distDir, 'attendance/awareness.js'));
});

check('import dist/attendance/caption.js and parse a sample', async () => {
  const m = await import(resolve(distDir, 'attendance/caption.js'));
  const parsed = m.parseAttendanceCaption('Roster Data mod-1');
  if (!parsed || parsed.kind !== 'roster') throw new Error('parse failed');
});

check('getCapabilitiesPrompt() returns non-empty string', async () => {
  const m = await import(resolve(distDir, 'capabilities.js'));
  const out = m.getCapabilitiesPrompt();
  if (typeof out !== 'string' || out.length < 200) throw new Error(`bad output: ${typeof out}, len ${out?.length}`);
  if (out.includes('FEATURE_AWARENESS_SECTIONS_MARKER')) throw new Error('marker leaked');
});

check('getSelfDescription() returns non-empty string', async () => {
  const m = await import(resolve(distDir, 'capabilities.js'));
  const out = m.getSelfDescription();
  if (typeof out !== 'string' || out.length < 100) throw new Error(`bad output: ${typeof out}, len ${out?.length}`);
  if (out.includes('FEATURE_AWARENESS_SELF_DESC_MARKER')) throw new Error('marker leaked');
});

check('buildWebUIAwarenessPrompt() returns non-empty string (rc.92 regression site)', async () => {
  // This is the exact call that threw `ReferenceError: require is not
  // defined` in the container. If this check passes, the ESM build is
  // clean enough to serve a user message.
  const m = await import(resolve(distDir, 'web-ui-guide.js'));
  const out = m.buildWebUIAwarenessPrompt();
  if (typeof out !== 'string' || out.length < 100) throw new Error(`bad output: ${typeof out}, len ${out?.length}`);
  if (!out.includes('Web Dashboard Awareness')) throw new Error('missing header');
});

check('getAllWebUIGuides() merges registry + hardcoded', async () => {
  const m = await import(resolve(distDir, 'web-ui-guide.js'));
  const guides = m.getAllWebUIGuides();
  if (!Array.isArray(guides) || guides.length === 0) throw new Error('empty guides');
  const urls = guides.map((g) => g.url);
  if (!urls.includes('/sim')) throw new Error('/sim missing');
  if (!urls.includes('/attendance/admin')) throw new Error('/attendance/admin missing (feature registry not wired)');
});

check('renderCapabilitiesPromptSections() produces attendance content', async () => {
  const m = await import(resolve(distDir, 'core/feature-awareness.js'));
  const out = m.renderCapabilitiesPromptSections();
  if (!out.toLowerCase().includes('attendance')) throw new Error('attendance section missing');
});

check('doc-awareness manifest reaches the system prompt (rc.109)', async () => {
  const m = await import(resolve(distDir, 'capabilities.js'));
  const out = m.getCapabilitiesPrompt();
  if (!out.includes('Available Documentation (read-access)')) {
    throw new Error('manifest section missing from system prompt');
  }
  if (!out.includes('docs/user-guide')) {
    throw new Error('manifest does not list user-guide');
  }
  if (!out.includes('read_documentation') || !out.includes('search_documentation')) {
    throw new Error('manifest does not advertise the read/search tools');
  }
});

check('doc-aware tools execute end-to-end via dist (rc.109)', async () => {
  const m = await import(resolve(distDir, 'doc-awareness.js'));
  const docs = m.listAvailableDocs();
  if (!Array.isArray(docs) || docs.length === 0) throw new Error('no docs in manifest');

  const read = m.readDocumentation({ filename: 'docs/user-guide' });
  if (!read.content || read.content.length === 0) throw new Error('read_documentation returned empty');

  const search = m.searchDocumentation({ query: 'site-adjusted' });
  if (typeof search.matchCount !== 'number') throw new Error('search_documentation shape wrong');

  // Path-traversal guard
  const bad = m.readDocumentation({ filename: '../package' });
  if (!bad.error) throw new Error('path-traversal guard failed');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`       ${err?.stack || err}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} smoke checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} dist smoke checks passed.`);
