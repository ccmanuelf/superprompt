import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDatabase } from './db.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// ── Types ────────────────────────────────────────────────────

export interface MeasurementRow {
  value: number;
  subgroup?: string;
  timestamp?: string;
  defect_type?: string;
}

export interface SpecLimits {
  usl: number;
  lsl: number;
  target?: number;
}

export interface CapabilityResult {
  mean: number;
  stddev: number;
  stddev_overall: number;
  cp: number;
  cpk: number;
  pp: number;
  ppk: number;
  cpm: number | null; // only when target provided
  within_spec_pct: number;
  sample_size: number;
  interpretation: string;
}

export interface DpmoResult {
  defects: number;
  units: number;
  opportunities: number;
  dpmo: number;
  sigma_level: number;
  yield_pct: number;
}

export interface ControlChartData {
  chart_type: 'xbar_r' | 'xbar_s' | 'i_mr';
  values: number[];
  center_line: number;
  ucl: number;
  lcl: number;
  range_values?: number[];
  range_cl?: number;
  range_ucl?: number;
  range_lcl?: number;
  violations: ControlViolation[];
}

export interface ControlViolation {
  index: number;
  value: number;
  rule: string;
  description: string;
}

export interface ParetoItem {
  category: string;
  count: number;
  cumulative_pct: number;
}

export interface SigmaProject {
  id: string;
  name: string;
  description: string;
  usl: number;
  lsl: number;
  target: number | null;
  created_at: number;
  updated_at: number;
}

export interface SigmaResultRow {
  id: string;
  project_id: string;
  result_type: string;
  result_json: string;
  created_at: number;
}

// ── Database ─────────────────────────────────────────────────

export function initSigmaTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sigma_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      usl REAL NOT NULL,
      lsl REAL NOT NULL,
      target REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sigma_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      value REAL NOT NULL,
      subgroup TEXT,
      timestamp TEXT,
      defect_type TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES sigma_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sigma_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      result_type TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES sigma_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sigma_measurements_project
      ON sigma_measurements(project_id);

    CREATE INDEX IF NOT EXISTS idx_sigma_results_project
      ON sigma_results(project_id);
  `);
}

function genId(): string {
  return randomBytes(16).toString('hex');
}

export function createSigmaProject(
  name: string, usl: number, lsl: number, target?: number, description: string = '',
): SigmaProject {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sigma_projects (id, name, description, usl, lsl, target, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, description, usl, lsl, target ?? null, now, now);
  return { id, name, description, usl, lsl, target: target ?? null, created_at: now, updated_at: now };
}

export function getSigmaProject(id: string): SigmaProject | undefined {
  return getDatabase().prepare('SELECT * FROM sigma_projects WHERE id = ?').get(id) as SigmaProject | undefined;
}

export function getSigmaProjectByName(name: string): SigmaProject | undefined {
  return getDatabase().prepare('SELECT * FROM sigma_projects WHERE name = ? COLLATE NOCASE').get(name) as SigmaProject | undefined;
}

export function listSigmaProjects(): SigmaProject[] {
  return getDatabase().prepare('SELECT * FROM sigma_projects ORDER BY updated_at DESC').all() as SigmaProject[];
}

export function deleteSigmaProject(id: string): boolean {
  return getDatabase().prepare('DELETE FROM sigma_projects WHERE id = ?').run(id).changes > 0;
}

export function insertMeasurements(projectId: string, rows: MeasurementRow[]): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO sigma_measurements (project_id, value, subgroup, timestamp, defect_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(projectId, r.value, r.subgroup ?? null, r.timestamp ?? null, r.defect_type ?? null, now);
    }
  });
  tx();
}

export function getMeasurements(projectId: string): MeasurementRow[] {
  const rows = getDatabase().prepare(
    'SELECT value, subgroup, timestamp, defect_type FROM sigma_measurements WHERE project_id = ? ORDER BY id',
  ).all(projectId) as Array<{ value: number; subgroup: string | null; timestamp: string | null; defect_type: string | null }>;

  return rows.map((r) => ({
    value: r.value,
    subgroup: r.subgroup ?? undefined,
    timestamp: r.timestamp ?? undefined,
    defect_type: r.defect_type ?? undefined,
  }));
}

export function saveSigmaResult(projectId: string, resultType: string, data: unknown): string {
  const db = getDatabase();
  const id = genId();
  db.prepare(
    `INSERT INTO sigma_results (id, project_id, result_type, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, projectId, resultType, JSON.stringify(data), Date.now());
  db.prepare('UPDATE sigma_projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId);
  return id;
}

export function getSigmaResults(projectId: string): SigmaResultRow[] {
  return getDatabase().prepare(
    'SELECT * FROM sigma_results WHERE project_id = ? ORDER BY created_at DESC',
  ).all(projectId) as SigmaResultRow[];
}

// ── CSV Parsing ──────────────────────────────────────────────

/**
 * Parse sigma measurement CSV.
 * Required column: value
 * Optional columns: subgroup, timestamp, defect_type
 * Exported for testing.
 */
export function parseSigmaCsv(csvContent: string): MeasurementRow[] {
  const lines = csvContent.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const idxValue = header.indexOf('value');
  if (idxValue < 0) throw new Error('CSV must have a "value" column. Found: ' + header.join(', '));

  const idxSubgroup = header.indexOf('subgroup');
  const idxTimestamp = header.indexOf('timestamp');
  const idxDefect = header.indexOf('defect_type');

  const rows: MeasurementRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim());
    const valStr = cols[idxValue];
    if (!valStr) continue;

    const value = parseFloat(valStr);
    if (isNaN(value)) throw new Error(`Row ${i + 1}: value must be a number, got "${valStr}".`);

    rows.push({
      value,
      subgroup: idxSubgroup >= 0 ? cols[idxSubgroup] || undefined : undefined,
      timestamp: idxTimestamp >= 0 ? cols[idxTimestamp] || undefined : undefined,
      defect_type: idxDefect >= 0 ? cols[idxDefect] || undefined : undefined,
    });
  }

  if (rows.length === 0) throw new Error('CSV contains no data rows.');
  return rows;
}

// ── Statistical Functions ────────────────────────────────────

/** Calculate mean. Exported for testing. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Calculate sample standard deviation. Exported for testing. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Calculate within-subgroup standard deviation using average range method (R-bar/d2).
 * Groups measurements by subgroup, computes range of each, uses d2 constant.
 * Falls back to overall stddev if no subgroups.
 * Exported for testing.
 */
