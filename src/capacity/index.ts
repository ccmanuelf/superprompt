/**
 * Capacity Planning — Public API, DB Persistence & Chart Generation
 *
 * Barrel export for the capacity module.
 * Provides DB table init, plan CRUD, and server-side chart rendering.
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';

import type {
  CapacityPlanConfig,
  CapacityAnalysisResult,
  CapacityPlan,
  LineCapacityResult,
  MonteCarloCapacityResults,
  ScenarioResult,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export { analyzeCapacity, analyzeLineCapacity, aggregateDemandByLine, generateUtilizationHeatmap } from './analysis.js';
export { runScenario, compareScenarios, getScenarioDefaults } from './scenarios.js';
export { runCapacityMonteCarlo, computeStats } from './monte-carlo.js';
export { calculateROI, compareROIs } from './roi.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initCapacityTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('capacity_plans'))) {
    await db.schema.createTable('capacity_plans', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.text('result_json');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_capacity_plans_name ON capacity_plans(name)');

  if (!(await db.schema.hasTable('capacity_results'))) {
    await db.schema.createTable('capacity_results', (t) => {
      t.text('id').primary();
      t.text('plan_id').notNullable().references('id').inTable('capacity_plans').onDelete('CASCADE');
      t.text('result_type').notNullable();
      t.text('result_json').notNullable();
      t.integer('created_at').notNullable();
      t.index(['plan_id'], 'idx_capacity_results_plan');
    });
  }

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('capacity_plans', 'chat_id'))) {
    await db.schema.alterTable('capacity_plans', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
    await db.raw('CREATE INDEX IF NOT EXISTS idx_capacity_plans_chat ON capacity_plans(chat_id, name)');
  }
}

export const capacityTableInit: TableInitializer = { name: 'capacity', initTables: initCapacityTables };

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(16).toString('hex');
}

export async function savePlan(
  name: string,
  config: CapacityPlanConfig,
  result?: CapacityAnalysisResult,
  chatId: string = '',
): Promise<CapacityPlan> {
  const db = getKnex();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = await db('capacity_plans')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as CapacityPlan | undefined;

  if (existing) {
    const now = Date.now();
    await db('capacity_plans')
      .where({ id: existing.id })
      .update({ config_json: configJson, result_json: resultJson, updated_at: now });
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('capacity_plans').insert({
    id, chat_id: chatId, name, config_json: configJson, result_json: resultJson, created_at: now, updated_at: now,
  });
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now, created_at: now };
}

export async function getPlan(nameOrId: string, chatId: string = ''): Promise<CapacityPlan | undefined> {
  const db = getKnex();
  const byId = await db('capacity_plans').where({ id: nameOrId }).first();
  if (byId) return byId as CapacityPlan;
  return await db('capacity_plans')
    .whereRaw('LOWER(name) = LOWER(?)', [nameOrId])
    .andWhere({ chat_id: chatId })
    .first() as CapacityPlan | undefined;
}

export async function listPlans(chatId: string = ''): Promise<CapacityPlan[]> {
  const db = getKnex();
  return await db('capacity_plans')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as CapacityPlan[];
}

export async function deletePlan(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('capacity_plans').where({ id, chat_id: chatId }).del();
  return count > 0;
}

export async function saveResult(
  planId: string,
  resultType: string,
  data: unknown,
): Promise<string> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('capacity_results').insert({
    id, plan_id: planId, result_type: resultType, result_json: JSON.stringify(data), created_at: now,
  });
  await db('capacity_plans').where({ id: planId }).update({ updated_at: now });
  return id;
}

export async function getResults(planId: string): Promise<Array<{ id: string; plan_id: string; result_type: string; result_json: string; created_at: number }>> {
  const db = getKnex();
  return await db('capacity_results')
    .where({ plan_id: planId })
    .orderBy('created_at', 'desc') as Array<{ id: string; plan_id: string; result_type: string; result_json: string; created_at: number }>;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate line utilization bar chart.
 * Color-coded: red=critical(>=95%), orange=warning(>=80%), green=ok.
 */
