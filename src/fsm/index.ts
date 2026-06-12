/**
 * State Machine Visual Simulator — Public API, DB & Charts
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import type { SavedFSM, MachineAnalysis } from './models.js';
import { MFG_STATE_COLORS } from './models.js';

export * from './models.js';
export { initSimulation, processEvent, stepSimulation, runUntil, runToCompletion, generateDemoEvents, analyzeSimulation } from './simulator.js';
export { validateFSM } from './validation.js';
export { getTemplate, listTemplates, FSM_TEMPLATES } from './templates.js';
export { bridgeFromSimulation, bridgeFromVSM, bridgeFromTOC, bridgeFromSequencer, createFSMFromBridge, normalizeMachineName } from './bridge.js';
export { generateStructuredText } from './codegen.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export async function initFsmTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('fsm_configs'))) {
    await db.schema.createTable('fsm_configs', (t) => {
      t.text('id').primary();
      t.text('chat_id').notNullable().defaultTo('');
      t.text('name').notNullable();
      t.text('config_json').notNullable();
      t.text('result_json');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  await db.raw('CREATE INDEX IF NOT EXISTS idx_fsm_configs_name ON fsm_configs(name)');

  // Migration: add chat_id column if missing (for existing databases)
  if (!(await db.schema.hasColumn('fsm_configs', 'chat_id'))) {
    await db.schema.alterTable('fsm_configs', (t) => {
      t.text('chat_id').notNullable().defaultTo('');
    });
    await db.raw('CREATE INDEX IF NOT EXISTS idx_fsm_configs_chat ON fsm_configs(chat_id, name)');
  }
}

export const fsmTableInit: TableInitializer = { name: 'fsm', initTables: initFsmTables };

function genId(): string { return randomBytes(16).toString('hex'); }

export async function saveFSM(name: string, config: unknown, result?: unknown, chatId: string = ''): Promise<SavedFSM> {
  const db = getKnex();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;

  const existing = await db('fsm_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .andWhere({ chat_id: chatId })
    .first() as SavedFSM | undefined;

  if (existing) {
    const now = Date.now();
    await db('fsm_configs')
      .where({ id: existing.id })
      .update({ config_json: configJson, result_json: resultJson, updated_at: now });
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: now };
  }

  const id = genId();
  const now = Date.now();
  await db('fsm_configs').insert({
    id, chat_id: chatId, name, config_json: configJson, result_json: resultJson, created_at: now, updated_at: now,
  });
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export async function getFSMConfig(nameOrId: string, chatId: string = ''): Promise<SavedFSM | undefined> {
  const db = getKnex();
  const byId = await db('fsm_configs').where({ id: nameOrId }).first();
  if (byId) return byId as SavedFSM;
  return await db('fsm_configs')
    .whereRaw('LOWER(name) = LOWER(?)', [nameOrId])
    .andWhere({ chat_id: chatId })
    .first() as SavedFSM | undefined;
}

export async function listFSMs(chatId: string = ''): Promise<SavedFSM[]> {
  const db = getKnex();
  return await db('fsm_configs')
    .where({ chat_id: chatId })
    .orderBy('updated_at', 'desc') as SavedFSM[];
}

export async function deleteFSMConfig(id: string, chatId: string = ''): Promise<boolean> {
  const db = getKnex();
  const count = await db('fsm_configs').where({ id, chat_id: chatId }).del();
  return count > 0;
}

// ── Charts ───────────────────────────────────────────────────

export async function generateStateResidenceChart(
  analysis: MachineAnalysis,
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: 500, height: 350, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const sorted = [...analysis.state_residence].sort((a, b) => b.total_time - a.total_time);
  const labels = sorted.map((s) => s.state_name);
  const values = sorted.map((s) => s.pct_of_total);
  const colors = sorted.map((s) => MFG_STATE_COLORS[s.mfg_type] ?? '#999');

  const config = {
    type: 'doughnut' as const,
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 1 }],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: {
          formatter: (v: number) => v > 3 ? `${v.toFixed(0)}%` : '',
          color: '#fff', font: { size: 11, weight: 'bold' as const },
        },
        legend: { position: 'right' as const, labels: { font: { size: 11 } } },
      },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}

export async function generateSystemUtilChart(
  machines: MachineAnalysis[],
  title: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(500, machines.length * 80 + 200), height: 350, backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels: machines.map((m) => m.machine_name),
      datasets: [
        { label: 'Utilization %', data: machines.map((m) => m.utilization_pct), backgroundColor: '#59a14f' },
        { label: 'Availability %', data: machines.map((m) => m.availability_pct), backgroundColor: '#4e79a7' },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        datalabels: { anchor: 'end' as const, align: 'top' as const, formatter: (v: number) => `${v.toFixed(0)}%`, font: { size: 10 } },
        legend: { position: 'bottom' as const },
      },
      scales: { y: { beginAtZero: true, max: 110, title: { display: true, text: '%' } } },
    },
  };

  const buf = await chartCanvas.renderToBuffer(config as never);
  return buf.toString('base64');
}
