/**
 * State Machine Visual Simulator — Public API, DB & Charts
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import type { SavedFSM, MachineAnalysis, StateResidence } from './models.js';
import { MFG_STATE_COLORS } from './models.js';

export * from './models.js';
export { initSimulation, processEvent, stepSimulation, runUntil, runToCompletion, generateDemoEvents, analyzeSimulation } from './simulator.js';
export { validateFSM } from './validation.js';
export { getTemplate, listTemplates, FSM_TEMPLATES } from './templates.js';
export { bridgeFromSimulation, bridgeFromVSM, bridgeFromTOC, bridgeFromSequencer, createFSMFromBridge, normalizeMachineName } from './bridge.js';
export { generateStructuredText } from './codegen.js';

import type { TableInitializer } from '../core/interfaces.js';

// ── Database ─────────────────────────────────────────────────

export function initFsmTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fsm_configs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fsm_configs_name ON fsm_configs(name);
    CREATE INDEX IF NOT EXISTS idx_fsm_configs_chat ON fsm_configs(chat_id, name);
  `);

  // Migration: add chat_id column if missing (for existing databases)
  const cols = db.prepare("PRAGMA table_info(fsm_configs)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'chat_id')) {
    db.exec("ALTER TABLE fsm_configs ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_fsm_configs_chat ON fsm_configs(chat_id, name)');
  }
}

export const fsmTableInit: TableInitializer = { name: 'fsm', initTables: initFsmTables };

function genId(): string { return randomBytes(16).toString('hex'); }

export function saveFSM(name: string, config: unknown, result?: unknown, chatId: string = ''): SavedFSM {
  const db = getDatabase();
  const configJson = JSON.stringify(config);
  const resultJson = result ? JSON.stringify(result) : null;
  const existing = db.prepare('SELECT * FROM fsm_configs WHERE name = ? COLLATE NOCASE AND chat_id = ?').get(name, chatId) as SavedFSM | undefined;
  if (existing) {
    db.prepare('UPDATE fsm_configs SET config_json = ?, result_json = ?, updated_at = ? WHERE id = ?')
      .run(configJson, resultJson, Date.now(), existing.id);
    return { ...existing, config_json: configJson, result_json: resultJson ?? undefined, updated_at: Date.now() };
  }
  const id = genId();
  const now = Date.now();
  db.prepare('INSERT INTO fsm_configs (id, chat_id, name, config_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, chatId, name, configJson, resultJson, now, now);
  return { id, name, config_json: configJson, result_json: resultJson ?? undefined, created_at: now, updated_at: now };
}

export function getFSMConfig(nameOrId: string, chatId: string = ''): SavedFSM | undefined {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM fsm_configs WHERE id = ?').get(nameOrId) ??
    db.prepare('SELECT * FROM fsm_configs WHERE name = ? COLLATE NOCASE AND chat_id = ?').get(nameOrId, chatId)) as SavedFSM | undefined;
}

export function listFSMs(chatId: string = ''): SavedFSM[] {
  return getDatabase().prepare('SELECT * FROM fsm_configs WHERE chat_id = ? ORDER BY updated_at DESC').all(chatId) as SavedFSM[];
}

export function deleteFSMConfig(id: string, chatId: string = ''): boolean {
  return getDatabase().prepare('DELETE FROM fsm_configs WHERE id = ? AND chat_id = ?').run(id, chatId).changes > 0;
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
