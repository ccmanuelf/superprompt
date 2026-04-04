/**
 * Capacity Planning — Public API, DB Persistence & Chart Generation
 *
 * Barrel export for the capacity module.
 * Provides DB table init, plan CRUD, and server-side chart rendering.
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

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

export function initCapacityTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS capacity_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_capacity_plans_name
      ON capacity_plans(name);

    CREATE TABLE IF NOT EXISTS capacity_results (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      result_type TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES capacity_plans(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_capacity_results_plan
      ON capacity_results(plan_id);
  `);
}

export const capacityTableInit: TableInitializer = { name: 'capacity', initTables: initCapacityTables };

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(16).toString('hex');
}

export function savePlan(
  name: string,
  config: CapacityPlanConfig,
  result?: CapacityAnalysisResult,
): CapacityPlan {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = db.prepare(
    'SELECT * FROM capacity_plans WHERE name = ? COLLATE NOCASE',
  ).get(name) as CapacityPlan | undefined;

  if (existing) {
    db.prepare(
      'UPDATE capacity_plans SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?',
    ).run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }

  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO capacity_plans (id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now, created_at: now };
}

export function getPlan(nameOrId: string): CapacityPlan | undefined {
  const db = getDatabase();
  return (
    db.prepare('SELECT * FROM capacity_plans WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM capacity_plans WHERE name = ? COLLATE NOCASE').get(nameOrId)
  ) as CapacityPlan | undefined;
}

export function listPlans(): CapacityPlan[] {
  return getDatabase()
    .prepare('SELECT * FROM capacity_plans ORDER BY updated_at DESC')
    .all() as CapacityPlan[];
}

export function deletePlan(id: string): boolean {
  return getDatabase()
    .prepare('DELETE FROM capacity_plans WHERE id = ?')
    .run(id).changes > 0;
}

export function saveResult(
  planId: string,
  resultType: string,
  data: unknown,
): string {
  const db = getDatabase();
  const id = genId();
  db.prepare(
    'INSERT INTO capacity_results (id, plan_id, result_type, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, planId, resultType, JSON.stringify(data), Date.now());
  db.prepare('UPDATE capacity_plans SET updated_at = ? WHERE id = ?').run(Date.now(), planId);
  return id;
}

export function getResults(planId: string): Array<{ id: string; plan_id: string; result_type: string; result_json: string; created_at: number }> {
  return getDatabase()
    .prepare('SELECT * FROM capacity_results WHERE plan_id = ? ORDER BY created_at DESC')
    .all(planId) as Array<{ id: string; plan_id: string; result_type: string; result_json: string; created_at: number }>;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate line utilization bar chart.
 * Color-coded: red=critical(≥95%), orange=warning(≥80%), green=ok.
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
  const { p5, p25, p50, p75, p95, mean, min, max } = stats.overall_utilization;
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
