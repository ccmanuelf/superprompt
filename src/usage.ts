/**
 * Provider usage observability (rc.95).
 *
 * Honest count of how many user turns each AI provider handled, broken
 * down by month. The Claude subscription is a flat monthly fee with no
 * per-call cost — there are no dollar savings to compute, and the
 * `/usage` command reports counts and the local-handled percentage so
 * IT and management can verify Luna is local-first by default. The
 * subscription rate-limit headroom is the real budget being managed.
 *
 * Counts are incremented at the user-turn level (once per
 * `Router.sendMessage()` call), not per internal retry. Internal
 * retries (deliverable retry, stale-session retry) reuse the same
 * provider on the same user turn — counting them would inflate the
 * numbers without changing what IT cares about ("which provider
 * handled the conversation?").
 *
 * The table is dialect-agnostic so SQLite (dev/pilot), MariaDB, and
 * PostgreSQL all work. Increment uses Knex's `onConflict().merge()`
 * which compiles to native UPSERT on each dialect.
 */
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

export type ProviderName = 'claude' | 'ollama';

async function initApiUsageTable(): Promise<void> {
  const db = getKnex();
  if (await db.schema.hasTable('api_usage')) return;

  await db.schema.createTable('api_usage', (t) => {
    t.bigIncrements('id').primary();
    t.string('provider').notNullable();        // 'claude' | 'ollama'
    t.string('month').notNullable();           // YYYYMM, site-local is fine
    t.integer('call_count').notNullable().defaultTo(0);
    t.unique(['provider', 'month']);
    t.index(['month']);
  });
}

export const apiUsageTableInit: TableInitializer = {
  name: 'api_usage',
  initTables: initApiUsageTable,
};

// ── Time helpers (kept private — exported only for tests) ─────────────

/**
 * Format a Date as `YYYYMM`. Default is `now`. Site-local clock — we
 * don't try to align months across timezones; an IT team reading
 * `/usage` cares about "this month" by their wall clock, not UTC.
 */
export function monthKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

// ── Core API ──────────────────────────────────────────────────────────

/**
 * Increment the per-provider call counter for the current month.
 * Fire-and-forget at every call site — failures must not break a real
 * user turn. The single-row UPSERT is cheap (indexed unique key) and
 * safe to run on every routed message.
 */
export async function recordProviderCall(
  provider: ProviderName,
  when: Date = new Date(),
): Promise<void> {
  try {
    const db = getKnex();
    await db('api_usage')
      .insert({ provider, month: monthKey(when), call_count: 1 })
      .onConflict(['provider', 'month'])
      .merge({ call_count: db.raw('call_count + 1') });
  } catch (err) {
    // Never throw — usage tracking is observability, not a critical path.
    logger.debug({ err, provider }, 'api_usage increment failed (non-fatal)');
  }
}

export interface MonthlyUsage {
  month: string;          // YYYYMM
  claude: number;
  ollama: number;
  total: number;
  /** 0..100, two-decimal precision. 0 when total === 0 (no division by zero). */
  localPercent: number;
}

/**
 * Read the current totals for a given month. Returns zeros for any
 * provider that has no row yet — callers should never have to handle
 * "row missing" semantics. Defaults to the current month.
 */
export async function getMonthlyUsage(
  month: string = monthKey(),
): Promise<MonthlyUsage> {
  const db = getKnex();
  const rows = (await db('api_usage')
    .where({ month })
    .select('provider', 'call_count')) as Array<{ provider: string; call_count: number }>;

  let claude = 0;
  let ollama = 0;
  for (const r of rows) {
    if (r.provider === 'claude') claude = r.call_count;
    else if (r.provider === 'ollama') ollama = r.call_count;
  }
  const total = claude + ollama;
  const localPercent = total === 0 ? 0 : Math.round((ollama / total) * 10000) / 100;
  return { month, claude, ollama, total, localPercent };
}

// ── Presentation helpers ──────────────────────────────────────────────

/**
 * "April 2026" from "202604". Used in the /usage reply header. Falls
 * back to the raw key if parsing fails (won't crash on bad input).
 */
export function formatMonthLabel(yyyymm: string, locale: string = 'en-US'): string {
  if (!/^\d{6}$/.test(yyyymm)) return yyyymm;
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  if (m < 1 || m > 12) return yyyymm;
  // Day-1 of the month at noon UTC: avoids any DST/locale rollover surprises.
  const d = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * Render the /usage reply as plain-text. Telegram wraps this in HTML,
 * Matrix sends it as `m.notice`. Numbers use thousands separators so
 * the IT team reads them as cleanly as a billing dashboard. We never
 * report a "savings" figure — see the module header for why.
 */
export function formatUsageReport(usage: MonthlyUsage): string {
  const label = formatMonthLabel(usage.month);
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (usage.total === 0) {
    return [
      `Provider Usage — ${label}`,
      '',
      'No routed calls yet this month.',
      '',
      'Claude subscription is flat-rate; counts are shown for transparency.',
    ].join('\n');
  }
  return [
    `Provider Usage — ${label}`,
    '',
    `Ollama (local):  ${fmt(usage.ollama).padStart(6)} calls (${usage.localPercent.toFixed(1)}%)`,
    `Claude:          ${fmt(usage.claude).padStart(6)} calls (${(100 - usage.localPercent).toFixed(1)}%)`,
    `Total:           ${fmt(usage.total).padStart(6)} calls`,
    '',
    'Claude subscription is flat-rate; counts are shown for transparency only.',
  ].join('\n');
}
