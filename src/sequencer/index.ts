/**
 * Job Sequencing — Public API, DB Persistence & Chart Generation
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

import type {
  SequencerConfig,
  ScheduleResult,
  ScheduleEntry,
  SavedSchedule,
  GanttData,
  RuleComparison,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export { dispatch, compareAllRules } from './dispatching.js';
export { runGA } from './genetic.js';
export {
  buildSchedule,
  buildSingleMachineSchedule,
  buildScheduleFromPermutation,
  computeMetrics,
  buildGanttData,
  buildSetupMatrix,
  buildSetupMap,
  getSetupTime,
} from './evaluation.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export function initSequencerTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS seq_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_seq_schedules_name
      ON seq_schedules(name);
  `);
}

export const sequencerTableInit: TableInitializer = { name: 'sequencer', initTables: initSequencerTables };

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(16).toString('hex');
}

export function saveSchedule(
  name: string,
  config: SequencerConfig,
  result?: ScheduleResult | RuleComparison,
): SavedSchedule {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = db.prepare(
    'SELECT * FROM seq_schedules WHERE name = ? COLLATE NOCASE',
  ).get(name) as SavedSchedule | undefined;

  if (existing) {
    db.prepare(
      'UPDATE seq_schedules SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?',
    ).run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }

  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO seq_schedules (id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export function getSchedule(nameOrId: string): SavedSchedule | undefined {
  const db = getDatabase();
  return (
    db.prepare('SELECT * FROM seq_schedules WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM seq_schedules WHERE name = ? COLLATE NOCASE').get(nameOrId)
  ) as SavedSchedule | undefined;
}

export function listSchedules(): SavedSchedule[] {
  return getDatabase()
    .prepare('SELECT * FROM seq_schedules ORDER BY updated_at DESC')
    .all() as SavedSchedule[];
}

export function deleteSchedule(id: string): boolean {
  return getDatabase()
    .prepare('DELETE FROM seq_schedules WHERE id = ?')
    .run(id).changes > 0;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate Gantt chart as base64 PNG.
 */
export async function generateGanttChart(
  gantt: GanttData,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(800, gantt.horizon * 2 + 200),
    height: Math.max(300, gantt.machines.length * 80 + 150),
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  // Convert Gantt bars to horizontal bar chart data
  // Each machine is a Y category; bars are floating horizontal bars
  const datasets: Array<{
    label: string;
    data: Array<[number, number]>;
    backgroundColor: string[];
    borderColor: string[];
    borderWidth: number;
    barPercentage: number;
  }> = [];

  // Group bars by machine
  const barsByMachine = new Map<string, typeof gantt.bars>();
  for (const bar of gantt.bars) {
    const existing = barsByMachine.get(bar.machine_name) ?? [];
    existing.push(bar);
    barsByMachine.set(bar.machine_name, existing);
  }

  // Create one dataset per job (so legend shows job colors)
  const jobColors = new Map<string, string>();
  for (const bar of gantt.bars) {
    if (!bar.is_setup) {
      jobColors.set(bar.job_id, bar.color);
    }
  }

  // Simpler approach: single dataset with all bars
  const labels = gantt.machines;
  const barData: Array<{ x: [number, number]; y: string; color: string; label: string }> = [];

  for (const bar of gantt.bars) {
    barData.push({
      x: [bar.start, bar.end],
      y: bar.machine_name,
      color: bar.color,
      label: bar.is_setup ? '' : bar.job_name,
    });
  }

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [{
        label: 'Schedule',
        data: barData.map((b) => ({
          x: b.x,
          y: b.y,
        })),
        backgroundColor: barData.map((b) => b.color),
        borderColor: barData.map((b) => b.color),
        borderWidth: 1,
        barPercentage: 0.6,
      }],
    },
    options: {
      indexAxis: 'y' as const,
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        legend: { display: false },
        datalabels: {
          color: '#fff',
          font: { size: 9 },
          formatter: (_v: unknown, ctx: { dataIndex: number }) => barData[ctx.dataIndex]?.label || '',
        },
      },
      scales: {
        x: {
          type: 'linear' as const,
          title: { display: true, text: 'Time (minutes)' },
          min: 0,
          max: gantt.horizon + 10,
        },
        y: {
          title: { display: true, text: 'Machine' },
        },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

/**
 * Generate rule comparison bar chart.
 */
export async function generateComparisonChart(
  comparison: RuleComparison,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(700, comparison.rules.length * 120 + 200),
    height: 450,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const labels = comparison.rules.map((r) => r.rule_or_method);

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'Makespan (min)',
          data: comparison.rules.map((r) => r.metrics.makespan),
          backgroundColor: '#4e79a7',
        },
        {
          label: 'Total Lateness (min)',
          data: comparison.rules.map((r) => r.metrics.total_lateness),
          backgroundColor: '#e15759',
        },
        {
          label: 'Setup Time (min)',
          data: comparison.rules.map((r) => r.metrics.total_setup_time),
          backgroundColor: '#f28e2b',
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
          font: { size: 9 },
          formatter: (v: number) => v.toFixed(0),
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Minutes' } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
