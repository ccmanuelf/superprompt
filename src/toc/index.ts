/**
 * Theory of Constraints — Public API, DB Persistence & Chart Generation
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import type {
  TOCConfig,
  TOCAnalysis,
  SavedTOC,
  WorkCenterUtilization,
  BufferStatus,
  WIPGauge,
  ThroughputAccounting,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export { analyzeTOC, identifyConstraint, calculateThroughputAccounting, buildDBRSchedule, computeBufferStatus, computeWIPGauges } from './analysis.js';

// ── Database ─────────────────────────────────────────────────

export function initTocTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS toc_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_toc_configs_name ON toc_configs(name);

    CREATE TABLE IF NOT EXISTS toc_throughput_history (
      id TEXT PRIMARY KEY,
      config_name TEXT NOT NULL,
      period TEXT NOT NULL,
      throughput_units REAL NOT NULL,
      throughput_dollars REAL NOT NULL,
      constraint_utilization_pct REAL NOT NULL,
      wip_units REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_toc_history_config ON toc_throughput_history(config_name, period);
  `);
}

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string { return randomBytes(16).toString('hex'); }

export function saveTOC(name: string, config: TOCConfig, result?: TOCAnalysis): SavedTOC {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;
  const existing = db.prepare('SELECT * FROM toc_configs WHERE name = ? COLLATE NOCASE').get(name) as SavedTOC | undefined;
  if (existing) {
    db.prepare('UPDATE toc_configs SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?')
      .run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }
  const id = genId();
  const now = Date.now();
  db.prepare('INSERT INTO toc_configs (id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export function getTOC(nameOrId: string): SavedTOC | undefined {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM toc_configs WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM toc_configs WHERE name = ? COLLATE NOCASE').get(nameOrId)) as SavedTOC | undefined;
}

export function listTOCs(): SavedTOC[] {
  return getDatabase().prepare('SELECT * FROM toc_configs ORDER BY updated_at DESC').all() as SavedTOC[];
}

export function deleteTOC(id: string): boolean {
  return getDatabase().prepare('DELETE FROM toc_configs WHERE id = ?').run(id).changes > 0;
}

// ── Throughput History ───────────────────────────────────────

export interface ThroughputHistoryRow {
  id: string;
  config_name: string;
  period: string;
  throughput_units: number;
  throughput_dollars: number;
  constraint_utilization_pct: number;
  wip_units: number;
  created_at: number;
}

/**
 * Record a throughput data point for trend tracking.
 */
export function recordThroughput(
  configName: string,
  period: string,
  throughputUnits: number,
  throughputDollars: number,
  constraintUtilPct: number,
  wipUnits: number = 0,
): string {
  const db = getDatabase();
  const id = genId();
  db.prepare(
    'INSERT INTO toc_throughput_history (id, config_name, period, throughput_units, throughput_dollars, constraint_utilization_pct, wip_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, configName, period, throughputUnits, throughputDollars, constraintUtilPct, wipUnits, Date.now());
  return id;
}

/**
 * Get throughput history for a config, sorted by period.
 */
export function getThroughputHistory(configName: string, limit: number = 100): ThroughputHistoryRow[] {
  return getDatabase()
    .prepare('SELECT * FROM toc_throughput_history WHERE config_name = ? COLLATE NOCASE ORDER BY period DESC LIMIT ?')
    .all(configName, limit) as ThroughputHistoryRow[];
}

// ── Chart Generation ─────────────────────────────────────────

export async function generateUtilizationChart(
  ranking: WorkCenterUtilization[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;
  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, ranking.length * 90 + 200), height: 400, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = ranking.map((r) => r.name);
  const utils = ranking.map((r) => r.utilization_pct);
  const colors = ranking.map((r) => r.is_ccr ? '#e15759' : r.utilization_pct >= 80 ? '#f28e2b' : '#59a14f');

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [{
        label: 'Utilization %',
        data: utils,
        backgroundColor: colors,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: {
          anchor: 'end' as const, align: 'top' as const,
          formatter: (v: number) => `${v.toFixed(1)}%`,
          font: { size: 11, weight: 'bold' as const },
          color: (ctx: { dataIndex: number }) => ranking[ctx.dataIndex]?.is_ccr ? '#c62828' : '#333',
        },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: true, max: Math.max(110, ...utils) + 5, title: { display: true, text: 'Utilization %' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

export async function generateBufferChart(
  buffers: BufferStatus[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;
  const chartCanvas = new ChartJSNodeCanvas({
    width: 500, height: 300, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = buffers.map((b) => b.name);
  const consumed = buffers.map((b) => b.consumed);
  const remaining = buffers.map((b) => b.remaining);
  const zoneColors = buffers.map((b) => b.zone === 'green' ? '#59a14f' : b.zone === 'yellow' ? '#f28e2b' : '#e15759');

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        { label: 'Consumed', data: consumed, backgroundColor: zoneColors },
        { label: 'Remaining', data: remaining, backgroundColor: '#e0e0e0' },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: { display: false },
        legend: { position: 'bottom' as const },
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Hours' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

export async function generateWIPChart(
  gauges: WIPGauge[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;
  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(500, gauges.length * 80 + 200), height: 350, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = gauges.map((g) => g.work_center_name);
  const wips = gauges.map((g) => g.current_wip);
  const limits = gauges.map((g) => g.wip_limit);
  const colors = gauges.map((g) => g.status === 'critical' ? '#e15759' : g.status === 'warning' ? '#f28e2b' : '#59a14f');

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        { label: 'Current WIP', data: wips, backgroundColor: colors },
        { label: 'WIP Limit', data: limits, type: 'line' as const, borderColor: '#c62828', borderWidth: 2, borderDash: [5, 5], pointRadius: 4, datalabels: { display: false } },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: {
          anchor: 'end' as const, align: 'top' as const,
          formatter: (v: number) => v.toString(), font: { size: 10 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Units' } } },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
