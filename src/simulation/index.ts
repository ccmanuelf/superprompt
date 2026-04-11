/**
 * Production Line Simulation v3.0 — Public API + DB Persistence
 *
 * Barrel export for the simulation module.
 * Provides DB table initialization, scenario CRUD, and chart generation.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKnex } from '../db-knex.js';
import { logger } from '../logger.js';
import { STORE_DIR } from '../config.js';

import type {
  SimulationConfig,
  SimulationResults,
  MonteCarloResults,
  SimScenario,
  SimResultRow,
  StationPerformanceRow,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export * from './constants.js';
export { runSimulation, ProductionLineSimulator, SimEnvironment, SimResource } from './engine.js';
export { validateSimulationConfig } from './validation.js';
export { calculateAllBlocks } from './calculations.js';
export { runMonteCarlo, computeStats } from './monte-carlo.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initSimulationTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('sim_scenarios'))) {
    await db.schema.createTable('sim_scenarios', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  if (!(await db.schema.hasTable('sim_results'))) {
    await db.schema.createTable('sim_results', (t) => {
      t.text('id').primary();
      t.text('scenario_id').notNullable().references('id').inTable('sim_scenarios').onDelete('CASCADE');
      t.text('result_type').notNullable();
      t.text('result_json').notNullable();
      t.integer('created_at').notNullable();
      t.index(['scenario_id'], 'idx_sim_results_scenario');
    });
  }

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('sim_scenarios', 'chat_id'))) {
    await db.schema.alterTable('sim_scenarios', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
  }

  // Ensure index exists (idempotent via raw)
  await db.raw('CREATE INDEX IF NOT EXISTS idx_sim_scenarios_chat ON sim_scenarios(chat_id, name)');
}

export const simulationTableInit: TableInitializer = { name: 'simulation', initTables: initSimulationTables };

function genId(): string {
  return randomBytes(16).toString('hex');
}

export async function saveScenario(name: string, config: SimulationConfig, chatId: string = ''): Promise<SimScenario> {
  const db = getKnex();

  // Reuse existing (scoped to user) or create new
  const existing = await db('sim_scenarios')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SimScenario | undefined;

  if (existing) {
    const now = Date.now();
    await db('sim_scenarios')
      .where({ id: existing.id })
      .update({ config_json: JSON.stringify(config), updated_at: now });
    return { ...existing, config_json: JSON.stringify(config), updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('sim_scenarios').insert({
    id, chat_id: chatId, name, config_json: JSON.stringify(config), created_at: now, updated_at: now,
  });
  return { id, name, config_json: JSON.stringify(config), created_at: now, updated_at: now };
}

export async function getScenarioByName(name: string, chatId: string = ''): Promise<SimScenario | undefined> {
  const db = getKnex();
  return await db('sim_scenarios')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SimScenario | undefined;
}

export async function listScenarios(chatId: string = ''): Promise<SimScenario[]> {
  const db = getKnex();
  return await db('sim_scenarios')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as SimScenario[];
}

export async function deleteScenario(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('sim_scenarios').where({ id, chat_id: chatId }).del();
  return count > 0;
}

export async function saveSimResult(scenarioId: string, resultType: string, data: unknown): Promise<string> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('sim_results').insert({
    id, scenario_id: scenarioId, result_type: resultType, result_json: JSON.stringify(data), created_at: now,
  });
  await db('sim_scenarios').where({ id: scenarioId }).update({ updated_at: now });
  return id;
}

export async function getSimResults(scenarioId: string): Promise<SimResultRow[]> {
  const db = getKnex();
  return await db('sim_results')
    .where({ scenario_id: scenarioId })
    .orderBy('created_at', 'desc') as SimResultRow[];
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate station utilization bar chart.
 * Color-coded: red=bottleneck, orange=warning, green=normal.
 * Exported for testing.
 */
