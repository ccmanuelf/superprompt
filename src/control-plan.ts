import { randomBytes } from 'node:crypto';
import { getDatabase } from './db.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export interface VocItem {
  id: string;
  plan_id: string;
  requirement: string;
  category: VocCategory;
  priority: number; // 1-5
}

export type VocCategory = 'appearance' | 'dimensions' | 'function' | 'reliability' | 'compliance' | 'other';

export interface CtqItem {
  id: string;
  plan_id: string;
  voc_id: string;
  ctq_name: string;
  measurement_method: string;
  unit: string;
  usl: number | null;
  lsl: number | null;
  target: number | null;
  severity: number;    // 1-10
  occurrence: number;  // 1-10
  detection: number;   // 1-10
  rpn: number;         // severity × occurrence × detection
  chart_type: ChartRecommendation;
  sampling_strategy: string;
  reaction_plan: string;
}

export type ChartRecommendation = 'xbar_r' | 'i_mr' | 'p' | 'np' | 'c' | 'u' | 'none';

export interface ControlPlan {
  id: string;
  name: string;
  process_type: ProcessType;
  product: string;
  applicable_standard: string;
  created_at: number;
  updated_at: number;
}

export type ProcessType = 'manual' | 'semi_automated' | 'automated' | 'continuous';

export interface ControlPlanSummary {
  plan: ControlPlan;
  voc_items: VocItem[];
  ctq_items: CtqItem[];
  risk_summary: { high: number; medium: number; low: number };
  chart_recommendations: Record<ChartRecommendation, number>;
}

// ── Database ─────────────────────────────────────────────────

export function initControlPlanTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS control_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      process_type TEXT NOT NULL DEFAULT 'semi_automated',
      product TEXT NOT NULL DEFAULT '',
      applicable_standard TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voc_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      requirement TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      priority INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES control_plans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ctq_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      voc_id TEXT NOT NULL,
      ctq_name TEXT NOT NULL,
      measurement_method TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      usl REAL,
      lsl REAL,
      target REAL,
      severity INTEGER NOT NULL DEFAULT 5,
      occurrence INTEGER NOT NULL DEFAULT 5,
      detection INTEGER NOT NULL DEFAULT 5,
      rpn INTEGER NOT NULL DEFAULT 125,
      chart_type TEXT NOT NULL DEFAULT 'i_mr',
      sampling_strategy TEXT NOT NULL DEFAULT '',
      reaction_plan TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES control_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (voc_id) REFERENCES voc_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_voc_plan ON voc_items(plan_id);
    CREATE INDEX IF NOT EXISTS idx_ctq_plan ON ctq_items(plan_id);
  `);
}

function genId(): string {
  return randomBytes(16).toString('hex');
}

// ── CRUD ─────────────────────────────────────────────────────

export function createControlPlan(
  name: string, processType: ProcessType = 'semi_automated',
  product: string = '', standard: string = '',
): ControlPlan {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO control_plans (id, name, process_type, product, applicable_standard, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, processType, product, standard, now, now);
  return { id, name, process_type: processType, product, applicable_standard: standard, created_at: now, updated_at: now };
}

export function getControlPlanByName(name: string): ControlPlan | undefined {
  return getDatabase().prepare('SELECT * FROM control_plans WHERE name = ? COLLATE NOCASE').get(name) as ControlPlan | undefined;
}

export function listControlPlans(): ControlPlan[] {
  return getDatabase().prepare('SELECT * FROM control_plans ORDER BY updated_at DESC').all() as ControlPlan[];
}

export function deleteControlPlan(id: string): boolean {
  return getDatabase().prepare('DELETE FROM control_plans WHERE id = ?').run(id).changes > 0;
}

export function addVocItem(planId: string, requirement: string, category: VocCategory = 'other', priority: number = 3): VocItem {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO voc_items (id, plan_id, requirement, category, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, planId, requirement, category, Math.min(Math.max(priority, 1), 5), now);
  db.prepare('UPDATE control_plans SET updated_at = ? WHERE id = ?').run(now, planId);
  return { id, plan_id: planId, requirement, category, priority };
}

export function getVocItems(planId: string): VocItem[] {
  return getDatabase().prepare('SELECT * FROM voc_items WHERE plan_id = ? ORDER BY priority DESC').all(planId) as VocItem[];
}

export function addCtqItem(planId: string, vocId: string, ctq: Partial<CtqItem>): CtqItem {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();

  const severity = clamp(ctq.severity ?? 5, 1, 10);
  const occurrence = clamp(ctq.occurrence ?? 5, 1, 10);
  const detection = clamp(ctq.detection ?? 5, 1, 10);
  const rpn = severity * occurrence * detection;

  const chartType = ctq.chart_type || recommendChartType(ctq.usl, ctq.lsl);
  const sampling = ctq.sampling_strategy || '';
  const reaction = ctq.reaction_plan || '';

  db.prepare(
    `INSERT INTO ctq_items (id, plan_id, voc_id, ctq_name, measurement_method, unit, usl, lsl, target, severity, occurrence, detection, rpn, chart_type, sampling_strategy, reaction_plan, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, planId, vocId, ctq.ctq_name || '', ctq.measurement_method || '', ctq.unit || '',
    ctq.usl ?? null, ctq.lsl ?? null, ctq.target ?? null,
    severity, occurrence, detection, rpn, chartType, sampling, reaction, now);
  db.prepare('UPDATE control_plans SET updated_at = ? WHERE id = ?').run(now, planId);

  return {
    id, plan_id: planId, voc_id: vocId,
    ctq_name: ctq.ctq_name || '', measurement_method: ctq.measurement_method || '',
    unit: ctq.unit || '', usl: ctq.usl ?? null, lsl: ctq.lsl ?? null, target: ctq.target ?? null,
    severity, occurrence, detection, rpn,
    chart_type: chartType, sampling_strategy: sampling, reaction_plan: reaction,
  };
}

