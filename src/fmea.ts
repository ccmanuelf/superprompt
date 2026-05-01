import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';
import type { TableInitializer } from './core/interfaces.js';
import { calculateFmeaMetrics } from './calculations/fmea.js';

// ── Types ────────────────────────────────────────────────────

export type FmeaType = 'pfmea' | 'dfmea';

export interface FmeaDocument {
  id: string;
  name: string;
  fmea_type: FmeaType;
  product: string;
  process: string;
  created_at: number;
  updated_at: number;
}

export interface FailureMode {
  id: string;
  doc_id: string;
  process_step: string;
  failure_mode: string;
  effect: string;
  severity: number;      // 1-10
  cause: string;
  occurrence: number;    // 1-10
  detection_method: string;
  detection: number;     // 1-10
  rpn: number;           // S × O × D
  action_priority: ActionPriority;
  current_controls: string;
  created_at: number;
}

export interface ActionItem {
  id: string;
  failure_mode_id: string;
  doc_id: string;
  action: string;
  owner: string;
  deadline: string;
  status: ActionStatus;
  rpn_before: number;
  rpn_after: number | null;
  severity_after: number | null;
  occurrence_after: number | null;
  detection_after: number | null;
  completed_at: number | null;
  created_at: number;
}

export type ActionStatus = 'open' | 'in_progress' | 'completed' | 'verified';
export type ActionPriority = 'H' | 'M' | 'L';

export interface RiskMatrixCell {
  severity: number;
  occurrence: number;
  count: number;
  failure_modes: string[];
}

// ── Database ─────────────────────────────────────────────────

