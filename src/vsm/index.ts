/**
 * Value Stream Mapping — Public API, DB Persistence & Chart Generation
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

import type {
  VSMConfig,
  VSMAnalysis,
  VSMComparison,
  SavedVSM,
  WaterfallEntry,
  TimewoodsBreakdown,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export { analyzeVSM, compareStates, classifyTimwoods } from './analysis.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export function initVsmTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS vsm_maps (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vsm_maps_name ON vsm_maps(name);
    CREATE INDEX IF NOT EXISTS idx_vsm_maps_chat ON vsm_maps(chat_id, name);
  `);

  // Migration: add chat_id column if missing (for existing databases)
  const cols = db.prepare("PRAGMA table_info(vsm_maps)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'chat_id')) {
    db.exec("ALTER TABLE vsm_maps ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_vsm_maps_chat ON vsm_maps(chat_id, name)');
  }
}

export const vsmTableInit: TableInitializer = { name: 'vsm', initTables: initVsmTables };

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(16).toString('hex');
}

export function saveVSM(
  name: string,
  config: VSMConfig,
  result?: VSMAnalysis,
  chatId: string = '',
): SavedVSM {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = db.prepare(
    'SELECT * FROM vsm_maps WHERE name = ? COLLATE NOCASE AND chat_id = ?',
  ).get(name, chatId) as SavedVSM | undefined;

  if (existing) {
    db.prepare(
      'UPDATE vsm_maps SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?',
    ).run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }

  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO vsm_maps (id, chat_id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, chatId, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export function getVSM(nameOrId: string, chatId: string = ''): SavedVSM | undefined {
  const db = getDatabase();
  return (
    db.prepare('SELECT * FROM vsm_maps WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM vsm_maps WHERE name = ? COLLATE NOCASE AND chat_id = ?').get(nameOrId, chatId)
  ) as SavedVSM | undefined;
}

export function listVSMs(chatId: string = ''): SavedVSM[] {
  return getDatabase()
    .prepare('SELECT * FROM vsm_maps WHERE chat_id = ? ORDER BY updated_at DESC')
    .all(chatId) as SavedVSM[];
}

export function deleteVSM(id: string, chatId: string = ''): boolean {
  return getDatabase()
    .prepare('DELETE FROM vsm_maps WHERE id = ? AND chat_id = ?')
    .run(id, chatId).changes > 0;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Lead time waterfall chart — stacked bars showing VA, NVA, wait, transport.
 */
export async function generateWaterfallChart(
  waterfall: WaterfallEntry[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(700, waterfall.length * 90 + 200),
    height: 450,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = waterfall.map((w) => w.label);

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'VA Time',
          data: waterfall.map((w) => w.va_minutes),
          backgroundColor: '#59a14f',
        },
        {
          label: 'NVA Time',
          data: waterfall.map((w) => w.nva_minutes),
          backgroundColor: '#e15759',
        },
        {
          label: 'Wait Time',
          data: waterfall.map((w) => w.wait_minutes),
          backgroundColor: '#f28e2b',
        },
        {
          label: 'Transport Time',
          data: waterfall.map((w) => w.transport_minutes),
          backgroundColor: '#76b7b2',
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: { display: false },
        legend: { position: 'bottom' as const },
      },
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: 'Minutes' },
        },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * TIMWOODS waste Pareto chart.
 */
export async function generateTimwoodsChart(
  timwoods: TimewoodsBreakdown[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const sorted = [...timwoods].filter((t) => t.total_minutes > 0).sort((a, b) => b.total_minutes - a.total_minutes);

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, sorted.length * 90 + 200),
    height: 400,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = sorted.map((t) => t.label);
  const values = sorted.map((t) => t.total_minutes);
  const total = values.reduce((s, v) => s + v, 0);

  // Cumulative % for Pareto line
  let cum = 0;
  const cumPct = values.map((v) => {
    cum += v;
    return total > 0 ? (cum / total) * 100 : 0;
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'Waste (min)',
          data: values,
          backgroundColor: '#e15759',
          yAxisID: 'y',
        },
        {
          label: 'Cumulative %',
          data: cumPct,
          type: 'line' as const,
          borderColor: '#4e79a7',
          borderWidth: 2,
          pointRadius: 4,
          yAxisID: 'y2',
          datalabels: { display: false },
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: {
          anchor: 'end' as const,
          align: 'top' as const,
          formatter: (v: number) => `${v.toFixed(0)}`,
          font: { size: 10 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Minutes' } },
        y2: {
          position: 'right' as const,
          beginAtZero: true,
          max: 100,
          title: { display: true, text: 'Cumulative %' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * PCE comparison chart (current vs future).
 */
export async function generatePCEComparisonChart(
  comparison: VSMComparison,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: 600,
    height: 350,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels: ['Lead Time (min)', 'VA Time (min)', 'PCE (%)', 'WIP (units)', 'Operators'],
      datasets: [
        {
          label: 'Current State',
          data: [
            comparison.current.total_lead_time,
            comparison.current.total_va_time,
            comparison.current.pce_pct,
            comparison.current.total_wip_units,
            comparison.current.total_operators,
          ],
          backgroundColor: '#bab0ac',
        },
        {
          label: 'Future State',
          data: [
            comparison.future.total_lead_time,
            comparison.future.total_va_time,
            comparison.future.pce_pct,
            comparison.future.total_wip_units,
            comparison.future.total_operators,
          ],
          backgroundColor: '#59a14f',
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: {
          anchor: 'end' as const,
          align: 'top' as const,
          formatter: (v: number) => v.toFixed(1),
          font: { size: 10 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
