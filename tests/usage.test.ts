/**
 * Provider usage observability (rc.95).
 *
 * Verifies the api_usage table init, the UPSERT increment path under
 * SQLite, monthly aggregation, and the rendering helpers used by the
 * /usage command. Each test creates a fresh in-tmpdir SQLite file so
 * runs don't bleed into each other.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-usage-'));
  const dbPath = join(storeDir, 'test.db');

  const dbKnex = await import('../src/db-knex.js');
  db = dbKnex.initKnex({ driver: 'sqlite', sqliteFilename: dbPath });

  const { apiUsageTableInit } = await import('../src/usage.js');
  await apiUsageTableInit.initTables();
});

afterAll(async () => {
  const dbKnex = await import('../src/db-knex.js');
  await dbKnex.destroyKnex();
  rmSync(storeDir, { recursive: true, force: true });
});

describe('api_usage schema', () => {
  it('creates the api_usage table with the unique (provider, month) key', async () => {
    expect(await db.schema.hasTable('api_usage')).toBe(true);
    // Two inserts with same (provider, month) should violate the unique
    // index — we don't rely on this in production (we use UPSERT) but the
    // index existing is what makes the UPSERT path correct.
    await db('api_usage').insert({ provider: 'ollama', month: '999901', call_count: 1 });
    await expect(
      db('api_usage').insert({ provider: 'ollama', month: '999901', call_count: 1 }),
    ).rejects.toThrow();
    await db('api_usage').where({ month: '999901' }).delete();
  });

  it('initTables is idempotent', async () => {
    const { apiUsageTableInit } = await import('../src/usage.js');
    await expect(apiUsageTableInit.initTables()).resolves.not.toThrow();
  });
});

describe('recordProviderCall', () => {
  // Local-time noon constructors keep the test deterministic regardless
  // of the runner's timezone. monthKey() resolves on local-clock month,
  // so a UTC-midnight constructor would land in the prior month for any
  // negative-offset zone (the runner in CI/the user's machine).
  const LOCAL_NOON = (y: number, m1to12: number, d: number) => new Date(y, m1to12 - 1, d, 12, 0, 0);

  it('inserts a new row with call_count=1 when none exists', async () => {
    const { recordProviderCall, monthKey } = await import('../src/usage.js');
    const when = LOCAL_NOON(2026, 1, 15);
    await recordProviderCall('ollama', when);

    const row = await db('api_usage')
      .where({ provider: 'ollama', month: monthKey(when) })
      .first();
    expect(row).toBeDefined();
    expect(row!.call_count).toBe(1);
  });

  it('increments call_count on subsequent calls in the same month', async () => {
    const { recordProviderCall, monthKey } = await import('../src/usage.js');
    const when = LOCAL_NOON(2026, 2, 10);
    await recordProviderCall('claude', when);
    await recordProviderCall('claude', when);
    await recordProviderCall('claude', when);

    const row = await db('api_usage')
      .where({ provider: 'claude', month: monthKey(when) })
      .first();
    expect(row!.call_count).toBe(3);
  });

  it('keeps separate rows per month', async () => {
    const { recordProviderCall } = await import('../src/usage.js');
    await recordProviderCall('ollama', LOCAL_NOON(2026, 3, 1));   // 202603
    await recordProviderCall('ollama', LOCAL_NOON(2026, 4, 1));   // 202604

    const rows = await db('api_usage')
      .where({ provider: 'ollama' })
      .whereIn('month', ['202603', '202604'])
      .select('month', 'call_count');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.call_count === 1)).toBe(true);
  });

  it('keeps separate rows per provider in the same month', async () => {
    const { recordProviderCall } = await import('../src/usage.js');
    const when = LOCAL_NOON(2026, 5, 1);   // 202605
    await recordProviderCall('ollama', when);
    await recordProviderCall('ollama', when);
    await recordProviderCall('claude', when);

    const rows = await db('api_usage')
      .where({ month: '202605' })
      .select('provider', 'call_count');
    const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r.call_count]));
    expect(byProvider.ollama).toBe(2);
    expect(byProvider.claude).toBe(1);
  });
});

describe('getMonthlyUsage', () => {
  it('returns zeros for a month with no rows', async () => {
    const { getMonthlyUsage } = await import('../src/usage.js');
    const usage = await getMonthlyUsage('888801');  // far-future, guaranteed empty
    expect(usage).toEqual({
      month: '888801',
      claude: 0,
      ollama: 0,
      total: 0,
      localPercent: 0,
    });
  });

  it('aggregates ollama + claude with correct local percentage', async () => {
    const { recordProviderCall, getMonthlyUsage } = await import('../src/usage.js');
    const when = new Date(2026, 5, 15, 12, 0, 0);  // 202606, noon-local
    // 7 ollama + 3 claude → 70.00% local
    for (let i = 0; i < 7; i++) await recordProviderCall('ollama', when);
    for (let i = 0; i < 3; i++) await recordProviderCall('claude', when);

    const usage = await getMonthlyUsage('202606');
    expect(usage.ollama).toBe(7);
    expect(usage.claude).toBe(3);
    expect(usage.total).toBe(10);
    expect(usage.localPercent).toBeCloseTo(70.0, 2);
  });

  it('handles 100% local correctly (no division by zero on claude=0)', async () => {
    const { recordProviderCall, getMonthlyUsage } = await import('../src/usage.js');
    const when = new Date(2026, 6, 15, 12, 0, 0);  // 202607, noon-local
    await recordProviderCall('ollama', when);
    const usage = await getMonthlyUsage('202607');
    expect(usage.localPercent).toBe(100);
  });
});

describe('monthKey', () => {
  it('formats month as YYYYMM with zero-padding', async () => {
    const { monthKey } = await import('../src/usage.js');
    // Noon-local constructors so the local-time month read is unambiguous
    // regardless of the runner's timezone.
    expect(monthKey(new Date(2026, 0, 15, 12, 0, 0))).toBe('202601');
    expect(monthKey(new Date(2026, 8, 15, 12, 0, 0))).toBe('202609');
    expect(monthKey(new Date(2026, 11, 15, 12, 0, 0))).toBe('202612');
  });
});

describe('formatMonthLabel', () => {
  it('renders YYYYMM as a human label', async () => {
    const { formatMonthLabel } = await import('../src/usage.js');
    expect(formatMonthLabel('202604')).toMatch(/April 2026/);
  });

  it('falls back to the raw key on malformed input', async () => {
    const { formatMonthLabel } = await import('../src/usage.js');
    expect(formatMonthLabel('not-a-month')).toBe('not-a-month');
    expect(formatMonthLabel('202613')).toBe('202613');  // bad month number
  });
});

describe('formatUsageReport', () => {
  it('renders a zero-call month with an honest empty message', async () => {
    const { formatUsageReport } = await import('../src/usage.js');
    const text = formatUsageReport({ month: '202604', claude: 0, ollama: 0, total: 0, localPercent: 0 });
    expect(text).toMatch(/No routed calls/);
    expect(text).toMatch(/flat-rate/);
    // Honesty contract — no fabricated savings number.
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/saved/i);
  });

  it('renders counts and the local-handled percentage with thousands separators', async () => {
    const { formatUsageReport } = await import('../src/usage.js');
    const text = formatUsageReport({
      month: '202604',
      ollama: 1247,
      claude: 342,
      total: 1589,
      localPercent: 78.5,
    });
    expect(text).toMatch(/1,247/);
    expect(text).toMatch(/342/);
    expect(text).toMatch(/1,589/);
    expect(text).toMatch(/78\.5%/);
    expect(text).toMatch(/21\.5%/);
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/saved/i);
  });
});