export function getCtqItems(planId: string): CtqItem[] {
  return getDatabase().prepare('SELECT * FROM ctq_items WHERE plan_id = ? ORDER BY rpn DESC').all(planId) as CtqItem[];
}

// ── Recommendations Engine ───────────────────────────────────

/**
 * Recommend chart type based on data characteristics.
 * Variables data (has spec limits) → I-MR or X-bar/R.
 * Attribute data (no spec limits or count-based) → p or c chart.
 * Exported for testing.
 */
export function recommendChartType(usl?: number | null, lsl?: number | null): ChartRecommendation {
  if (usl !== null && usl !== undefined && lsl !== null && lsl !== undefined) {
    return 'xbar_r'; // variables data with spec limits → X-bar/R
  }
  return 'p'; // default to attribute chart
}

/**
 * Recommend sampling strategy based on process type.
 * Exported for testing.
 */
export function recommendSampling(processType: ProcessType, rpn: number): string {
  if (processType === 'automated' || processType === 'continuous') {
    if (rpn >= 200) return '100% inline inspection (SPI/AOI/automated gauge)';
    if (rpn >= 100) return 'Continuous SPC with n=5 subgroups every 30 min';
    return 'SPC with n=5 subgroups every 2 hours';
  }

  if (processType === 'semi_automated') {
    if (rpn >= 200) return 'First-piece + every 50 units (n=5 subgroup)';
    if (rpn >= 100) return 'Every 100 units (n=5 subgroup) + shift start/end';
    return 'Every 200 units (n=3 subgroup) or hourly';
  }

  // Manual / labor-intensive
  if (rpn >= 200) return 'Every unit inspected (100% inspection)';
  if (rpn >= 100) return 'Every 25 units or per operator changeover (n=3)';
  return 'Random sampling per AQL plan (Level II, AQL=1.0)';
}

/**
 * Generate a default reaction plan based on severity and chart type.
 * Exported for testing.
 */
export function recommendReaction(severity: number, chartType: ChartRecommendation): string {
  const actions: string[] = [];

  // Immediate containment
  if (severity >= 8) {
    actions.push('STOP production immediately.');
    actions.push('Quarantine last lot since last known good check.');
    actions.push('Notify Quality Manager and line supervisor.');
  } else if (severity >= 5) {
    actions.push('Alert operator — investigate root cause.');
    actions.push('Increase sampling frequency to 100% until stable.');
  } else {
    actions.push('Log deviation. Continue production with monitoring.');
  }

  // Chart-specific
  if (chartType === 'xbar_r' || chartType === 'i_mr') {
    actions.push('Check for tool wear, material change, or setup drift.');
    actions.push('Verify measurement system (gauge R&R).');
  } else {
    actions.push('Run Pareto on recent defects to identify dominant failure mode.');
  }

  actions.push('Document findings in CAPA log.');
  return actions.join(' ');
}

/**
 * Suggest applicable standard based on product/process keywords.
 * Exported for testing.
 */
export function suggestStandard(product: string, processType: ProcessType): string {
  const p = product.toLowerCase();

  if (p.includes('harness') || p.includes('wire') || p.includes('cable')) return 'IPC/WHMA-A-620';
  if (p.includes('pcb') || p.includes('smt') || p.includes('solder') || p.includes('electronic')) return 'IPC-A-610';
  if (p.includes('apparel') || p.includes('garment') || p.includes('sew') || p.includes('textile')) return 'AQL per buyer spec (typically ANSI/ASQ Z1.4)';
  if (p.includes('appliance') || p.includes('electrical')) return 'UL/IEC 60335 (safety), brand retailer spec';
  if (p.includes('automotive') || p.includes('vehicle')) return 'IATF 16949 / AIAG APQP';
  if (p.includes('medical') || p.includes('device')) return 'ISO 13485';
  if (p.includes('aerospace') || p.includes('aviation')) return 'AS9100';
  if (p.includes('food') || p.includes('beverage')) return 'FSSC 22000 / HACCP';

  return '';
}