export function withinStddev(values: number[], subgroups?: string[]): number {
  if (!subgroups || subgroups.length === 0) return stddev(values);

  const groups = new Map<string, number[]>();
  for (let i = 0; i < values.length; i++) {
    const sg = subgroups[i] || 'default';
    if (!groups.has(sg)) groups.set(sg, []);
    groups.get(sg)!.push(values[i]);
  }

  const groupSizes = [...groups.values()].map((g) => g.length);
  const n = Math.round(mean(groupSizes));
  if (n < 2) return stddev(values);

  // d2 constants for subgroup sizes 2-10
  const d2Table: Record<number, number> = {
    2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326,
    6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078,
  };
  const d2 = d2Table[Math.min(n, 10)] || 3.078;

  // Average range
  const ranges: number[] = [];
  for (const [, vals] of groups) {
    if (vals.length >= 2) {
      ranges.push(Math.max(...vals) - Math.min(...vals));
    }
  }

  if (ranges.length === 0) return stddev(values);
  const rBar = mean(ranges);
  return rBar / d2;
}

// ── Capability Indices ───────────────────────────────────────

/**
 * Calculate process capability indices.
 * Cp/Cpk use within-subgroup variation (short-term capability).
 * Pp/Ppk use overall variation (long-term performance).
 * Exported for testing.
 */
export function calculateCapability(
  values: number[],
  spec: SpecLimits,
  subgroups?: string[],
): CapabilityResult {
  if (values.length < 2) throw new Error('Need at least 2 measurements for capability analysis.');
  if (spec.usl <= spec.lsl) throw new Error('USL must be greater than LSL.');

  const mu = mean(values);
  const sigmaWithin = withinStddev(values, subgroups);
  const sigmaOverall = stddev(values);

  // Guard against zero variation — cap indices rather than producing billions
  const zeroVariation = sigmaWithin === 0 && sigmaOverall === 0;
  const sw = sigmaWithin > 0 ? sigmaWithin : (spec.usl - spec.lsl) / 600; // fallback: assume 100 Cp
  const so = sigmaOverall > 0 ? sigmaOverall : (spec.usl - spec.lsl) / 600;

  // Cp/Cpk — short-term (within-subgroup)
  const cp = (spec.usl - spec.lsl) / (6 * sw);
  const cpu = (spec.usl - mu) / (3 * sw);
  const cpl = (mu - spec.lsl) / (3 * sw);
  const cpk = Math.min(cpu, cpl);

  // Pp/Ppk — long-term (overall)
  const pp = (spec.usl - spec.lsl) / (6 * so);
  const ppu = (spec.usl - mu) / (3 * so);
  const ppl = (mu - spec.lsl) / (3 * so);
  const ppk = Math.min(ppu, ppl);

  // Cpm — capability relative to target
  let cpm: number | null = null;
  if (spec.target !== undefined && spec.target !== null) {
    const sigmaT = Math.sqrt(
      values.reduce((s, v) => s + (v - spec.target!) ** 2, 0) / (values.length - 1),
    );
    cpm = sigmaT > 0 ? (spec.usl - spec.lsl) / (6 * sigmaT) : null;
  }

  // Within-spec percentage
  const withinSpec = values.filter((v) => v >= spec.lsl && v <= spec.usl).length;
  const withinSpecPct = (withinSpec / values.length) * 100;

  // Interpretation
  let interpretation = interpretCapability(cpk, ppk, withinSpecPct);
  if (zeroVariation) {
    interpretation = 'WARNING: Zero process variation detected — all measurements are identical. ' +
      'Capability indices are not meaningful. Verify measurement system resolution. ' + interpretation;
  }

  return {
    mean: round4(mu),
    stddev: round4(zeroVariation ? 0 : sw),
    stddev_overall: round4(zeroVariation ? 0 : so),
    cp: round4(cp),
    cpk: round4(cpk),
    pp: round4(pp),
    ppk: round4(ppk),
    cpm: cpm !== null ? round4(cpm) : null,
    within_spec_pct: round2(withinSpecPct),
    sample_size: values.length,
    interpretation,
  };
}

function interpretCapability(cpk: number, ppk: number, withinPct: number): string {
  const lines: string[] = [];

  if (cpk >= 2.0) lines.push('Cpk >= 2.0: World-class process (Six Sigma level).');
  else if (cpk >= 1.33) lines.push('Cpk >= 1.33: Capable process — meets typical manufacturing standards.');
  else if (cpk >= 1.0) lines.push('Cpk >= 1.0: Marginally capable — improvement recommended.');
  else lines.push(`Cpk = ${cpk.toFixed(2)}: NOT CAPABLE — immediate action required.`);

  if (Math.abs(cpk - ppk) > 0.3) {
    lines.push(`Cp/Pp gap: ${Math.abs(cpk - ppk).toFixed(2)} — significant shift/drift between short-term and long-term performance.`);
  }

  if (withinPct < 100) {
    lines.push(`${(100 - withinPct).toFixed(1)}% of measurements are out of spec.`);
  }

  return lines.join(' ');
}

// ── DPMO & Sigma Level ───────────────────────────────────────

/**
 * Calculate DPMO and sigma level.
 * Exported for testing.
 */
export function calculateDpmo(defects: number, units: number, opportunities: number): DpmoResult {
  if (units <= 0) throw new Error('Units must be positive.');
  if (opportunities <= 0) throw new Error('Opportunities must be positive.');
  if (defects < 0) throw new Error('Defects cannot be negative.');

  const dpmo = (defects / (units * opportunities)) * 1_000_000;
  const yieldPct = (1 - defects / (units * opportunities)) * 100;
  const sigmaLevel = dpmoToSigma(dpmo);

  return {
    defects,
    units,
    opportunities,
    dpmo: round2(dpmo),
    sigma_level: round2(sigmaLevel),
    yield_pct: round4(yieldPct),
  };
}

/**
 * Convert DPMO to sigma level using the inverse normal approximation.
 * σ = Φ⁻¹(1 - DPMO/1,000,000) + 1.5 (with 1.5σ shift)
 * Exported for testing.
 */
export function dpmoToSigma(dpmo: number): number {
  if (dpmo <= 0) return 6.0;
  if (dpmo >= 1_000_000) return 0;

  // Approximate inverse normal using rational approximation (Abramowitz & Stegun)
  const p = 1 - dpmo / 1_000_000;
  const z = inverseNormal(p);
  return z + 1.5; // 1.5σ shift convention
}

