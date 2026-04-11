/**
 * Design of Experiments — Public API, DB & Charts
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import type {
  SavedDOE,
  ANOVATable,
  MainEffect,
  InteractionEffect,
  ExperimentMatrix,
} from './models.js';

export * from './models.js';
export { generateMatrix, analyzeDOE, createConfirmationRun } from './analysis.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initDoeTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('doe_experiments'))) {
    await db.schema.createTable('doe_experiments', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.text('result_json');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_doe_experiments_name ON doe_experiments(name)');

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('doe_experiments', 'chat_id'))) {
    await db.schema.alterTable('doe_experiments', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
    await db.raw('CREATE INDEX IF NOT EXISTS idx_doe_experiments_chat ON doe_experiments(chat_id, name)');
  }
}

export const doeTableInit: TableInitializer = { name: 'doe', initTables: initDoeTables };

function genId(): string { return randomBytes(16).toString('hex'); }

export async function saveDOE(name: string, config: unknown, result?: unknown, chatId: string = ''): Promise<SavedDOE> {
  const db = getKnex();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = await db('doe_experiments')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SavedDOE | undefined;

  if (existing) {
    const now = Date.now();
    await db('doe_experiments')
      .where({ id: existing.id })
      .update({ config_json: configJson, result_json: resultJson, updated_at: now });
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('doe_experiments').insert({
    id, chat_id: chatId, name, config_json: configJson, result_json: resultJson, created_at: now, updated_at: now,
  });
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export async function getDOE(nameOrId: string, chatId: string = ''): Promise<SavedDOE | undefined> {
  const db = getKnex();
  const byId = await db('doe_experiments').where({ id: nameOrId }).first();
  if (byId) return byId as SavedDOE;
  return await db('doe_experiments')
    .whereRaw('LOWER(name) = LOWER(?)', [nameOrId])
    .andWhere({ chat_id: chatId })
    .first() as SavedDOE | undefined;
}

export async function listDOEs(chatId: string = ''): Promise<SavedDOE[]> {
  const db = getKnex();
  return await db('doe_experiments')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as SavedDOE[];
}

export async function deleteDOE(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('doe_experiments').where({ id, chat_id: chatId }).del();
  return count > 0;
}

// ── Charts ───────────────────────────────────────────────────

/**
 * Main effects plot — mean response at each factor level.
 */
export async function generateMainEffectsChart(
  effects: MainEffect[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, effects.length * 200 + 100),
    height: 350,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949'];

  const datasets = effects.map((e, i) => ({
    label: e.factor_name,
    data: e.mean_responses,
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 2,
    pointRadius: 5,
    fill: false,
  }));

  // Use the factor with most levels for x-axis labels
  const maxLevels = Math.max(...effects.map((e) => e.levels.length));
  const labels = Array.from({ length: maxLevels }, (_, i) => `Level ${i + 1}`);

  const config = {
    type: 'line' as const,
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: {
          anchor: 'end' as const, align: 'top' as const,
          formatter: (v: number) => v.toFixed(2), font: { size: 9 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { title: { display: true, text: 'Mean Response' } },
        x: { title: { display: true, text: 'Factor Level' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * ANOVA contribution Pareto chart.
 */
export async function generateANOVAChart(
  anova: ANOVATable,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const sorted = [...anova.rows].sort((a, b) => b.contribution_pct - a.contribution_pct);

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, sorted.length * 80 + 200),
    height: 400,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels: sorted.map((r) => r.source),
      datasets: [{
        label: 'Contribution %',
        data: sorted.map((r) => r.contribution_pct),
        backgroundColor: sorted.map((r) => r.significant ? '#e15759' : '#bab0ac'),
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: {
          anchor: 'end' as const, align: 'top' as const,
          formatter: (v: number) => `${v.toFixed(1)}%`, font: { size: 10 },
        },
        legend: { display: false },
        subtitle: {
          display: true,
          text: `R² = ${anova.r_squared.toFixed(4)} | Adj R² = ${anova.adj_r_squared.toFixed(4)}`,
          font: { size: 12 },
        },
      },
      scales: {
        y: { beginAtZero: true, max: 100, title: { display: true, text: 'Contribution %' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