export async function initFmeaTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('fmea_documents'))) {
    await db.schema.createTable('fmea_documents', (t) => {
      t.text('id').primary();
      t.text('name').notNullable();
      t.text('fmea_type').notNullable().defaultTo('pfmea');
      t.text('product').notNullable().defaultTo('');
      t.text('process').notNullable().defaultTo('');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  if (!(await db.schema.hasTable('fmea_failure_modes'))) {
    await db.schema.createTable('fmea_failure_modes', (t) => {
      t.text('id').primary();
      t.text('doc_id').notNullable().references('id').inTable('fmea_documents').onDelete('CASCADE');
      t.text('process_step').notNullable();
      t.text('failure_mode').notNullable();
      t.text('effect').notNullable().defaultTo('');
      t.integer('severity').notNullable().defaultTo(5);
      t.text('cause').notNullable().defaultTo('');
      t.integer('occurrence').notNullable().defaultTo(5);
      t.text('detection_method').notNullable().defaultTo('');
      t.integer('detection').notNullable().defaultTo(5);
      t.integer('rpn').notNullable().defaultTo(125);
      t.text('action_priority').notNullable().defaultTo('M');
      t.text('current_controls').notNullable().defaultTo('');
      t.integer('created_at').notNullable();
    });
    await db.schema.raw('CREATE INDEX IF NOT EXISTS idx_fmea_fm_doc ON fmea_failure_modes(doc_id)');
  }

  if (!(await db.schema.hasTable('fmea_action_items'))) {
    await db.schema.createTable('fmea_action_items', (t) => {
      t.text('id').primary();
      t.text('failure_mode_id').notNullable().references('id').inTable('fmea_failure_modes').onDelete('CASCADE');
      t.text('doc_id').notNullable().references('id').inTable('fmea_documents').onDelete('CASCADE');
      t.text('action').notNullable();
      t.text('owner').notNullable().defaultTo('');
      t.text('deadline').notNullable().defaultTo('');
      t.text('status').notNullable().defaultTo('open');
      t.integer('rpn_before').notNullable();
      t.integer('rpn_after');
      t.integer('severity_after');
      t.integer('occurrence_after');
      t.integer('detection_after');
      t.integer('completed_at');
      t.integer('created_at').notNullable();
    });
    await db.schema.raw('CREATE INDEX IF NOT EXISTS idx_fmea_actions_doc ON fmea_action_items(doc_id)');
    await db.schema.raw('CREATE INDEX IF NOT EXISTS idx_fmea_actions_fm ON fmea_action_items(failure_mode_id)');
  }
}

export const fmeaTableInit: TableInitializer = { name: 'fmea', initTables: initFmeaTables };

function genId(): string {
  return randomBytes(16).toString('hex');
}

// ── CRUD ─────────────────────────────────────────────────────

export async function createFmeaDoc(
  name: string, fmeaType: FmeaType = 'pfmea', product: string = '', process: string = '',
): Promise<FmeaDocument> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('fmea_documents').insert({
    id, name, fmea_type: fmeaType, product, process, created_at: now, updated_at: now,
  });
  return { id, name, fmea_type: fmeaType, product, process, created_at: now, updated_at: now };
}

export async function getFmeaDocByName(name: string): Promise<FmeaDocument | undefined> {
  return await getKnex()('fmea_documents').whereRaw('LOWER(name) = LOWER(?)', [name]).first() as FmeaDocument | undefined;
}

export async function listFmeaDocs(): Promise<FmeaDocument[]> {
  return await getKnex()('fmea_documents').orderBy('updated_at', 'desc') as FmeaDocument[];
}

export async function deleteFmeaDoc(id: string): Promise<boolean> {
  const count = await getKnex()('fmea_documents').where({ id }).del();
  return count > 0;
}

export async function addFailureMode(
  docId: string,
  fm: {
    process_step: string;
    failure_mode: string;
    effect?: string;
    severity?: number;
    cause?: string;
    occurrence?: number;
    detection_method?: string;
    detection?: number;
    current_controls?: string;
  },
): Promise<FailureMode> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();

  const severity = clamp(fm.severity ?? 5, 1, 10);
  const occurrence = clamp(fm.occurrence ?? 5, 1, 10);
  const detection = clamp(fm.detection ?? 5, 1, 10);
  const { rpn, actionPriority: ap } = calculateFmeaMetrics(
    { severity, occurrence, detection },
    {},
    'standard',
  ).value;

  await db('fmea_failure_modes').insert({
    id, doc_id: docId, process_step: fm.process_step, failure_mode: fm.failure_mode,
    effect: fm.effect || '', severity, cause: fm.cause || '', occurrence,
    detection_method: fm.detection_method || '', detection, rpn, action_priority: ap,
    current_controls: fm.current_controls || '', created_at: now,
  });
  await db('fmea_documents').where({ id: docId }).update({ updated_at: now });

  return {
    id, doc_id: docId, process_step: fm.process_step, failure_mode: fm.failure_mode,
    effect: fm.effect || '', severity, cause: fm.cause || '', occurrence,
    detection_method: fm.detection_method || '', detection, rpn, action_priority: ap,
    current_controls: fm.current_controls || '', created_at: now,
  };
}

export async function getFailureModes(docId: string): Promise<FailureMode[]> {
  return await getKnex()('fmea_failure_modes')
    .where({ doc_id: docId }).orderBy('rpn', 'desc') as FailureMode[];
}

export async function addAction(
  fmId: string, docId: string,
  action: string, owner: string = '', deadline: string = '', rpnBefore: number,
): Promise<ActionItem> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('fmea_action_items').insert({
    id, failure_mode_id: fmId, doc_id: docId, action, owner, deadline,
    status: 'open', rpn_before: rpnBefore, created_at: now,
  });
  await db('fmea_documents').where({ id: docId }).update({ updated_at: now });

  return {
    id, failure_mode_id: fmId, doc_id: docId, action, owner, deadline,
    status: 'open', rpn_before: rpnBefore, rpn_after: null,
    severity_after: null, occurrence_after: null, detection_after: null,
    completed_at: null, created_at: now,
  };
}

export async function getActions(docId: string): Promise<ActionItem[]> {
  return await getKnex()('fmea_action_items')
    .where({ doc_id: docId }).orderBy('rpn_before', 'desc') as ActionItem[];
}