/**
 * Rolled throughput yield: product of individual step yields.
 * Exported for testing.
 */
export function rolledThroughputYield(stepYields: number[]): number {
  if (stepYields.length === 0) return 0;
  let rty = 1;
  for (const y of stepYields) {
    rty *= y / 100;
  }
  return round4(rty * 100);
}

/** Inverse normal (probit) approximation. Exported for testing. */
export function inverseNormal(p: number): number {
  if (p <= 0) return -6;
  if (p >= 1) return 6;

  // Rational approximation (Peter Acklam's algorithm)
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// ── Control Charts ───────────────────────────────────────────

/**
 * Generate I-MR (Individual - Moving Range) control chart data.
 * Used when subgroup size = 1.
 * Exported for testing.
 */
export function individualMR(values: number[]): ControlChartData {
  if (values.length < 2) throw new Error('Need at least 2 measurements for I-MR chart.');

  const mu = mean(values);

  // Moving ranges
  const mrs: number[] = [];
  for (let i = 1; i < values.length; i++) {
    mrs.push(Math.abs(values[i] - values[i - 1]));
  }
  const mrBar = mean(mrs);

  // d2 for n=2 subgroup (moving range)
  const d2 = 1.128;
  const D4 = 3.267;

  const sigmaEst = mrBar / d2;
  const ucl = mu + 3 * sigmaEst;
  const lcl = mu - 3 * sigmaEst;

  const rangeUcl = D4 * mrBar;

  // Detect violations (skip if zero variation — rules are meaningless)
  const violations: ControlViolation[] = [];
  if (sigmaEst > 0) {
    const detected = detectWesternElectricRules(values, mu, sigmaEst);
    for (const v of detected) violations.push(v);
  } else {
    violations.push({
      index: 0,
      value: mu,
      rule: 'Warning',
      description: 'Zero process variation — all moving ranges are zero. Check measurement resolution.',
    });
  }

  return {
    chart_type: 'i_mr',
    values,
    center_line: round4(mu),
    ucl: round4(ucl),
    lcl: round4(lcl),
    range_values: mrs,
    range_cl: round4(mrBar),
    range_ucl: round4(rangeUcl),
    range_lcl: 0,
    violations,
  };
}

/**
 * Generate X-bar/R control chart data.
 * Groups measurements by subgroup, computes subgroup means and ranges.
 * Exported for testing.
 */
export function xbarR(values: number[], subgroups: string[]): ControlChartData {
  // Group by subgroup
  const groups = new Map<string, number[]>();
  const groupOrder: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const sg = subgroups[i] || `sg${i}`;
    if (!groups.has(sg)) {
      groups.set(sg, []);
      groupOrder.push(sg);
    }
    groups.get(sg)!.push(values[i]);
  }

  if (groupOrder.length < 2) throw new Error('Need at least 2 subgroups for X-bar/R chart.');

  const subgroupMeans: number[] = [];
  const subgroupRanges: number[] = [];

  for (const sg of groupOrder) {
    const vals = groups.get(sg)!;
    subgroupMeans.push(mean(vals));
    subgroupRanges.push(Math.max(...vals) - Math.min(...vals));
  }

  const xBarBar = mean(subgroupMeans);
  const rBar = mean(subgroupRanges);

  const n = Math.round(mean([...groups.values()].map((g) => g.length)));

  // A2, D3, D4 constants for subgroup sizes
  const A2Table: Record<number, number> = {
    2: 1.880, 3: 1.023, 4: 0.729, 5: 0.577,
    6: 0.483, 7: 0.419, 8: 0.373, 9: 0.337, 10: 0.308,
  };
  const D3Table: Record<number, number> = {
    2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0.076, 8: 0.136, 9: 0.184, 10: 0.223,
  };
  const D4Table: Record<number, number> = {
    2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114,
    6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777,
  };

  const nClamped = Math.min(Math.max(n, 2), 10);
  const A2 = A2Table[nClamped];
  const D3 = D3Table[nClamped];
  const D4 = D4Table[nClamped];

  const ucl = xBarBar + A2 * rBar;
  const lcl = xBarBar - A2 * rBar;

  const d2Table: Record<number, number> = {
    2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326,
    6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078,
  };
  const d2 = d2Table[nClamped];
  const sigmaEst = rBar / d2;

  const violations = detectWesternElectricRules(subgroupMeans, xBarBar, sigmaEst);

  return {
    chart_type: 'xbar_r',
    values: subgroupMeans.map(round4),
    center_line: round4(xBarBar),
    ucl: round4(ucl),
    lcl: round4(lcl),
    range_values: subgroupRanges.map(round4),
    range_cl: round4(rBar),
    range_ucl: round4(D4 * rBar),
    range_lcl: round4(D3 * rBar),
    violations,
  };
}

// ── Western Electric Rules ───────────────────────────────────

/**
 * Detect Western Electric rules violations (all 8 rules).
 * Exported for testing.
 */