export async function generateCapacityUtilizationChart(
  lines: LineCapacityResult[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, lines.length * 100 + 200),
    height: 450,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = lines.map((l) => l.line_code);
  const utils = lines.map((l) => l.utilization_pct);
  const colors = lines.map((l) => {
    if (l.bottleneck_severity === 'critical') return '#e15759';
    if (l.bottleneck_severity === 'warning') return '#f28e2b';
    return '#59a14f';
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'Utilization %',
          data: utils,
          backgroundColor: colors,
          borderColor: colors.map((c) => c),
          borderWidth: 1,
        },
        {
          label: 'Capacity (hrs)',
          data: lines.map((l) => l.capacity_hours),
          type: 'line' as const,
          borderColor: '#4e79a7',
          borderWidth: 2,
          borderDash: [5, 5],
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
          formatter: (v: number) => `${v.toFixed(1)}%`,
          font: { size: 11, weight: 'bold' as const },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: Math.max(100, ...utils) + 10,
          title: { display: true, text: 'Utilization %' },
        },
        y2: {
          position: 'right' as const,
          beginAtZero: true,
          title: { display: true, text: 'Hours' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * Generate scenario comparison chart — grouped bars showing baseline vs projected.
 */
export async function generateScenarioComparisonChart(
  results: ScenarioResult[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(700, results.length * 120 + 200),
    height: 450,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = results.map((r) => r.scenario.name);

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'Baseline Utilization %',
          data: results.map((r) => r.baseline.overall_utilization_pct),
          backgroundColor: '#bab0ac',
        },
        {
          label: 'Projected Utilization %',
          data: results.map((r) => r.projected.overall_utilization_pct),
          backgroundColor: results.map((r) =>
            r.projected.overall_utilization_pct >= 95 ? '#e15759'
              : r.projected.overall_utilization_pct >= 80 ? '#f28e2b'
                : '#59a14f',
          ),
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
          formatter: (v: number) => `${v.toFixed(1)}%`,
          font: { size: 10 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { beginAtZero: true, max: 120, title: { display: true, text: 'Utilization %' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * Generate Monte Carlo histogram for overall utilization distribution.
 */
export async function generateMonteCarloHistogram(
  stats: MonteCarloCapacityResults,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: 700,
    height: 400,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  // Create histogram bins from distribution stats
  const { p5, p50, p95, mean, min, max } = stats.overall_utilization;
  const binCount = 10;
  const binWidth = (max - min) / binCount || 1;
  const bins: number[] = [];
  const binLabels: string[] = [];

  for (let i = 0; i < binCount; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    binLabels.push(`${lo.toFixed(0)}-${hi.toFixed(0)}%`);
    // Approximate count using normal distribution shape
    const midpoint = (lo + hi) / 2;
    const stddev = stats.overall_utilization.stddev || 1;
    const z = (midpoint - mean) / stddev;
    bins.push(Math.round(stats.replications * Math.exp(-0.5 * z * z) / (stddev * Math.sqrt(2 * Math.PI)) * binWidth));
  }

  const colors = binLabels.map((_, i) => {
    const midpoint = min + (i + 0.5) * binWidth;
    if (midpoint >= 95) return '#e15759';
    if (midpoint >= 80) return '#f28e2b';
    return '#59a14f';
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels: binLabels,
      datasets: [{
        label: 'Frequency',
        data: bins,
        backgroundColor: colors,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        datalabels: { display: false },
        legend: { display: false },
        subtitle: {
          display: true,
          text: `P5=${p5.toFixed(1)}% | P50=${p50.toFixed(1)}% | P95=${p95.toFixed(1)}% | Bottleneck prob: ${stats.bottleneck_probability.toFixed(1)}%`,
          font: { size: 12 },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Utilization %' } },
        y: { beginAtZero: true, title: { display: true, text: 'Frequency' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