export async function getActionsForFailureMode(fmId: string): Promise<ActionItem[]> {
  return await getKnex()('fmea_action_items')
    .where({ failure_mode_id: fmId }).orderBy('created_at') as ActionItem[];
}

export async function completeAction(
  actionId: string,
  severityAfter: number, occurrenceAfter: number, detectionAfter: number,
): Promise<ActionItem | null> {
  const db = getKnex();
  const action = await db('fmea_action_items').where({ id: actionId }).first() as ActionItem | undefined;
  if (!action) return null;

  const s = clamp(severityAfter, 1, 10);
  const o = clamp(occurrenceAfter, 1, 10);
  const d = clamp(detectionAfter, 1, 10);
  const { rpn: rpnAfter, actionPriority: apAfter } = calculateFmeaMetrics(
    { severity: s, occurrence: o, detection: d },
    {},
    'standard',
  ).value;
  const now = Date.now();

  await db('fmea_action_items').where({ id: actionId }).update({
    status: 'completed', rpn_after: rpnAfter, severity_after: s,
    occurrence_after: o, detection_after: d, completed_at: now,
  });

  // Update the failure mode's RPN to the new values
  await db('fmea_failure_modes').where({ id: action.failure_mode_id }).update({
    severity: s, occurrence: o, detection: d, rpn: rpnAfter,
    action_priority: apAfter,
  });

  return {
    ...action, status: 'completed', rpn_after: rpnAfter,
    severity_after: s, occurrence_after: o, detection_after: d, completed_at: now,
  };
}

// ── AIAG-VDA Action Priority ─────────────────────────────────

/**
 * AIAG-VDA FMEA Action Priority (severity-first approach).
 * H (High): S ≥ 9, or (S ≥ 5 AND O ≥ 4 AND D ≥ 7), or RPN ≥ 200
 * M (Medium): S ≥ 5 AND (O ≥ 4 OR D ≥ 7), or RPN ≥ 80
 * L (Low): everything else
 * Exported for testing.
 */
export function calculateActionPriority(severity: number, occurrence: number, detection: number): ActionPriority {
  const rpn = severity * occurrence * detection;

  // High priority: safety/compliance critical OR high combined risk
  if (severity >= 9) return 'H';
  if (severity >= 5 && occurrence >= 4 && detection >= 7) return 'H';
  if (rpn >= 200) return 'H';

  // Medium priority
  if (severity >= 5 && (occurrence >= 4 || detection >= 7)) return 'M';
  if (rpn >= 80) return 'M';

  return 'L';
}

// ── Risk Matrix ──────────────────────────────────────────────

/**
 * Build a severity × occurrence risk matrix from failure modes.
 * Exported for testing.
 */
export function buildRiskMatrix(failureModes: FailureMode[]): RiskMatrixCell[] {
  const matrix = new Map<string, RiskMatrixCell>();

  for (const fm of failureModes) {
    const key = `${fm.severity}-${fm.occurrence}`;
    if (!matrix.has(key)) {
      matrix.set(key, { severity: fm.severity, occurrence: fm.occurrence, count: 0, failure_modes: [] });
    }
    const cell = matrix.get(key)!;
    cell.count++;
    cell.failure_modes.push(fm.failure_mode);
  }

  return [...matrix.values()].sort((a, b) => (b.severity * b.occurrence) - (a.severity * a.occurrence));
}

// ── CSV Parsing ──────────────────────────────────────────────

/**
 * Parse FMEA CSV into failure mode data.
 * Columns: process_step, failure_mode, effect, severity, cause, occurrence, detection_method, detection
 * Optional: current_controls
 * Exported for testing.
 */
