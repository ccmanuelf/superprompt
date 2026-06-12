/**
 * Theory of Constraints — Public API, DB Persistence & Chart Generation
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import type {
  TOCConfig,
  TOCAnalysis,
  SavedTOC,
  WorkCenterUtilization,
  BufferStatus,
  WIPGauge,
} from './models.js';

// ── Re-exports ───────────────────────────────────────────────

export * from './models.js';
export { analyzeTOC, identifyConstraint, calculateThroughputAccounting, buildDBRSchedule, computeBufferStatus, computeWIPGauges } from './analysis.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initTocTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('toc_configs'))) {
    await db.schema.createTable('toc_configs', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.text('result_json');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_toc_configs_name ON toc_configs(name)');

  if (!(await db.schema.hasTable('toc_throughput_history'))) {
    await db.schema.createTable('toc_throughput_history', (t) => {
      t.text('id').primary();
      t.text('config_name').notNullable();
      t.text('period').notNullable();
      t.float('throughput_units').notNullable();
      t.float('throughput_dollars').notNullable();
      t.float('constraint_utilization_pct').notNullable();
      t.float('wip_units').notNullable().defaultTo(0);
      t.integer('created_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_toc_history_config ON toc_throughput_history(config_name, period)');

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('toc_configs', 'chat_id'))) {
    await db.schema.alterTable('toc_configs', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
    await db.raw('CREATE INDEX IF NOT EXISTS idx_toc_configs_chat ON toc_configs(chat_id, name)');
  }
}

export const tocTableInit: TableInitializer = { name: 'toc', initTables: initTocTables };

// ── CRUD ─────────────────────────────────────────────────────

function genId(): string { return randomBytes(16).toString('hex'); }

export async function saveTOC(name: string, config: TOCConfig, result?: TOCAnalysis, chatId: string = ''): Promise<SavedTOC> {
  const db = getKnex();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = await db('toc_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SavedTOC | undefined;

  if (existing) {
    const now = Date.now();
    await db('toc_configs')
      .where({ id: existing.id })
      .update({ config_json: configJson, result_json: resultJson, updated_at: now });
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('toc_configs').insert({
    id, chat_id: chatId, name, config_json: configJson, result_json: resultJson, created_at: now, updated_at: now,
  });
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export async function getTOC(nameOrId: string, chatId: string = ''): Promise<SavedTOC | undefined> {
  const db = getKnex();
  const byId = await db('toc_configs').where({ id: nameOrId }).first();
  if (byId) return byId as SavedTOC;
  return await db('toc_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [nameOrId])
    .andWhere({ chat_id: chatId })
    .first() as SavedTOC | undefined;
}

export async function listTOCs(chatId: string = ''): Promise<SavedTOC[]> {
  const db = getKnex();
  return await db('toc_configs')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as SavedTOC[];
}

export async function deleteTOC(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('toc_configs').where({ id, chat_id: chatId }).del();
  return count > 0;
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
export async function recordThroughput(
  configName: string,
  period: string,
  throughputUnits: number,
  throughputDollars: number,
  constraintUtilPct: number,
  wipUnits: number = 0,
): Promise<string> {
  const db = getKnex();
  const id = genId();
  await db('toc_throughput_history').insert({
    id, config_name: configName, period, throughput_units: throughputUnits,
    throughput_dollars: throughputDollars, constraint_utilization_pct: constraintUtilPct,
    wip_units: wipUnits, created_at: Date.now(),
  });
  return id;
}

/**
 * Get throughput history for a config, sorted by period.
 */
export async function getThroughputHistory(configName: string, limit: number = 100): Promise<ThroughputHistoryRow[]> {
  const db = getKnex();
  return await db('toc_throughput_history')
    .whereRaw('LOWER(config_name) = LOWER(?)', [configName])
    .orderBy('period', 'desc')
    .limit(limit) as ThroughputHistoryRow[];
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