export function detectWesternElectricRules(
  values: number[],
  centerLine: number,
  sigma: number,
): ControlViolation[] {
  const violations: ControlViolation[] = [];
  if (sigma <= 0 || values.length < 2) return violations;

  const ucl = centerLine + 3 * sigma;
  const lcl = centerLine - 3 * sigma;
  const zone_a_upper = centerLine + 2 * sigma;
  const zone_a_lower = centerLine - 2 * sigma;
  const zone_b_upper = centerLine + 1 * sigma;
  const zone_b_lower = centerLine - 1 * sigma;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];

    // Rule 1: Single point beyond 3σ
    if (v > ucl || v < lcl) {
      violations.push({
        index: i, value: round4(v),
        rule: 'Rule 1', description: 'Point beyond 3σ control limit',
      });
    }

    // Rule 2: 9 consecutive points on same side of center
    if (i >= 8) {
      const window = values.slice(i - 8, i + 1);
      const allAbove = window.every((w) => w > centerLine);
      const allBelow = window.every((w) => w < centerLine);
      if (allAbove || allBelow) {
        // Only report on the 9th point
        const existsR2 = violations.some((v) => v.index === i && v.rule === 'Rule 2');
        if (!existsR2) {
          violations.push({
            index: i, value: round4(v),
            rule: 'Rule 2', description: '9 consecutive points on same side of center line',
          });
        }
      }
    }

    // Rule 3: 6 consecutive points steadily increasing or decreasing
    if (i >= 5) {
      const window = values.slice(i - 5, i + 1);
      let increasing = true;
      let decreasing = true;
      for (let j = 1; j < window.length; j++) {
        if (window[j] <= window[j - 1]) increasing = false;
        if (window[j] >= window[j - 1]) decreasing = false;
      }
      if (increasing || decreasing) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 3', description: `6 consecutive points ${increasing ? 'increasing' : 'decreasing'}`,
        });
      }
    }

    // Rule 4: 14 consecutive points alternating up and down
    if (i >= 13) {
      const window = values.slice(i - 13, i + 1);
      let alternating = true;
      for (let j = 2; j < window.length; j++) {
        const prev = window[j - 1] - window[j - 2];
        const curr = window[j] - window[j - 1];
        if (prev * curr >= 0) { alternating = false; break; }
      }
      if (alternating) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 4', description: '14 consecutive points alternating up and down',
        });
      }
    }

    // Rule 5: 2 out of 3 consecutive points beyond 2σ (same side)
    if (i >= 2) {
      const window = values.slice(i - 2, i + 1);
      const aboveA = window.filter((w) => w > zone_a_upper).length;
      const belowA = window.filter((w) => w < zone_a_lower).length;
      if (aboveA >= 2 || belowA >= 2) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 5', description: '2 of 3 consecutive points beyond 2σ (same side)',
        });
      }
    }

    // Rule 6: 4 out of 5 consecutive points beyond 1σ (same side)
    if (i >= 4) {
      const window = values.slice(i - 4, i + 1);
      const aboveB = window.filter((w) => w > zone_b_upper).length;
      const belowB = window.filter((w) => w < zone_b_lower).length;
      if (aboveB >= 4 || belowB >= 4) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 6', description: '4 of 5 consecutive points beyond 1σ (same side)',
        });
      }
    }

    // Rule 7: 15 consecutive points within 1σ (stratification)
    if (i >= 14) {
      const window = values.slice(i - 14, i + 1);
      const allWithin = window.every((w) => w >= zone_b_lower && w <= zone_b_upper);
      if (allWithin) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 7', description: '15 consecutive points within 1σ (stratification — too little variation)',
        });
      }
    }

    // Rule 8: 8 consecutive points beyond 1σ (both sides)
    if (i >= 7) {
      const window = values.slice(i - 7, i + 1);
      const allBeyond = window.every((w) => w > zone_b_upper || w < zone_b_lower);
      if (allBeyond) {
        violations.push({
          index: i, value: round4(v),
          rule: 'Rule 8', description: '8 consecutive points beyond 1σ on either side (mixture)',
        });
      }
    }
  }

  return violations;
}

// ── Attribute Charts ─────────────────────────────────────────

export interface AttributeChartData {
  chart_type: 'p' | 'np' | 'c' | 'u';
  values: number[];
  sample_sizes: number[];
  center_line: number;
  ucl: number[];
  lcl: number[];
  violations: ControlViolation[];
}

/**
 * p-chart: proportion defective per subgroup.
 * Input: defectives per subgroup, sample size per subgroup.
 * Exported for testing.
 */
export function pChart(defectives: number[], sampleSizes: number[]): AttributeChartData {
  if (defectives.length < 2) throw new Error('Need at least 2 subgroups for p-chart.');
  if (defectives.length !== sampleSizes.length) throw new Error('defectives and sampleSizes must have equal length.');

  const proportions = defectives.map((d, i) => sampleSizes[i] > 0 ? d / sampleSizes[i] : 0);
  const totalDefectives = defectives.reduce((s, d) => s + d, 0);
  const totalSamples = sampleSizes.reduce((s, n) => s + n, 0);
  const pBar = totalSamples > 0 ? totalDefectives / totalSamples : 0;

  // Variable control limits (depend on sample size)
  const ucl = sampleSizes.map((n) => {
    const limit = pBar + 3 * Math.sqrt(pBar * (1 - pBar) / n);
    return Math.min(round4(limit), 1);
  });
  const lcl = sampleSizes.map((n) => {
    const limit = pBar - 3 * Math.sqrt(pBar * (1 - pBar) / n);
    return Math.max(round4(limit), 0);
  });

  const violations: ControlViolation[] = [];
  for (let i = 0; i < proportions.length; i++) {
    if (proportions[i] > ucl[i] || proportions[i] < lcl[i]) {
      violations.push({
        index: i, value: round4(proportions[i]),
        rule: 'Rule 1', description: 'Proportion beyond control limits',
      });
    }
  }

  return {
    chart_type: 'p',
    values: proportions.map(round4),
    sample_sizes: sampleSizes,
    center_line: round4(pBar),
    ucl, lcl, violations,
  };
}

/**
 * np-chart: count of defectives per subgroup (constant sample size).
 * Exported for testing.
 */
export function npChart(defectives: number[], sampleSize: number): AttributeChartData {
  if (defectives.length < 2) throw new Error('Need at least 2 subgroups for np-chart.');
  if (sampleSize <= 0) throw new Error('Sample size must be positive.');

  const pBar = defectives.reduce((s, d) => s + d, 0) / (defectives.length * sampleSize);
  const npBar = pBar * sampleSize;
  const sigma = Math.sqrt(npBar * (1 - pBar));

  const uclVal = round4(Math.min(npBar + 3 * sigma, sampleSize));
  const lclVal = round4(Math.max(npBar - 3 * sigma, 0));

  const violations: ControlViolation[] = [];
  for (let i = 0; i < defectives.length; i++) {
    if (defectives[i] > uclVal || defectives[i] < lclVal) {
      violations.push({
        index: i, value: defectives[i],
        rule: 'Rule 1', description: 'Defective count beyond control limits',
      });
    }
  }

  return {
    chart_type: 'np',
    values: defectives,
    sample_sizes: Array(defectives.length).fill(sampleSize),
    center_line: round4(npBar),
    ucl: Array(defectives.length).fill(uclVal),
    lcl: Array(defectives.length).fill(lclVal),
    violations,
  };
}

/**
 * c-chart: count of defects per unit (constant opportunity).
 * Exported for testing.
 */