export function parseFmeaCsv(csvContent: string): Array<{
  process_step: string;
  failure_mode: string;
  effect: string;
  severity: number;
  cause: string;
  occurrence: number;
  detection_method: string;
  detection: number;
  current_controls: string;
}> {
  const lines = csvContent.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header and at least one data row.');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const required = ['process_step', 'failure_mode'];
  for (const col of required) {
    if (!header.includes(col)) throw new Error(`CSV must have column "${col}". Found: ${header.join(', ')}`);
  }

  const idx = (col: string) => header.indexOf(col);
  const rows: Array<ReturnType<typeof parseFmeaCsv>[number]> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim());
    const step = cols[idx('process_step')];
    const mode = cols[idx('failure_mode')];
    if (!step || !mode) throw new Error(`Row ${i + 1}: process_step and failure_mode are required.`);

    const sevIdx = idx('severity');
    const occIdx = idx('occurrence');
    const detIdx = idx('detection');

    rows.push({
      process_step: step,
      failure_mode: mode,
      effect: cols[idx('effect')] || '',
      severity: sevIdx >= 0 && cols[sevIdx] ? parseInt(cols[sevIdx], 10) || 5 : 5,
      cause: cols[idx('cause')] || '',
      occurrence: occIdx >= 0 && cols[occIdx] ? parseInt(cols[occIdx], 10) || 5 : 5,
      detection_method: cols[idx('detection_method')] || '',
      detection: detIdx >= 0 && cols[detIdx] ? parseInt(cols[detIdx], 10) || 5 : 5,
      current_controls: cols[idx('current_controls')] || '',
    });
  }

  if (rows.length === 0) throw new Error('CSV contains no data rows.');
  return rows;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate risk matrix heatmap (severity × occurrence).
 * Exported for testing.
 */
