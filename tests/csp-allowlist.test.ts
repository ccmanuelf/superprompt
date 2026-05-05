/**
 * CSP allowlist drift guard (rc.110).
 *
 * Pages that load Vue / Vuetify / AG Grid from cdn.jsdelivr.net need the
 * relaxed CSP header. /explain and /hub shipped broken from rc.100 because
 * they were missed in the inline-conditional form of the path matcher and
 * no one opened them in a real browser until the rc.109 audit.
 *
 * This test scans every HTML file under src/web/public/ for cdn.jsdelivr.net
 * references, derives the URL path each one is served at, and asserts that
 * pageNeedsRelaxedCsp() returns true for it. If a new dashboard or doc UI
 * adds CDN scripts but is not added to RELAXED_CSP_URL_PREFIXES, this test
 * fails before the page can ship broken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageNeedsRelaxedCsp } from '../src/web/server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'src', 'web', 'public');

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkHtml(full));
    else if (stat.isFile() && name.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * Best-effort URL derivation for a public HTML file. Mirrors the routing
 * logic in src/web/server.ts: most pages live at `/<dirname>` and serve
 * `<dirname>/index.html`. Some have explicit non-default URLs.
 */
function urlPathFor(absHtml: string): string {
  const rel = relative(PUBLIC_DIR, absHtml).split('/');
  // index.html at the root of public/ is `/`.
  if (rel.length === 1 && rel[0] === 'index.html') return '/';
  // .../index.html → /<dirname>
  if (rel[rel.length - 1] === 'index.html') {
    return '/' + rel.slice(0, -1).join('/');
  }
  // foo.html (root) → /foo.html
  if (rel.length === 1) return '/' + rel[0];
  // .../bar.html → /<dirs>/<bar>
  return '/' + rel.join('/');
}

const cdnPages = walkHtml(PUBLIC_DIR)
  .filter((f) => readFileSync(f, 'utf-8').includes('cdn.jsdelivr.net'))
  .map((f) => ({ file: f, urlPath: urlPathFor(f) }));

describe('CSP allowlist covers every CDN-using HTML page', () => {
  it('finds at least one CDN-using page (sanity)', () => {
    expect(cdnPages.length).toBeGreaterThan(0);
  });

  it.each(cdnPages)('$urlPath gets relaxed CSP', ({ file, urlPath }) => {
    // Filepath argument here is the on-disk static-file path, mirroring
    // how server.ts calls the matcher when a request resolves to a file.
    const ok = pageNeedsRelaxedCsp(urlPath, file);
    expect(ok, `Page ${file} (URL ${urlPath}) loads cdn.jsdelivr.net but pageNeedsRelaxedCsp() returned false. Add the URL prefix or filepath needle to RELAXED_CSP_URL_PREFIXES / RELAXED_CSP_FILEPATH_NEEDLES.`).toBe(true);
  });

  it('non-CDN pages do NOT get relaxed CSP', () => {
    // The Voice Chat page (/) loads only local assets — must keep strict CSP.
    expect(pageNeedsRelaxedCsp('/', resolve(PUBLIC_DIR, 'index.html'))).toBe(false);
    // /board.html and /learn.html are local-only too.
    expect(pageNeedsRelaxedCsp('/board.html', resolve(PUBLIC_DIR, 'board.html'))).toBe(false);
    expect(pageNeedsRelaxedCsp('/learn.html', resolve(PUBLIC_DIR, 'learn.html'))).toBe(false);
  });
});
