#!/usr/bin/env node
/**
 * Real-browser verification harness — runs inside the luna-bot container
 * (where chromium + puppeteer-core are already installed). Loads each
 * shipped web UI page, listens for page errors / console errors / failed
 * network requests, and reports per-page findings.
 *
 * Usage:
 *   docker cp scripts/browser-smoke.mjs luna-bot:/tmp/browser-smoke.mjs
 *   docker exec luna-bot node /tmp/browser-smoke.mjs
 *
 * Exit code 0 = every page clean. Non-zero = at least one page had errors.
 */

import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:3030';
const PAGES = [
  '/',
  '/board.html',
  '/learn.html',
  '/docs',
  '/docs/assumptions',
  '/explain',
  '/attendance/admin',
  '/sim',
  '/capacity',
  '/sequence',
  '/vsm',
  '/toc',
  '/conwip',
  '/doe',
  '/fsm',
  '/hub',
  '/hub/bom',
];

// Some warnings are routine (CSP nonces under reload, font preloads on cold
// cache, third-party tracker beacons). We narrow to "real" failures only.
const IGNORE_NETWORK_PATTERNS = [
  /favicon\.ico$/,
  /service-worker/,
];

function shouldIgnoreNet(url) {
  return IGNORE_NETWORK_PATTERNS.some((re) => re.test(url));
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let totalIssues = 0;
const results = [];

for (const path of PAGES) {
  const page = await browser.newPage();
  const issues = [];

  page.on('pageerror', (err) => {
    issues.push({ kind: 'pageerror', detail: err.message });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 401s are expected: pages call token-gated APIs from JS, anonymous
    // probe gets 401, page UI handles it (login prompt, etc.). The browser
    // logs the failed XHR to console; that's not a regression.
    if (/Failed to load resource.*status of 401/i.test(text)) return;
    issues.push({ kind: 'console-error', detail: text });
  });
  page.on('requestfailed', (req) => {
    if (shouldIgnoreNet(req.url())) return;
    issues.push({
      kind: 'requestfailed',
      detail: `${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`,
    });
  });
  page.on('response', (res) => {
    const url = res.url();
    if (shouldIgnoreNet(url)) return;
    const code = res.status();
    if (code >= 400 && code !== 401) {
      // 401 is expected on token-gated APIs called by anonymous page loads;
      // any other 4xx/5xx is a real bug.
      issues.push({ kind: `http-${code}`, detail: url });
    }
  });

  let httpStatus = null;
  try {
    const resp = await page.goto(`${BASE}${path}`, {
      waitUntil: 'networkidle2',
      timeout: 15_000,
    });
    httpStatus = resp?.status() ?? null;
    // Give SPAs a moment to bootstrap and surface late errors.
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    issues.push({ kind: 'navigation', detail: err.message });
  }

  // Sanity: did we actually render *something*?
  let bodyTextLen = 0;
  try {
    bodyTextLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
  } catch { /* body may not exist if navigation failed */ }

  await page.close();
  totalIssues += issues.length;
  results.push({ path, httpStatus, bodyTextLen, issues });
}

await browser.close();

const headerCols = ['PATH', 'HTTP', 'BODY', 'ISSUES'];
const widths = [28, 5, 6, 8];
const fmt = (cols) =>
  cols.map((c, i) => String(c).padEnd(widths[i])).join(' ');

console.log(fmt(headerCols));
console.log(fmt(widths.map((w) => '-'.repeat(w))));
for (const r of results) {
  console.log(fmt([r.path, r.httpStatus ?? '?', r.bodyTextLen, r.issues.length]));
  for (const i of r.issues) {
    const detail = i.detail.length > 200 ? `${i.detail.slice(0, 200)}…` : i.detail;
    console.log(`     ${i.kind}: ${detail}`);
  }
}

console.log('');
if (totalIssues === 0) {
  console.log(`PASS — ${PAGES.length} pages, 0 client-side issues`);
  process.exit(0);
} else {
  console.log(`FAIL — ${PAGES.length} pages, ${totalIssues} client-side issues across ${results.filter((r) => r.issues.length > 0).length} page(s)`);
  process.exit(1);
}