export async function generateUtilizationChart(
  stationPerformance: StationPerformanceRow[],
  projectName: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(600, stationPerformance.length * 80 + 200),
    height: 450,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  // Deduplicate by machine tool (show highest util per tool)
  const toolUtil = new Map<string, { util: number; isBottleneck: boolean; isDonor: boolean }>();
  for (const s of stationPerformance) {
    const existing = toolUtil.get(s.machine_tool);
    if (!existing || s.util_pct > existing.util) {
      toolUtil.set(s.machine_tool, { util: s.util_pct, isBottleneck: s.is_bottleneck, isDonor: s.is_donor });
    }
  }

  const labels = [...toolUtil.keys()];
  const utils = labels.map((l) => toolUtil.get(l)!.util);
  const colors = labels.map((l) => {
    const info = toolUtil.get(l)!;
    if (info.isBottleneck) return '#e15759';
    if (info.util >= 80) return '#f28e2b';
    if (info.isDonor) return '#76b7b2';
    return '#59a14f';
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [{
        label: 'Utilization %',
        data: utils,
        backgroundColor: colors,
        barPercentage: 0.7,
        datalabels: {
          display: true,
          formatter: (v: number) => `${v.toFixed(0)}%`,
          color: '#333',
          anchor: 'end' as const,
          align: 'top' as const,
          font: { size: 11, weight: 'bold' as const },
        },
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`Station Utilization: ${projectName}`, 'Red=Bottleneck | Orange=Warning | Green=Normal'],
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: {
        y: { title: { display: true, text: 'Utilization %' }, min: 0, max: Math.max(100, ...utils) * 1.15 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `sim-utilization-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate WIP timeline chart from samples.
 * Exported for testing.
 */
export async function generateWipChart(
  wipSamples: number[],
  projectName: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400, backgroundColour: 'white' });

  const labels = wipSamples.map((_, i) => `${(i + 1) * 5}`); // 5-min intervals

  const config = {
    type: 'line' as const,
    data: {
      labels,
      datasets: [{
        label: 'WIP (pieces)',
        data: wipSamples,
        borderColor: '#4e79a7',
        backgroundColor: 'rgba(78,121,167,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 1,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: `WIP Timeline: ${projectName}`, font: { size: 14 } },
        legend: { display: false },
      },
      scales: {
        x: { title: { display: true, text: 'Time (minutes)' } },
        y: { title: { display: true, text: 'Work in Progress (pieces)' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `sim-wip-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate throughput vs demand chart.
 * Exported for testing.
 */
export async function generateThroughputChart(
  results: SimulationResults,
  projectName: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 700, height: 400, backgroundColour: 'white' });

  const products = results.per_product_summary.map((p) => p.product);
  const demands = results.per_product_summary.map((p) => p.daily_demand_pcs);
  const throughputs = results.per_product_summary.map((p) => p.daily_throughput_pcs);

  const config = {
    type: 'bar' as const,
    data: {
      labels: products,
      datasets: [
        { label: 'Daily Demand', data: demands, backgroundColor: '#e15759' },
        { label: 'Daily Throughput', data: throughputs, backgroundColor: '#59a14f' },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: `Throughput vs Demand: ${projectName}`, font: { size: 14 } },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { title: { display: true, text: 'Pieces / Day' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `sim-throughput-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate Monte Carlo throughput distribution histogram.
 * Exported for testing.
 */
export async function generateMonteCarloChart(
  mcResults: MonteCarloResults,
  projectName: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400, backgroundColour: 'white' });

  // Build histogram from per-replication throughputs
  const throughputs = mcResults.per_replication.map((r) => {
    let total = 0;
    for (const p of r.per_product_summary) total += p.daily_throughput_pcs;
    return total;
  });

  const min = Math.min(...throughputs);
  const max = Math.max(...throughputs);
  const range = max - min || 1;
  const binCount = Math.max(8, Math.ceil(Math.sqrt(throughputs.length)));
  const binWidth = range / binCount;

  const bins = new Array(binCount).fill(0);
  const binLabels: string[] = [];
  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth;
    binLabels.push(Math.round(binStart).toString());
    for (const t of throughputs) {
      if (t >= binStart && (i === binCount - 1 ? t <= binStart + binWidth : t < binStart + binWidth)) {
        bins[i]++;
      }
    }
  }

  const config = {
    type: 'bar' as const,
    data: {
      labels: binLabels,
      datasets: [{
        label: 'Frequency',
        data: bins,
        backgroundColor: '#4e79a7',
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `Monte Carlo: ${projectName} (${mcResults.replications} replications)`,
            `Mean: ${mcResults.throughput.mean} | P5: ${mcResults.throughput.p5} | P95: ${mcResults.throughput.p95} | Demand met: ${mcResults.demand_met_pct}%`,
          ],
          font: { size: 13 },
        },
        legend: { display: false },
      },
      scales: {
        x: { title: { display: true, text: 'Total Throughput (pieces)' } },
        y: { title: { display: true, text: 'Frequency' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `sim-montecarlo-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format simulation results for Telegram display.
 * Exported for testing.
 */
export function formatSimulationResults(results: SimulationResults, name: string, html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';
  const lines: string[] = [];

  lines.push(`${b}Simulation: ${name}${bEnd} (v${results.assumption_log.simulation_engine_version})`);
  lines.push('');

  // Daily summary
  const ds = results.daily_summary;
  lines.push(`${b}Daily:${bEnd} ${ds.daily_throughput_pcs} / ${ds.daily_demand_pcs} pcs (${ds.daily_coverage_pct}% coverage)`);
  lines.push(`${b}Cycle Time:${bEnd} ${ds.avg_cycle_time_min} min avg | ${b}WIP:${bEnd} ${ds.avg_wip_pcs} pcs avg`);
  lines.push(`${b}Schedule:${bEnd} ${ds.total_shifts_per_day} shift(s), ${ds.daily_planned_hours}h/day`);
  lines.push('');

  // Top bottlenecks
  const bottlenecks = results.station_performance.filter((s) => s.is_bottleneck);
  if (bottlenecks.length > 0) {
    lines.push(`${b}Bottlenecks:${bEnd}`);
    for (const bn of bottlenecks) {
      lines.push(`  ${bn.machine_tool}: ${bn.util_pct}% utilization`);
    }
  } else {
    const topStation = results.station_performance[0];
    if (topStation) {
      lines.push(`${b}Constraint:${bEnd} ${topStation.machine_tool} at ${topStation.util_pct}%`);
    }
  }

  // Rebalancing
  if (results.rebalancing_suggestions.length > 0) {
    lines.push('');
    lines.push(`${b}Rebalancing Suggestions:${bEnd}`);
    for (const s of results.rebalancing_suggestions) {
      lines.push(`  [${s.role}] ${s.operation}: ${s.comment}`);
    }
  }

  // Duration
  lines.push('');
  lines.push(`Simulated in ${results.simulation_duration_seconds.toFixed(3)}s`);

  return lines.join('\n');
}