export async function generateRiskHeatmap(failureModes: FailureMode[], docName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 600, height: 550, backgroundColour: 'white' });

  // Build 10×10 grid counts
  const grid: number[][] = Array(10).fill(null).map(() => Array(10).fill(0));
  for (const fm of failureModes) {
    grid[fm.severity - 1][fm.occurrence - 1]++;
  }

  // Scatter plot with bubble sizes
  const data: Array<{ x: number; y: number; r: number }> = [];
  const colors: string[] = [];
  for (let s = 0; s < 10; s++) {
    for (let o = 0; o < 10; o++) {
      if (grid[s][o] > 0) {
        data.push({ x: o + 1, y: s + 1, r: Math.min(grid[s][o] * 5 + 3, 20) });
        const risk = (s + 1) * (o + 1);
        colors.push(risk >= 40 ? '#e15759' : risk >= 15 ? '#f28e2b' : '#59a14f');
      }
    }
  }

  const config = {
    type: 'bubble' as const,
    data: {
      datasets: [{
        label: 'Failure Modes',
        data,
        backgroundColor: colors,
        borderColor: colors.map((c) => c === '#e15759' ? '#c94547' : c === '#f28e2b' ? '#d47a22' : '#4a8a42'),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`Risk Matrix: ${docName}`, `${failureModes.length} failure modes`],
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          title: { display: true, text: 'Occurrence (1-10)' },
          min: 0.5, max: 10.5, ticks: { stepSize: 1 },
        },
        y: {
          title: { display: true, text: 'Severity (1-10)' },
          min: 0.5, max: 10.5, ticks: { stepSize: 1 },
        },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `fmea-risk-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate RPN Pareto chart (top failure modes by RPN).
 * Exported for testing.
 */
export async function generateRpnPareto(failureModes: FailureMode[], docName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const sorted = [...failureModes].sort((a, b) => b.rpn - a.rpn).slice(0, 15);
  const totalRpn = sorted.reduce((s, fm) => s + fm.rpn, 0);

  const labels = sorted.map((fm) => fm.failure_mode.length > 20 ? fm.failure_mode.substring(0, 18) + '...' : fm.failure_mode);
  const rpns = sorted.map((fm) => fm.rpn);
  const cumPct: number[] = [];
  let cum = 0;
  for (const r of rpns) { cum += r; cumPct.push(Math.round(cum / totalRpn * 10000) / 100); }

  const colors = rpns.map((r) => r >= 200 ? '#e15759' : r >= 80 ? '#f28e2b' : '#59a14f');

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(700, sorted.length * 60),
    height: 450, backgroundColour: 'white',
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        { type: 'bar' as const, label: 'RPN', data: rpns, backgroundColor: colors, yAxisID: 'y', order: 2 },
        {
          type: 'line' as const, label: 'Cumulative %', data: cumPct,
          borderColor: '#333', backgroundColor: 'transparent', pointRadius: 2, borderWidth: 2,
          yAxisID: 'y1', order: 1,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`RPN Pareto: ${docName}`, `Top ${sorted.length} failure modes`],
          font: { size: 14 },
        },
        legend: { position: 'bottom' as const, labels: { font: { size: 10 } } },
      },
      scales: {
        y: { title: { display: true, text: 'RPN' }, min: 0 },
        y1: { position: 'right' as const, title: { display: true, text: 'Cumulative %' }, min: 0, max: 100, grid: { drawOnChartArea: false } },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `fmea-pareto-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate RPN reduction trend chart (before vs after actions).
 * Exported for testing.
 */
export async function generateRpnTrend(actions: ActionItem[], docName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400, backgroundColour: 'white' });

  const completed = actions.filter((a) => a.status === 'completed' && a.rpn_after !== null);
  if (completed.length === 0) throw new Error('No completed actions to chart.');

  const labels = completed.map((_, i) => `Action ${i + 1}`);
  const before = completed.map((a) => a.rpn_before);
  const after = completed.map((a) => a.rpn_after!);

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        { label: 'RPN Before', data: before, backgroundColor: '#e15759' },
        { label: 'RPN After', data: after, backgroundColor: '#59a14f' },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`RPN Reduction: ${docName}`, `${completed.length} actions completed`],
          font: { size: 14 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        y: { title: { display: true, text: 'RPN' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filePath = resolve(STORE_DIR, `fmea-trend-${Date.now()}.png`);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format FMEA worksheet for display.
 * Exported for testing.
 */
export function formatFmeaWorksheet(
  doc: FmeaDocument, failureModes: FailureMode[], actions: ActionItem[], html: boolean = true,
): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  lines.push(`${b}FMEA: ${doc.name}${bEnd} (${doc.fmea_type.toUpperCase()})`);
  if (doc.product) lines.push(`${b}Product:${bEnd} ${doc.product}`);
  if (doc.process) lines.push(`${b}Process:${bEnd} ${doc.process}`);
  lines.push('');

  // Summary
  const highCount = failureModes.filter((fm) => fm.action_priority === 'H').length;
  const medCount = failureModes.filter((fm) => fm.action_priority === 'M').length;
  const lowCount = failureModes.filter((fm) => fm.action_priority === 'L').length;
  const openActions = actions.filter((a) => a.status === 'open' || a.status === 'in_progress').length;
  lines.push(`${b}Risk:${bEnd} ${highCount} HIGH | ${medCount} MED | ${lowCount} LOW`);
  lines.push(`${b}Actions:${bEnd} ${actions.length} total, ${openActions} open`);
  lines.push('');

  // Failure modes sorted by RPN
  if (failureModes.length > 0) {
    lines.push(`${b}Failure Modes (by RPN):${bEnd}`);
    lines.push('');

    for (const fm of failureModes) {
      const apTag = fm.action_priority === 'H' ? 'HIGH' : fm.action_priority === 'M' ? 'MED' : 'LOW';
      lines.push(`${b}${fm.process_step}${bEnd} → ${fm.failure_mode} [${apTag}]`);
      lines.push(`  RPN=${fm.rpn} (S=${fm.severity} O=${fm.occurrence} D=${fm.detection})`);
      if (fm.effect) lines.push(`  Effect: ${fm.effect}`);
      if (fm.cause) lines.push(`  Cause: ${fm.cause}`);
      if (fm.detection_method) lines.push(`  Detection: ${fm.detection_method}`);
      if (fm.current_controls) lines.push(`  Controls: ${fm.current_controls}`);

      // Show actions for this FM
      const fmActions = actions.filter((a) => a.failure_mode_id === fm.id);
      if (fmActions.length > 0) {
        for (const a of fmActions) {
          const statusIcon = a.status === 'completed' ? 'Done' : a.status === 'in_progress' ? 'WIP' : 'Open';
          let actionLine = `  → [${statusIcon}] ${a.action}`;
          if (a.owner) actionLine += ` (${a.owner})`;
          if (a.deadline) actionLine += ` due: ${a.deadline}`;
          if (a.rpn_after !== null) actionLine += ` | RPN: ${a.rpn_before}→${a.rpn_after}`;
          lines.push(actionLine);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Export FMEA as CSV.
 * Exported for testing.
 */
export function exportFmeaCsv(doc: FmeaDocument, failureModes: FailureMode[], actions: ActionItem[]): string {
  const lines: string[] = [
    'Process Step,Failure Mode,Effect,Severity,Cause,Occurrence,Detection Method,Detection,RPN,Action Priority,Current Controls,Recommended Action,Owner,Deadline,Status,RPN After',
  ];

  for (const fm of failureModes) {
    const fmActions = actions.filter((a) => a.failure_mode_id === fm.id);

    if (fmActions.length === 0) {
      lines.push([
        csvEsc(fm.process_step), csvEsc(fm.failure_mode), csvEsc(fm.effect),
        fm.severity, csvEsc(fm.cause), fm.occurrence, csvEsc(fm.detection_method),
        fm.detection, fm.rpn, fm.action_priority, csvEsc(fm.current_controls),
        '', '', '', '', '',
      ].join(','));
    } else {
      for (const a of fmActions) {
        lines.push([
          csvEsc(fm.process_step), csvEsc(fm.failure_mode), csvEsc(fm.effect),
          fm.severity, csvEsc(fm.cause), fm.occurrence, csvEsc(fm.detection_method),
          fm.detection, fm.rpn, fm.action_priority, csvEsc(fm.current_controls),
          csvEsc(a.action), csvEsc(a.owner), a.deadline, a.status, a.rpn_after ?? '',
        ].join(','));
      }
    }
  }

  return lines.join('\n');
}

// ── Full Pipeline ────────────────────────────────────────────

/**
 * Execute full FMEA from CSV: parse, create doc, add failure modes, auto-generate actions for HIGH.
 */
export async function executeFmeaFromCsv(
  csvContent: string, docName: string,
  fmeaType: FmeaType = 'pfmea', product: string = '', process: string = '',
): Promise<{ doc: FmeaDocument; failureModes: FailureMode[]; actions: ActionItem[] }> {
  const rows = parseFmeaCsv(csvContent);

  // Reuse or create doc
  let doc = await getFmeaDocByName(docName);
  if (doc) {
    const db = getKnex();
    await db('fmea_failure_modes').where({ doc_id: doc.id }).del();
    await db('fmea_action_items').where({ doc_id: doc.id }).del();
    await db('fmea_documents').where({ id: doc.id }).update({
      updated_at: Date.now(), fmea_type: fmeaType, product, process,
    });
  } else {
    doc = await createFmeaDoc(docName, fmeaType, product, process);
  }

  const failureModes: FailureMode[] = [];
  const actions: ActionItem[] = [];

  for (const row of rows) {
    const fm = await addFailureMode(doc.id, row);
    failureModes.push(fm);

    // Auto-generate action items for HIGH priority
    if (fm.action_priority === 'H') {
      const action = await addAction(fm.id, doc.id,
        `Investigate and reduce risk for: ${fm.failure_mode}`, '', '', fm.rpn);
      actions.push(action);
    }
  }

  logger.info(
    { docName, failureModes: failureModes.length, highRisk: failureModes.filter((f) => f.action_priority === 'H').length },
    'FMEA analysis completed',
  );

  return { doc, failureModes, actions };
}

// ── Helpers ──────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max);
}

function csvEsc(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