export function cChart(defects: number[]): AttributeChartData {
  if (defects.length < 2) throw new Error('Need at least 2 observations for c-chart.');

  const cBar = defects.reduce((s, d) => s + d, 0) / defects.length;
  const sigma = Math.sqrt(cBar);

  const uclVal = round4(cBar + 3 * sigma);
  const lclVal = round4(Math.max(cBar - 3 * sigma, 0));

  const violations: ControlViolation[] = [];
  for (let i = 0; i < defects.length; i++) {
    if (defects[i] > uclVal || defects[i] < lclVal) {
      violations.push({
        index: i, value: defects[i],
        rule: 'Rule 1', description: 'Defect count beyond control limits',
      });
    }
  }

  return {
    chart_type: 'c',
    values: defects,
    sample_sizes: Array(defects.length).fill(1),
    center_line: round4(cBar),
    ucl: Array(defects.length).fill(uclVal),
    lcl: Array(defects.length).fill(lclVal),
    violations,
  };
}

/**
 * u-chart: defects per unit with variable sample sizes.
 * Exported for testing.
 */
export function uChart(defects: number[], sampleSizes: number[]): AttributeChartData {
  if (defects.length < 2) throw new Error('Need at least 2 observations for u-chart.');
  if (defects.length !== sampleSizes.length) throw new Error('defects and sampleSizes must have equal length.');

  const totalDefects = defects.reduce((s, d) => s + d, 0);
  const totalUnits = sampleSizes.reduce((s, n) => s + n, 0);
  const uBar = totalUnits > 0 ? totalDefects / totalUnits : 0;

  const rates = defects.map((d, i) => sampleSizes[i] > 0 ? d / sampleSizes[i] : 0);
  const ucl = sampleSizes.map((n) => round4(uBar + 3 * Math.sqrt(uBar / n)));
  const lcl = sampleSizes.map((n) => round4(Math.max(uBar - 3 * Math.sqrt(uBar / n), 0)));

  const violations: ControlViolation[] = [];
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] > ucl[i] || rates[i] < lcl[i]) {
      violations.push({
        index: i, value: round4(rates[i]),
        rule: 'Rule 1', description: 'Defect rate beyond control limits',
      });
    }
  }

  return {
    chart_type: 'u',
    values: rates.map(round4),
    sample_sizes: sampleSizes,
    center_line: round4(uBar),
    ucl, lcl, violations,
  };
}

// ── CUSUM Chart ──────────────────────────────────────────────

export interface CusumChartData {
  values: number[];
  c_plus: number[];
  c_minus: number[];
  h: number;
  k: number;
  center: number;
  violations: ControlViolation[];
}

/**
 * CUSUM (Cumulative Sum) control chart.
 * Detects small persistent shifts that Western Electric rules miss.
 * C⁺ᵢ = max(0, Cᵢ₋₁ + xᵢ - μ₀ - k)
 * C⁻ᵢ = max(0, Cᵢ₋₁ - xᵢ + μ₀ - k)
 * Signal when C⁺ or C⁻ > h
 * Default k = 0.5σ (allowance), h = 5σ (decision interval).
 * Exported for testing.
 */
export function cusumChart(
  values: number[],
  target?: number,
  sigma?: number,
  k?: number,
  h?: number,
): CusumChartData {
  if (values.length < 2) throw new Error('Need at least 2 measurements for CUSUM chart.');

  const mu = target ?? mean(values);
  const s = sigma ?? stddev(values);
  const kVal = k ?? 0.5 * s; // allowance (slack)
  const hVal = h ?? 5 * s;   // decision interval

  const cPlus: number[] = [0];
  const cMinus: number[] = [0];
  const violations: ControlViolation[] = [];

  for (let i = 0; i < values.length; i++) {
    const prevPlus = i > 0 ? cPlus[i] : 0;
    const prevMinus = i > 0 ? cMinus[i] : 0;

    const newPlus = Math.max(0, prevPlus + values[i] - mu - kVal);
    const newMinus = Math.max(0, prevMinus - values[i] + mu - kVal);

    cPlus.push(round4(newPlus));
    cMinus.push(round4(newMinus));

    if (newPlus > hVal) {
      violations.push({
        index: i, value: round4(values[i]),
        rule: 'CUSUM+', description: `Upward shift detected (C⁺=${newPlus.toFixed(2)} > h=${hVal.toFixed(2)})`,
      });
    }
    if (newMinus > hVal) {
      violations.push({
        index: i, value: round4(values[i]),
        rule: 'CUSUM-', description: `Downward shift detected (C⁻=${newMinus.toFixed(2)} > h=${hVal.toFixed(2)})`,
      });
    }
  }

  // Remove the leading zero (initialization)
  cPlus.shift();
  cMinus.shift();

  return { values, c_plus: cPlus, c_minus: cMinus, h: round4(hVal), k: round4(kVal), center: round4(mu), violations };
}

// ── EWMA Chart ───────────────────────────────────────────────

export interface EwmaChartData {
  values: number[];
  ewma: number[];
  ucl: number[];
  lcl: number[];
  center: number;
  lambda: number;
  violations: ControlViolation[];
}

/**
 * EWMA (Exponentially Weighted Moving Average) control chart.
 * Detects gradual drift and small sustained shifts.
 * Zᵢ = λxᵢ + (1-λ)Zᵢ₋₁
 * UCL/LCL = μ₀ ± L × σ × sqrt(λ/(2-λ) × (1-(1-λ)²ⁱ))
 * Default λ=0.2, L=3.
 * Exported for testing.
 */
export function ewmaChart(
  values: number[],
  lambda: number = 0.2,
  L: number = 3,
  target?: number,
  sigma?: number,
): EwmaChartData {
  if (values.length < 2) throw new Error('Need at least 2 measurements for EWMA chart.');
  if (lambda <= 0 || lambda > 1) throw new Error('Lambda must be in (0, 1].');

  const mu = target ?? mean(values);
  const s = sigma ?? stddev(values);

  const ewma: number[] = [mu]; // Z₀ = μ₀
  const ucl: number[] = [];
  const lcl: number[] = [];
  const violations: ControlViolation[] = [];

  for (let i = 0; i < values.length; i++) {
    const z = lambda * values[i] + (1 - lambda) * ewma[i];
    ewma.push(round4(z));

    // Time-varying control limits
    const factor = L * s * Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (i + 1))));
    ucl.push(round4(mu + factor));
    lcl.push(round4(mu - factor));

    if (z > mu + factor || z < mu - factor) {
      violations.push({
        index: i, value: round4(values[i]),
        rule: 'EWMA', description: `EWMA value ${z.toFixed(3)} outside limits [${(mu - factor).toFixed(3)}, ${(mu + factor).toFixed(3)}]`,
      });
    }
  }

  // Remove the initial Z₀
  ewma.shift();

  return { values, ewma, ucl, lcl, center: round4(mu), lambda, violations };
}

