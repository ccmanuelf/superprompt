/**
 * CONWIP & Heijunka — Public API, DB & Charts
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import type { SavedConwip, StageUtilization, HeijunkaAnalysis, ProductMix } from './models.js';

export * from './models.js';
export { analyzeCONWIP, analyzeHeijunka, simulateTokenFlow } from './analysis.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initConwipTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('conwip_configs'))) {
    await db.schema.createTable('conwip_configs', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.text('result_json');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_conwip_configs_name ON conwip_configs(name)');

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('conwip_configs', 'chat_id'))) {
    await db.schema.alterTable('conwip_configs', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
    await db.raw('CREATE INDEX IF NOT EXISTS idx_conwip_configs_chat ON conwip_configs(chat_id, name)');
  }
}

export const conwipTableInit: TableInitializer = { name: 'conwip', initTables: initConwipTables };

function genId(): string { return randomBytes(16).toString('hex'); }

export async function saveConwip(name: string, config: unknown, result?: unknown, chatId: string = ''): Promise<SavedConwip> {
  const db = getKnex();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = await db('conwip_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SavedConwip | undefined;

  if (existing) {
    const now = Date.now();
    await db('conwip_configs')
      .where({ id: existing.id })
      .update({ config_json: configJson, result_json: resultJson, updated_at: now });
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('conwip_configs').insert({
    id, chat_id: chatId, name, config_json: configJson, result_json: resultJson, created_at: now, updated_at: now,
  });
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export async function getConwip(nameOrId: string, chatId: string = ''): Promise<SavedConwip | undefined> {
  const db = getKnex();
  const byId = await db('conwip_configs').where({ id: nameOrId }).first();
  if (byId) return byId as SavedConwip;
  return await db('conwip_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [nameOrId])
    .andWhere({ chat_id: chatId })
    .first() as SavedConwip | undefined;
}

export async function listConwips(chatId: string = ''): Promise<SavedConwip[]> {
  const db = getKnex();
  return await db('conwip_configs')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as SavedConwip[];
}

export async function deleteConwip(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('conwip_configs').where({ id, chat_id: chatId }).del();
  return count > 0;
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