// ── Control Plan Summary ─────────────────────────────────────

/**
 * Build a complete control plan summary with risk analysis.
 * Exported for testing.
 */
export function buildControlPlanSummary(planId: string): ControlPlanSummary {
  const db = getDatabase();
  const plan = db.prepare('SELECT * FROM control_plans WHERE id = ?').get(planId) as ControlPlan;
  if (!plan) throw new Error('Control plan not found.');

  const vocItems = getVocItems(planId);
  const ctqItems = getCtqItems(planId);

  // Risk summary
  let high = 0, medium = 0, low = 0;
  for (const ctq of ctqItems) {
    if (ctq.rpn >= 200) high++;
    else if (ctq.rpn >= 80) medium++;
    else low++;
  }

  // Chart recommendations tally
  const chartRecs: Record<ChartRecommendation, number> = {
    xbar_r: 0, i_mr: 0, p: 0, np: 0, c: 0, u: 0, none: 0,
  };
  for (const ctq of ctqItems) {
    chartRecs[ctq.chart_type]++;
  }

  return {
    plan,
    voc_items: vocItems,
    ctq_items: ctqItems,
    risk_summary: { high, medium, low },
    chart_recommendations: chartRecs,
  };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format control plan for display.
 * Exported for testing.
 */
export function formatControlPlan(summary: ControlPlanSummary, html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  lines.push(`${b}Control Plan: ${summary.plan.name}${bEnd}`);
  if (summary.plan.product) lines.push(`${b}Product:${bEnd} ${summary.plan.product}`);
  lines.push(`${b}Process Type:${bEnd} ${summary.plan.process_type.replace('_', '-')}`);
  if (summary.plan.applicable_standard) lines.push(`${b}Standard:${bEnd} ${summary.plan.applicable_standard}`);
  lines.push('');

  // Risk summary
  lines.push(`${b}Risk Summary:${bEnd} ${summary.risk_summary.high} HIGH | ${summary.risk_summary.medium} MEDIUM | ${summary.risk_summary.low} LOW`);
  lines.push(`${b}VOC Items:${bEnd} ${summary.voc_items.length} | ${b}CTQs:${bEnd} ${summary.ctq_items.length}`);
  lines.push('');

  // CTQs ordered by RPN
  if (summary.ctq_items.length > 0) {
    lines.push(`${b}Critical-to-Quality Characteristics (by RPN):${bEnd}`);
    lines.push('');

    for (const ctq of summary.ctq_items) {
      const riskTag = ctq.rpn >= 200 ? 'HIGH' : ctq.rpn >= 80 ? 'MED' : 'LOW';
      lines.push(`${b}${ctq.ctq_name}${bEnd} [RPN=${ctq.rpn} ${riskTag}]`);

      const specParts: string[] = [];
      if (ctq.lsl !== null) specParts.push(`LSL=${ctq.lsl}`);
      if (ctq.target !== null) specParts.push(`Target=${ctq.target}`);
      if (ctq.usl !== null) specParts.push(`USL=${ctq.usl}`);
      if (specParts.length > 0) lines.push(`  Spec: ${specParts.join(' | ')}${ctq.unit ? ' ' + ctq.unit : ''}`);

      lines.push(`  S=${ctq.severity} O=${ctq.occurrence} D=${ctq.detection}`);
      if (ctq.measurement_method) lines.push(`  Measurement: ${ctq.measurement_method}`);
      lines.push(`  Chart: ${ctq.chart_type.replace('_', '-')}`);
      if (ctq.sampling_strategy) lines.push(`  Sampling: ${ctq.sampling_strategy}`);
      if (ctq.reaction_plan) lines.push(`  Reaction: ${ctq.reaction_plan.substring(0, 120)}${ctq.reaction_plan.length > 120 ? '...' : ''}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Export control plan as CSV string.
 * Exported for testing.
 */
export function exportControlPlanCsv(summary: ControlPlanSummary): string {
  const lines: string[] = [
    'CTQ Name,VOC Requirement,Spec (LSL),Spec (Target),Spec (USL),Unit,Severity,Occurrence,Detection,RPN,Chart Type,Measurement Method,Sampling Strategy,Reaction Plan',
  ];

  const vocMap = new Map(summary.voc_items.map((v) => [v.id, v.requirement]));

  for (const ctq of summary.ctq_items) {
    const voc = vocMap.get(ctq.voc_id) || '';
    lines.push([
      csvEscape(ctq.ctq_name),
      csvEscape(voc),
      ctq.lsl ?? '',
      ctq.target ?? '',
      ctq.usl ?? '',
      ctq.unit,
      ctq.severity,
      ctq.occurrence,
      ctq.detection,
      ctq.rpn,
      ctq.chart_type,
      csvEscape(ctq.measurement_method),
      csvEscape(ctq.sampling_strategy),
      csvEscape(ctq.reaction_plan),
    ].join(','));
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max);
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