// ── Trend Regression ─────────────────────────────────────────

export interface TrendResult {
  slope: number;
  intercept: number;
  r_squared: number;
  predicted_oos_index: number | null; // index where trend crosses spec limit
  predicted_oos_description: string;
  trend_direction: 'increasing' | 'decreasing' | 'stable';
}

/**
 * Linear trend regression on measurement data.
 * Detects drift direction, rate, and predicts when process will go out of spec.
 * Exported for testing.
 */
export function trendRegression(values: number[], spec?: SpecLimits): TrendResult {
  if (values.length < 3) throw new Error('Need at least 3 data points for trend analysis.');

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);

  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = values[i] - yMean;
    sumXY += dx * dy;
    sumXX += dx * dx;
    sumYY += dy * dy;
  }

  const slope = sumXX > 0 ? sumXY / sumXX : 0;
  const intercept = yMean - slope * xMean;
  const rSquared = sumXX > 0 && sumYY > 0 ? (sumXY * sumXY) / (sumXX * sumYY) : 0;

  // Trend direction (require R² > 0.3 to consider meaningful)
  let trendDirection: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (rSquared > 0.3) {
    trendDirection = slope > 0 ? 'increasing' : 'decreasing';
  }

  // Predict when trend crosses spec limits
  let predictedOosIndex: number | null = null;
  let predictedOosDescription = 'No out-of-spec trend predicted.';

  if (spec && trendDirection !== 'stable' && Math.abs(slope) > 1e-10) {
    if (slope > 0 && spec.usl !== undefined) {
      const crossIdx = (spec.usl - intercept) / slope;
      if (crossIdx > n - 1) {
        predictedOosIndex = Math.ceil(crossIdx);
        const periodsAhead = predictedOosIndex - (n - 1);
        predictedOosDescription = `Trend will reach USL (${spec.usl}) in ~${periodsAhead} observations (at observation #${predictedOosIndex + 1}).`;
      }
    }
    if (slope < 0 && spec.lsl !== undefined) {
      const crossIdx = (spec.lsl - intercept) / slope;
      if (crossIdx > n - 1) {
        predictedOosIndex = Math.ceil(crossIdx);
        const periodsAhead = predictedOosIndex - (n - 1);
        predictedOosDescription = `Trend will reach LSL (${spec.lsl}) in ~${periodsAhead} observations (at observation #${predictedOosIndex + 1}).`;
      }
    }
  }

  return {
    slope: round4(slope),
    intercept: round4(intercept),
    r_squared: round4(rSquared),
    predicted_oos_index: predictedOosIndex,
    predicted_oos_description: predictedOosDescription,
    trend_direction: trendDirection,
  };
}

// ── CUSUM/EWMA/Attribute Chart Generation ────────────────────

/**
 * Generate a CUSUM chart PNG.
 * Exported for testing.
 */
