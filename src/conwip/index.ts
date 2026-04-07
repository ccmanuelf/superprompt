/**
 * CONWIP & Heijunka — Public API, DB & Charts
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import type { SavedConwip, StageUtilization, HeijunkaAnalysis, ProductMix } from './models.js';

export * from './models.js';
export { analyzeCONWIP, analyzeHeijunka, simulateTokenFlow } from './analysis.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export function initConwipTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS conwip_configs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conwip_configs_name ON conwip_configs(name);
  `);

  // Migration: add chat_id column if missing (for existing databases)
  const cols = db.prepare("PRAGMA table_info(conwip_configs)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'chat_id')) {
    db.exec("ALTER TABLE conwip_configs ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_conwip_configs_chat ON conwip_configs(chat_id, name)');
  }
}

export const conwipTableInit: TableInitializer = { name: 'conwip', initTables: initConwipTables };

function genId(): string { return randomBytes(16).toString('hex'); }

export function saveConwip(name: string, config: unknown, result?: unknown, chatId: string = ''): SavedConwip {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;
  const existing = db.prepare('SELECT * FROM conwip_configs WHERE name = ? COLLATE NOCASE AND chat_id = ?').get(name, chatId) as SavedConwip | undefined;
  if (existing) {
    db.prepare('UPDATE conwip_configs SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?')
      .run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }
  const id = genId();
  const now = Date.now();
  db.prepare('INSERT INTO conwip_configs (id, chat_id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, chatId, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export function getConwip(nameOrId: string, chatId: string = ''): SavedConwip | undefined {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM conwip_configs WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM conwip_configs WHERE name = ? COLLATE NOCASE AND chat_id = ?').get(nameOrId, chatId)) as SavedConwip | undefined;
}

export function listConwips(chatId: string = ''): SavedConwip[] {
  return getDatabase().prepare('SELECT * FROM conwip_configs WHERE chat_id = ? ORDER BY updated_at DESC').all(chatId) as SavedConwip[];
}

export function deleteConwip(id: string, chatId: string = ''): boolean {
  return getDatabase().prepare('DELETE FROM conwip_configs WHERE id = ? AND chat_id = ?').run(id, chatId).changes > 0;
}

// ── Charts ───────────────────────────────────────────────────

export async function generateStageUtilChart(stages: StageUtilization[], title: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;
  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(500, stages.length * 80 + 200), height: 350, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });
  const config = {
    type: 'bar' as const,
    data: {
      labels: stages.map((s) => s.stage_name),
      datasets: [{
        label: 'Utilization %', data: stages.map((s) => s.utilization_pct),
        backgroundColor: stages.map((s) => s.is_bottleneck ? '#e15759' : s.utilization_pct >= 80 ? '#f28e2b' : '#59a14f'),
      }, {
        label: 'WIP Count', data: stages.map((s) => s.wip_count),
        type: 'line' as const, borderColor: '#4e79a7', borderWidth: 2, pointRadius: 4,
        yAxisID: 'y2', datalabels: { display: false },
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: { anchor: 'end' as const, align: 'top' as const, formatter: (v: number) => `${v.toFixed(0)}%`, font: { size: 10 } },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { beginAtZero: true, max: 120, title: { display: true, text: 'Util %' } },
        y2: { position: 'right' as const, beginAtZero: true, title: { display: true, text: 'WIP' }, grid: { drawOnChartArea: false } },
      },
    },
  };
  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

export async function generateMixChart(mixes: ProductMix[], title: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;
  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(500, mixes.length * 100 + 200), height: 350, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });
  const config = {
    type: 'bar' as const,
    data: {
      labels: mixes.map((m) => m.product_name),
      datasets: [
        { label: 'Target %', data: mixes.map((m) => m.target_pct), backgroundColor: '#bab0ac' },
        { label: 'Actual %', data: mixes.map((m) => m.actual_pct), backgroundColor: '#59a14f' },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: { anchor: 'end' as const, align: 'top' as const, formatter: (v: number) => `${v.toFixed(1)}%`, font: { size: 10 } },
        legend: { position: 'bottom' as const },
      },
      scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } },
    },
  };
  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