export async function generateCusumChart(data: CusumChartData, projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 450, backgroundColour: 'white' });

  const labels = data.values.map((_, i) => `${i + 1}`);
  const violationCount = data.violations.length;

  const config = {
    type: 'line' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'C⁺ (upward)',
          data: data.c_plus,
          borderColor: '#e15759',
          backgroundColor: 'transparent',
          pointRadius: 2,
          borderWidth: 2,
        },
        {
          label: 'C⁻ (downward)',
          data: data.c_minus,
          borderColor: '#4e79a7',
          backgroundColor: 'transparent',
          pointRadius: 2,
          borderWidth: 2,
        },
        {
          label: `h = ${data.h.toFixed(2)}`,
          data: Array(data.values.length).fill(data.h),
          borderColor: '#999',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`CUSUM Chart: ${projectName}`, violationCount > 0 ? `${violationCount} shift(s) detected` : 'No shifts detected'],
          font: { size: 14 },
          color: violationCount > 0 ? '#e15759' : '#333',
        },
        legend: { position: 'bottom' as const, labels: { font: { size: 10 } } },
      },
      scales: {
        x: { title: { display: true, text: 'Observation' } },
        y: { title: { display: true, text: 'Cumulative Sum' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filename = `sigma-cusum-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate an EWMA chart PNG.
 * Exported for testing.
 */
export async function generateEwmaChart(data: EwmaChartData, projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 450, backgroundColour: 'white' });

  const labels = data.values.map((_, i) => `${i + 1}`);
  const violationIndices = new Set(data.violations.map((v) => v.index));
  const pointColors = data.ewma.map((_, i) => violationIndices.has(i) ? '#e15759' : '#4e79a7');

  const config = {
    type: 'line' as const,
    data: {
      labels,
      datasets: [
        {
          label: `EWMA (λ=${data.lambda})`,
          data: data.ewma,
          borderColor: '#4e79a7',
          backgroundColor: 'transparent',
          pointBackgroundColor: pointColors,
          pointRadius: data.ewma.map((_, i) => violationIndices.has(i) ? 5 : 2),
          borderWidth: 2,
        },
        {
          label: 'UCL',
          data: data.ucl,
          borderColor: '#e15759',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
        },
        {
          label: `CL (${data.center.toFixed(2)})`,
          data: Array(data.values.length).fill(data.center),
          borderColor: '#59a14f',
          borderWidth: 1.5,
          pointRadius: 0,
        },
        {
          label: 'LCL',
          data: data.lcl,
          borderColor: '#e15759',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`EWMA Chart: ${projectName}`, `${data.violations.length > 0 ? data.violations.length + ' violation(s)' : 'Process in control'}`],
          font: { size: 14 },
          color: data.violations.length > 0 ? '#e15759' : '#333',
        },
        legend: { position: 'bottom' as const, labels: { font: { size: 10 } } },
      },
      scales: {
        x: { title: { display: true, text: 'Observation' } },
        y: { title: { display: true, text: 'EWMA Value' } },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filename = `sigma-ewma-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate attribute chart (p, np, c, u) PNG.
 * Exported for testing.
 */
export async function generateAttributeChart(data: AttributeChartData, projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 450, backgroundColour: 'white' });

  const labels = data.values.map((_, i) => `${i + 1}`);
  const violationIndices = new Set(data.violations.map((v) => v.index));
  const pointColors = data.values.map((_, i) => violationIndices.has(i) ? '#e15759' : '#4e79a7');

  const typeLabels: Record<string, string> = { p: 'p-chart (Proportion)', np: 'np-chart (Count)', c: 'c-chart (Defects)', u: 'u-chart (Rate)' };
  const yLabels: Record<string, string> = { p: 'Proportion Defective', np: 'Defective Count', c: 'Defect Count', u: 'Defects per Unit' };

  const config = {
    type: 'line' as const,
    data: {
      labels,
      datasets: [
        {
          label: typeLabels[data.chart_type] || data.chart_type,
          data: data.values,
          borderColor: '#4e79a7',
          backgroundColor: 'transparent',
          pointBackgroundColor: pointColors,
          pointRadius: data.values.map((_, i) => violationIndices.has(i) ? 5 : 3),
          borderWidth: 1.5,
        },
        {
          label: 'UCL',
          data: data.ucl,
          borderColor: '#e15759',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
        },
        {
          label: `CL (${data.center_line.toFixed(4)})`,
          data: Array(data.values.length).fill(data.center_line),
          borderColor: '#59a14f',
          borderWidth: 1.5,
          pointRadius: 0,
        },
        {
          label: 'LCL',
          data: data.lcl,
          borderColor: '#e15759',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [`${typeLabels[data.chart_type]}: ${projectName}`, `${data.violations.length > 0 ? data.violations.length + ' violation(s)' : 'In control'}`],
          font: { size: 14 },
          color: data.violations.length > 0 ? '#e15759' : '#333',
        },
        legend: { position: 'bottom' as const, labels: { font: { size: 10 } } },
      },
      scales: {
        x: { title: { display: true, text: 'Subgroup' } },
        y: { title: { display: true, text: yLabels[data.chart_type] || 'Value' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration));
  const filename = `sigma-${data.chart_type}-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── Pareto Analysis ──────────────────────────────────────────

/**
 * Pareto analysis of defect types.
 * Groups by defect_type, sorts by frequency descending, calculates cumulative %.
 * Exported for testing.
 */
export function paretoAnalysis(rows: MeasurementRow[]): ParetoItem[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const cat = r.defect_type || 'Unknown';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, c]) => s + c, 0);

  let cumulative = 0;
  return sorted.map(([category, count]) => {
    cumulative += count;
    return {
      category,
      count,
      cumulative_pct: round2((cumulative / total) * 100),
    };
  });
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate a control chart PNG (I-MR or X-bar/R).
 * Shows values with center line, UCL, LCL, and violation markers.
 * Exported for testing.
 */
export async function generateControlChart(chartData: ControlChartData, projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({
    width: 900,
    height: 450,
    backgroundColour: 'white',
  });

  const labels = chartData.values.map((_, i) => `${i + 1}`);
  const violationIndices = new Set(chartData.violations.map((v) => v.index));

  // Point colors: red for violations, blue for normal
  const pointColors = chartData.values.map((_, i) =>
    violationIndices.has(i) ? '#e15759' : '#4e79a7',
  );
  const pointRadii = chartData.values.map((_, i) =>
    violationIndices.has(i) ? 5 : 3,
  );

  const datasets: Array<Record<string, unknown>> = [
    {
      label: chartData.chart_type === 'i_mr' ? 'Individual' : 'X-bar',
      data: chartData.values,
      borderColor: '#4e79a7',
      backgroundColor: 'transparent',
      pointBackgroundColor: pointColors,
      pointRadius: pointRadii,
      borderWidth: 1.5,
      tension: 0,
    },
    {
      label: `UCL (${chartData.ucl.toFixed(2)})`,
      data: Array(chartData.values.length).fill(chartData.ucl),
      borderColor: '#e15759',
      borderDash: [6, 3],
      borderWidth: 1.5,
      pointRadius: 0,
    },
    {
      label: `CL (${chartData.center_line.toFixed(2)})`,
      data: Array(chartData.values.length).fill(chartData.center_line),
      borderColor: '#59a14f',
      borderWidth: 1.5,
      pointRadius: 0,
    },
    {
      label: `LCL (${chartData.lcl.toFixed(2)})`,
      data: Array(chartData.values.length).fill(chartData.lcl),
      borderColor: '#e15759',
      borderDash: [6, 3],
      borderWidth: 1.5,
      pointRadius: 0,
    },
  ];

  const typeLabel = chartData.chart_type === 'i_mr' ? 'I-MR' : 'X-bar/R';
  const violationCount = chartData.violations.length;

  const config = {
    type: 'line' as const,
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `${typeLabel} Control Chart: ${projectName}`,
            `${violationCount > 0 ? `${violationCount} violation(s) detected` : 'Process in control'}`,
          ],
          font: { size: 14 },
          color: violationCount > 0 ? '#e15759' : '#333',
        },
        legend: {
          position: 'bottom' as const,
          labels: { font: { size: 9 }, boxWidth: 12 },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Observation' } },
        y: { title: { display: true, text: 'Value' } },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `sigma-control-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate a Pareto chart PNG.
 * Bar chart of defect counts + line of cumulative percentage.
 * Exported for testing.
 */
export async function generateParetoChart(pareto: ParetoItem[], projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({
    width: 800,
    height: 450,
    backgroundColour: 'white',
  });

  const labels = pareto.map((p) => p.category);
  const counts = pareto.map((p) => p.count);
  const cumPct = pareto.map((p) => p.cumulative_pct);

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          type: 'bar' as const,
          label: 'Count',
          data: counts,
          backgroundColor: '#4e79a7',
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line' as const,
          label: 'Cumulative %',
          data: cumPct,
          borderColor: '#e15759',
          backgroundColor: 'transparent',
          pointBackgroundColor: '#e15759',
          pointRadius: 3,
          borderWidth: 2,
          yAxisID: 'y1',
          order: 1,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Pareto Analysis: ${projectName}`,
          font: { size: 14 },
        },
        legend: {
          position: 'bottom' as const,
          labels: { font: { size: 10 } },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Count' },
          min: 0,
        },
        y1: {
          position: 'right' as const,
          title: { display: true, text: 'Cumulative %' },
          min: 0,
          max: 100,
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `sigma-pareto-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate a capability histogram PNG with spec limits and normal curve overlay.
 * Exported for testing.
 */
export async function generateCapabilityChart(
  values: number[], spec: SpecLimits, capability: CapabilityResult, projectName: string,
): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({
    width: 800,
    height: 450,
    backgroundColour: 'white',
  });

  // Build histogram bins
  const min = Math.min(...values, spec.lsl);
  const max = Math.max(...values, spec.usl);
  const range = max - min;
  const binCount = Math.max(10, Math.ceil(Math.sqrt(values.length)));
  const binWidth = range / binCount;

  const bins: number[] = new Array(binCount).fill(0);
  const binLabels: string[] = [];
  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth;
    binLabels.push(binStart.toFixed(1));
    for (const v of values) {
      if (v >= binStart && (i === binCount - 1 ? v <= binStart + binWidth : v < binStart + binWidth)) {
        bins[i]++;
      }
    }
  }

  // Mark bins that overlap spec limits
  const binColors = binLabels.map((label) => {
    const binStart = parseFloat(label);
    const binEnd = binStart + binWidth;
    if (binEnd <= spec.lsl || binStart >= spec.usl) return '#e15759'; // out of spec
    if (binStart < spec.lsl || binEnd > spec.usl) return '#f28e2b'; // partial
    return '#4e79a7'; // in spec
  });

  const config = {
    type: 'bar' as const,
    data: {
      labels: binLabels,
      datasets: [
        {
          label: 'Frequency',
          data: bins,
          backgroundColor: binColors,
          borderColor: binColors.map((c) => c === '#4e79a7' ? '#3a6a96' : c === '#e15759' ? '#c94547' : '#d47a22'),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `Capability Analysis: ${projectName}`,
            `Cp=${capability.cp.toFixed(2)} Cpk=${capability.cpk.toFixed(2)} Pp=${capability.pp.toFixed(2)} Ppk=${capability.ppk.toFixed(2)}`,
          ],
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          title: { display: true, text: 'Measurement Value' },
          afterBuildTicks: (axis: { ticks: Array<{ value: number }> }) => {
            // Inject LSL and USL as ticks
            for (const val of [spec.lsl, spec.usl]) {
              const idx = Math.round((val - min) / binWidth);
              if (!axis.ticks.some((t) => t.value === idx)) {
                axis.ticks.push({ value: idx });
              }
            }
            axis.ticks.sort((a, b) => a.value - b.value);
          },
        },
        y: { title: { display: true, text: 'Frequency' }, min: 0 },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `sigma-capability-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── Full Pipeline ────────────────────────────────────────────

/**
 * Execute full capability analysis: parse CSV, compute metrics, save to DB.
 */
export function executeCapabilityAnalysis(
  csvContent: string,
  usl: number,
  lsl: number,
  projectName: string,
  target?: number,
): { project: SigmaProject; capability: CapabilityResult; controlChart: ControlChartData } {
  if (usl <= lsl) throw new Error('USL must be greater than LSL.');

  const rows = parseSigmaCsv(csvContent);
  const values = rows.map((r) => r.value);
  const subgroups = rows.map((r) => r.subgroup).filter((s): s is string => s !== undefined);
  const spec: SpecLimits = { usl, lsl, target };

  const capability = calculateCapability(values, spec, subgroups.length > 0 ? subgroups : undefined);

  // Control chart: use X-bar/R if subgroups exist, otherwise I-MR
  const hasSubgroups = subgroups.length > 0 && new Set(subgroups).size >= 2;
  const controlChart = hasSubgroups
    ? xbarR(values, subgroups)
    : individualMR(values);

  // DB: reuse or create project
  let project = getSigmaProjectByName(projectName);
  if (project) {
    const db = getDatabase();
    db.prepare('DELETE FROM sigma_measurements WHERE project_id = ?').run(project.id);
    db.prepare('UPDATE sigma_projects SET usl = ?, lsl = ?, target = ?, updated_at = ? WHERE id = ?')
      .run(usl, lsl, target ?? null, Date.now(), project.id);
    project.usl = usl;
    project.lsl = lsl;
    project.target = target ?? null;
  } else {
    project = createSigmaProject(projectName, usl, lsl, target);
  }

  insertMeasurements(project.id, rows);
  saveSigmaResult(project.id, 'capability', capability);
  saveSigmaResult(project.id, 'control_chart', controlChart);

  logger.info(
    { projectName, samples: values.length, cpk: capability.cpk, violations: controlChart.violations.length },
    'Six Sigma capability analysis completed',
  );

  return { project, capability, controlChart };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format capability result for display.
 * Exported for testing.
 */
export function formatCapabilityResult(
  cap: CapabilityResult,
  chart: ControlChartData,
  projectName: string,
  html: boolean = true,
): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  lines.push(`${b}Six Sigma Capability: ${projectName}${bEnd}`);
  lines.push('');
  lines.push(`${b}Sample Size:${bEnd} ${cap.sample_size}`);
  lines.push(`${b}Mean:${bEnd} ${cap.mean}`);
  lines.push(`${b}Std Dev (within):${bEnd} ${cap.stddev}`);
  lines.push(`${b}Std Dev (overall):${bEnd} ${cap.stddev_overall}`);
  lines.push('');
  lines.push(`${b}Cp:${bEnd} ${cap.cp.toFixed(4)}  |  ${b}Cpk:${bEnd} ${cap.cpk.toFixed(4)}`);
  lines.push(`${b}Pp:${bEnd} ${cap.pp.toFixed(4)}  |  ${b}Ppk:${bEnd} ${cap.ppk.toFixed(4)}`);
  if (cap.cpm !== null) lines.push(`${b}Cpm:${bEnd} ${cap.cpm.toFixed(4)}`);
  lines.push(`${b}Within Spec:${bEnd} ${cap.within_spec_pct.toFixed(1)}%`);
  lines.push('');
  lines.push(cap.interpretation);

  if (chart.violations.length > 0) {
    lines.push('');
    lines.push(`${b}Control Chart Violations (${chart.violations.length}):${bEnd}`);
    // Deduplicate by rule for summary
    const ruleCounts = new Map<string, number>();
    for (const v of chart.violations) {
      ruleCounts.set(v.rule, (ruleCounts.get(v.rule) || 0) + 1);
    }
    for (const [rule, count] of ruleCounts) {
      const desc = chart.violations.find((v) => v.rule === rule)!.description;
      lines.push(`  ${rule}: ${desc} (${count}x)`);
    }
  } else {
    lines.push('');
    lines.push('Control chart: Process in control — no violations detected.');
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
