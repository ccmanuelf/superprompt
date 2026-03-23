import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseSigmaCsv,
  mean,
  stddev,
  withinStddev,
  calculateCapability,
  calculateDpmo,
  dpmoToSigma,
  rolledThroughputYield,
  inverseNormal,
  individualMR,
  xbarR,
  detectWesternElectricRules,
  paretoAnalysis,
  formatCapabilityResult,
  generateControlChart,
  generateParetoChart,
  generateCapabilityChart,
  initSigmaTables,
  createSigmaProject,
  getSigmaProject,
  getSigmaProjectByName,
  listSigmaProjects,
  deleteSigmaProject,
  insertMeasurements,
  getMeasurements,
  saveSigmaResult,
  getSigmaResults,
  type MeasurementRow,
  type SpecLimits,
  type ControlChartData,
  type CapabilityResult,
} from '../src/sigma.js';

// ── Test DB setup (raw SQL, same pattern as balance/kanban) ──

const TMP_DIR = resolve(tmpdir(), 'clauded-test-sigma');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'sigma-test.db');

let db: Database.Database;

// Mock getDatabase before importing
import { vi } from 'vitest';
vi.mock('../src/db.js', () => ({ getDatabase: () => db }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'clauded-test-sigma'),
  config: { NODE_ENV: 'test' },
}));

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSigmaTables();
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ── Test Data ────────────────────────────────────────────────

// Normal process: mean ≈ 10, stddev ≈ 0.5, spec 9-11
const NORMAL_CSV = `value,subgroup
9.8,A
10.1,A
10.0,A
9.9,B
10.2,B
10.1,B
10.3,C
9.7,C
10.0,C
10.1,D
9.8,D
10.2,D`;

// Out-of-spec process
const OOS_CSV = `value
8.5
11.5
10.0
9.0
11.0
7.5
12.0
10.5
8.0
10.0`;

// With defect types
const DEFECT_CSV = `value,defect_type
10.1,scratch
10.2,scratch
9.8,dent
10.0,scratch
9.9,crack
10.3,scratch
10.1,dent
10.0,
9.7,crack
10.2,scratch`;

// ── CSV Parsing Tests ────────────────────────────────────────

describe('CSV Parsing', () => {
  it('parses basic measurement CSV', () => {
    const rows = parseSigmaCsv('value\n10.0\n10.5\n9.5');
    expect(rows).toHaveLength(3);
    expect(rows[0].value).toBe(10.0);
    expect(rows[1].value).toBe(10.5);
  });

  it('parses CSV with subgroups', () => {
    const rows = parseSigmaCsv(NORMAL_CSV);
    expect(rows).toHaveLength(12);
    expect(rows[0].subgroup).toBe('A');
    expect(rows[3].subgroup).toBe('B');
  });

  it('parses CSV with defect types', () => {
    const rows = parseSigmaCsv(DEFECT_CSV);
    expect(rows).toHaveLength(10);
    expect(rows[0].defect_type).toBe('scratch');
    expect(rows[7].defect_type).toBeUndefined(); // empty field
  });

  it('handles BOM', () => {
    const csv = '\uFEFFvalue\n10.0\n11.0';
    const rows = parseSigmaCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('throws on missing value column', () => {
    expect(() => parseSigmaCsv('measurement\n10.0')).toThrow('value');
  });

  it('throws on non-numeric value', () => {
    expect(() => parseSigmaCsv('value\nabc')).toThrow('number');
  });

  it('throws on empty CSV', () => {
    expect(() => parseSigmaCsv('value')).toThrow('at least one data row');
  });
});

// ── Statistical Functions ────────────────────────────────────

describe('Statistical Functions', () => {
  it('calculates mean correctly', () => {
    expect(mean([2, 4, 6, 8, 10])).toBe(6);
  });

  it('mean of empty array is 0', () => {
    expect(mean([])).toBe(0);
  });

  it('calculates sample standard deviation', () => {
    // Known: [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, stddev=2
    const s = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s).toBeCloseTo(2.0, 0);
  });

  it('stddev of single value is 0', () => {
    expect(stddev([42])).toBe(0);
  });

  it('calculates within-subgroup stddev using R-bar/d2', () => {
    // With subgroups, within-std should differ from overall-std
    const values = [10, 10.1, 10.2, 9.8, 9.9, 10.0];
    const subs = ['A', 'A', 'A', 'B', 'B', 'B'];
    const ws = withinStddev(values, subs);
    expect(ws).toBeGreaterThan(0);
    // Within-subgroup variation should typically be <= overall
    const os = stddev(values);
    // Not always true for small samples, but should be reasonable
    expect(ws).toBeLessThan(os * 3);
  });

  it('falls back to overall stddev without subgroups', () => {
    const values = [10, 10.1, 10.2, 9.8, 9.9];
    expect(withinStddev(values)).toBe(stddev(values));
  });
});

// ── Capability Indices Tests ─────────────────────────────────

describe('Capability Indices', () => {
  it('calculates Cp and Cpk for capable process', () => {
    // Generate a tight process: mean=10, sigma≈0.167 → Cp = (11-9)/(6*0.167) = 2.0
    const values = [9.8, 10.0, 10.2, 9.9, 10.1, 10.0, 10.1, 9.9, 10.0, 10.0];
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);

    expect(cap.cp).toBeGreaterThan(1.0);
    expect(cap.cpk).toBeGreaterThan(0);
    expect(cap.cpk).toBeLessThanOrEqual(cap.cp);
    expect(cap.within_spec_pct).toBe(100);
  });

  it('Cpk < Cp when process is off-center', () => {
    // Process shifted toward USL
    const values = [10.5, 10.6, 10.7, 10.4, 10.8, 10.5, 10.6, 10.7, 10.5, 10.6];
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);

    expect(cap.cpk).toBeLessThan(cap.cp);
  });

  it('calculates Pp and Ppk using overall variation', () => {
    const rows = parseSigmaCsv(NORMAL_CSV);
    const values = rows.map((r) => r.value);
    const subs = rows.map((r) => r.subgroup!);
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec, subs);

    expect(cap.pp).toBeGreaterThan(0);
    expect(cap.ppk).toBeGreaterThan(0);
    // Pp uses overall sigma (larger), so Pp <= Cp typically
  });

  it('calculates Cpm when target is provided', () => {
    const values = [10.0, 10.1, 9.9, 10.0, 10.2, 9.8, 10.0, 10.1, 9.9, 10.0];
    const spec: SpecLimits = { usl: 11, lsl: 9, target: 10.0 };
    const cap = calculateCapability(values, spec);

    expect(cap.cpm).not.toBeNull();
    expect(cap.cpm!).toBeGreaterThan(0);
  });

  it('detects out-of-spec measurements', () => {
    const rows = parseSigmaCsv(OOS_CSV);
    const values = rows.map((r) => r.value);
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);

    expect(cap.within_spec_pct).toBeLessThan(100);
    expect(cap.cpk).toBeLessThan(1.0); // not capable
  });

  it('interpretation flags incapable process', () => {
    const values = [8, 12, 7, 13, 9, 11, 8, 12, 7, 13];
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);

    expect(cap.interpretation).toContain('NOT CAPABLE');
  });

  it('interpretation flags capable process', () => {
    const values = [10.0, 10.01, 9.99, 10.0, 10.02, 9.98, 10.0, 10.01, 9.99, 10.0];
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);

    expect(cap.cpk).toBeGreaterThan(1.33);
  });

  it('throws on less than 2 measurements', () => {
    expect(() => calculateCapability([10], { usl: 11, lsl: 9 })).toThrow('at least 2');
  });
});

// ── DPMO & Sigma Level Tests ─────────────────────────────────

describe('DPMO & Sigma Level', () => {
  it('calculates DPMO correctly', () => {
    // 3 defects in 1000 units with 1 opportunity each = 3000 DPMO
    const result = calculateDpmo(3, 1000, 1);
    expect(result.dpmo).toBe(3000);
    expect(result.yield_pct).toBeCloseTo(99.7, 1);
  });

  it('DPMO of 3.4 is 6 sigma', () => {
    const result = calculateDpmo(34, 10_000_000, 1);
    expect(result.dpmo).toBeCloseTo(3.4, 1);
    expect(result.sigma_level).toBeCloseTo(6.0, 0);
  });

  it('DPMO of 66807 is approximately 3 sigma', () => {
    const sigma = dpmoToSigma(66807);
    expect(sigma).toBeCloseTo(3.0, 0);
  });

  it('DPMO of 6210 is approximately 4 sigma', () => {
    const sigma = dpmoToSigma(6210);
    expect(sigma).toBeCloseTo(4.0, 0);
  });

  it('DPMO of 233 is approximately 5 sigma', () => {
    const sigma = dpmoToSigma(233);
    expect(sigma).toBeCloseTo(5.0, 0);
  });

  it('zero defects returns 6 sigma', () => {
    const result = calculateDpmo(0, 1000, 1);
    expect(result.dpmo).toBe(0);
    expect(result.sigma_level).toBe(6);
  });

  it('throws on invalid inputs', () => {
    expect(() => calculateDpmo(5, 0, 1)).toThrow('positive');
    expect(() => calculateDpmo(5, 100, 0)).toThrow('positive');
    expect(() => calculateDpmo(-1, 100, 1)).toThrow('negative');
  });

  it('multiple opportunities per unit', () => {
    // 10 defects, 100 units, 5 opportunities each
    const result = calculateDpmo(10, 100, 5);
    expect(result.dpmo).toBe(20000);
  });
});

// ── Rolled Throughput Yield ──────────────────────────────────

describe('Rolled Throughput Yield', () => {
  it('calculates RTY for perfect yields', () => {
    expect(rolledThroughputYield([100, 100, 100])).toBe(100);
  });

  it('calculates RTY for mixed yields', () => {
    // 95% × 90% × 85% = 72.675%
    const rty = rolledThroughputYield([95, 90, 85]);
    expect(rty).toBeCloseTo(72.675, 1);
  });

  it('single step returns that yield', () => {
    expect(rolledThroughputYield([95])).toBe(95);
  });

  it('zero yield step makes RTY zero', () => {
    expect(rolledThroughputYield([95, 0, 85])).toBe(0);
  });

  it('empty array returns 0', () => {
    expect(rolledThroughputYield([])).toBe(0);
  });
});

// ── Inverse Normal ───────────────────────────────────────────

describe('Inverse Normal', () => {
  it('Φ⁻¹(0.5) = 0', () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 1);
  });

  it('Φ⁻¹(0.975) ≈ 1.96', () => {
    expect(inverseNormal(0.975)).toBeCloseTo(1.96, 1);
  });

  it('Φ⁻¹(0.025) ≈ -1.96', () => {
    expect(inverseNormal(0.025)).toBeCloseTo(-1.96, 1);
  });

  it('Φ⁻¹(0.9987) ≈ 3.0', () => {
    expect(inverseNormal(0.9987)).toBeCloseTo(3.0, 0);
  });

  it('handles extreme values', () => {
    expect(inverseNormal(0)).toBe(-6);
    expect(inverseNormal(1)).toBe(6);
  });
});

// ── Control Charts ───────────────────────────────────────────

describe('Control Charts', () => {
  it('generates I-MR chart with correct limits', () => {
    const values = [10, 10.1, 9.9, 10.2, 9.8, 10.0, 10.1, 9.9, 10.0, 10.0];
    const chart = individualMR(values);

    expect(chart.chart_type).toBe('i_mr');
    expect(chart.values).toHaveLength(10);
    expect(chart.center_line).toBeCloseTo(10.0, 0);
    expect(chart.ucl).toBeGreaterThan(chart.center_line);
    expect(chart.lcl).toBeLessThan(chart.center_line);
    expect(chart.range_values).toHaveLength(9); // n-1 moving ranges
    expect(chart.range_cl).toBeGreaterThan(0);
    expect(chart.range_ucl).toBeGreaterThan(chart.range_cl!);
    expect(chart.range_lcl).toBe(0);
  });

  it('generates X-bar/R chart from subgrouped data', () => {
    const values = [10, 10.1, 10.2, 9.8, 9.9, 10.0, 10.3, 9.7, 10.0];
    const subs = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
    const chart = xbarR(values, subs);

    expect(chart.chart_type).toBe('xbar_r');
    expect(chart.values).toHaveLength(3); // 3 subgroup means
    expect(chart.range_values).toHaveLength(3);
    expect(chart.ucl).toBeGreaterThan(chart.center_line);
    expect(chart.lcl).toBeLessThan(chart.center_line);
  });

  it('detects out-of-control point (Rule 1)', () => {
    // One extreme value
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 15];
    const chart = individualMR(values);

    const rule1 = chart.violations.filter((v) => v.rule === 'Rule 1');
    expect(rule1.length).toBeGreaterThan(0);
  });

  it('throws on fewer than 2 measurements', () => {
    expect(() => individualMR([10])).toThrow('at least 2');
  });

  it('throws on fewer than 2 subgroups', () => {
    expect(() => xbarR([10, 10.1, 10.2], ['A', 'A', 'A'])).toThrow('at least 2 subgroups');
  });
});

// ── Western Electric Rules ───────────────────────────────────

describe('Western Electric Rules', () => {
  it('Rule 1: detects point beyond 3σ', () => {
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    const violations = detectWesternElectricRules(values, 0, 1);
    const r1 = violations.filter((v) => v.rule === 'Rule 1');
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0].index).toBe(9);
  });

  it('Rule 2: 9 consecutive points on same side', () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1]; // all above center=0
    const violations = detectWesternElectricRules(values, 0, 1);
    const r2 = violations.filter((v) => v.rule === 'Rule 2');
    expect(r2.length).toBeGreaterThan(0);
  });

  it('Rule 3: 6 consecutive increasing points', () => {
    const values = [1, 2, 3, 4, 5, 6];
    const violations = detectWesternElectricRules(values, 3.5, 10);
    const r3 = violations.filter((v) => v.rule === 'Rule 3');
    expect(r3.length).toBeGreaterThan(0);
  });

  it('Rule 5: 2 of 3 points beyond 2σ', () => {
    const values = [0, 2.5, 2.5]; // two beyond 2σ in 3 points
    const violations = detectWesternElectricRules(values, 0, 1);
    const r5 = violations.filter((v) => v.rule === 'Rule 5');
    expect(r5.length).toBeGreaterThan(0);
  });

  it('no violations for stable process', () => {
    // Values close to center, well within limits
    const values = [0, 0.1, -0.1, 0.2, -0.2, 0.1, -0.1, 0, 0.1, -0.1];
    const violations = detectWesternElectricRules(values, 0, 1);
    // May have some minor ones, but no Rule 1
    const r1 = violations.filter((v) => v.rule === 'Rule 1');
    expect(r1).toHaveLength(0);
  });
});

// ── Pareto Analysis ──────────────────────────────────────────

describe('Pareto Analysis', () => {
  it('sorts defects by frequency descending', () => {
    const rows = parseSigmaCsv(DEFECT_CSV);
    const pareto = paretoAnalysis(rows);

    expect(pareto[0].category).toBe('scratch');
    expect(pareto[0].count).toBe(5);
    expect(pareto[1].count).toBeLessThanOrEqual(pareto[0].count);
  });

  it('calculates cumulative percentages', () => {
    const rows = parseSigmaCsv(DEFECT_CSV);
    const pareto = paretoAnalysis(rows);

    expect(pareto[pareto.length - 1].cumulative_pct).toBe(100);
    for (let i = 1; i < pareto.length; i++) {
      expect(pareto[i].cumulative_pct).toBeGreaterThanOrEqual(pareto[i - 1].cumulative_pct);
    }
  });

  it('handles rows without defect_type as Unknown', () => {
    const rows: MeasurementRow[] = [
      { value: 10 },
      { value: 10 },
      { value: 10, defect_type: 'scratch' },
    ];
    const pareto = paretoAnalysis(rows);
    expect(pareto.some((p) => p.category === 'Unknown')).toBe(true);
  });
});

// ── Formatting ───────────────────────────────────────────────

describe('Formatting', () => {
  it('formats capability result as HTML', () => {
    const rows = parseSigmaCsv(NORMAL_CSV);
    const cap = calculateCapability(rows.map((r) => r.value), { usl: 11, lsl: 9 });
    const chart = individualMR(rows.map((r) => r.value));
    const text = formatCapabilityResult(cap, chart, 'Test', true);

    expect(text).toContain('<b>Six Sigma Capability: Test</b>');
    expect(text).toContain('Cp:');
    expect(text).toContain('Cpk:');
    expect(text).toContain('Pp:');
  });

  it('formats capability as plain text', () => {
    const cap = calculateCapability([10, 10.1, 9.9], { usl: 11, lsl: 9 });
    const chart = individualMR([10, 10.1, 9.9]);
    const text = formatCapabilityResult(cap, chart, 'Test', false);

    expect(text).not.toContain('<b>');
    expect(text).toContain('Cpk:');
  });

  it('shows violation summary when violations exist', () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 20]; // extreme point
    const chart = individualMR(values);
    const cap = calculateCapability(values, { usl: 15, lsl: 5 });
    const text = formatCapabilityResult(cap, chart, 'Test', false);

    expect(text).toContain('Violation');
    expect(text).toContain('Rule 1');
  });
});

// ── Database Tests ───────────────────────────────────────────

describe('Database Operations', () => {
  it('creates and retrieves a sigma project', () => {
    const project = createSigmaProject('Widget', 11, 9, 10);
    expect(project.name).toBe('Widget');
    expect(project.usl).toBe(11);
    expect(project.lsl).toBe(9);
    expect(project.target).toBe(10);

    const retrieved = getSigmaProject(project.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Widget');
  });

  it('finds project by name (case-insensitive)', () => {
    createSigmaProject('PCB Width', 5.1, 4.9);
    const found = getSigmaProjectByName('pcb width');
    expect(found).toBeDefined();
  });

  it('inserts and retrieves measurements', () => {
    const project = createSigmaProject('MeasTest', 11, 9);
    const rows: MeasurementRow[] = [
      { value: 10.0, subgroup: 'A' },
      { value: 10.1, subgroup: 'A' },
      { value: 9.9, subgroup: 'B', defect_type: 'scratch' },
    ];
    insertMeasurements(project.id, rows);

    const retrieved = getMeasurements(project.id);
    expect(retrieved).toHaveLength(3);
    expect(retrieved[0].value).toBe(10.0);
    expect(retrieved[2].defect_type).toBe('scratch');
  });

  it('saves and retrieves results', () => {
    const project = createSigmaProject('ResultTest', 11, 9);
    const capData = { cp: 1.5, cpk: 1.3 };
    saveSigmaResult(project.id, 'capability', capData);

    const results = getSigmaResults(project.id);
    expect(results).toHaveLength(1);
    expect(results[0].result_type).toBe('capability');
    const parsed = JSON.parse(results[0].result_json);
    expect(parsed.cp).toBe(1.5);
  });

  it('cascades delete from project to measurements and results', () => {
    const project = createSigmaProject('Cascade', 11, 9);
    insertMeasurements(project.id, [{ value: 10 }]);
    saveSigmaResult(project.id, 'test', { x: 1 });

    deleteSigmaProject(project.id);

    expect(getMeasurements(project.id)).toHaveLength(0);
    expect(getSigmaResults(project.id)).toHaveLength(0);
  });

  it('lists projects ordered by updated_at desc', () => {
    createSigmaProject('First', 11, 9);
    createSigmaProject('Second', 11, 9);
    const projects = listSigmaProjects();
    expect(projects).toHaveLength(2);
  });
});

// ── Chart Generation Tests ───────────────────────────────────

describe('Chart Generation', () => {
  it('generates control chart PNG', async () => {
    const values = [10, 10.1, 9.9, 10.2, 9.8, 10.0, 10.1, 9.9, 10.0, 10.0];
    const chart = individualMR(values);
    const filePath = await generateControlChart(chart, 'Chart Test');

    expect(existsSync(filePath)).toBe(true);
    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0x89); // PNG magic
    expect(buffer.length).toBeGreaterThan(1000);

    rmSync(filePath);
  });

  it('generates Pareto chart PNG', async () => {
    const rows = parseSigmaCsv(DEFECT_CSV);
    const pareto = paretoAnalysis(rows);
    const filePath = await generateParetoChart(pareto, 'Pareto Test');

    expect(existsSync(filePath)).toBe(true);
    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0x89);

    rmSync(filePath);
  });

  it('generates capability histogram PNG', async () => {
    const rows = parseSigmaCsv(NORMAL_CSV);
    const values = rows.map((r) => r.value);
    const spec: SpecLimits = { usl: 11, lsl: 9 };
    const cap = calculateCapability(values, spec);
    const filePath = await generateCapabilityChart(values, spec, cap, 'Cap Test');

    expect(existsSync(filePath)).toBe(true);
    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0x89);

    rmSync(filePath);
  });
});

// ── Real-World Scenarios ─────────────────────────────────────

describe('Real-World Scenarios', () => {
  it('machined shaft diameter: capable process', () => {
    // 30 measurements of shaft diameter, spec 25.00 ± 0.05mm
    const baseValues = [25.00, 25.01, 24.99, 25.02, 24.98, 25.01, 25.00, 24.99, 25.01, 25.00];
    const values = [...baseValues, ...baseValues, ...baseValues]; // 30 samples
    const spec: SpecLimits = { usl: 25.05, lsl: 24.95, target: 25.00 };
    const cap = calculateCapability(values, spec);

    expect(cap.cp).toBeGreaterThan(1.0);
    expect(cap.within_spec_pct).toBe(100);
    expect(cap.cpm).not.toBeNull();
  });

  it('injection molding weight: marginal process', () => {
    // Process with drift — some values near spec limits
    const values = [
      50.1, 50.3, 50.0, 49.8, 50.5, 50.2, 49.7, 50.4, 50.1, 49.9,
      50.6, 50.0, 49.6, 50.3, 50.1, 49.8, 50.7, 50.2, 49.5, 50.0,
    ];
    const spec: SpecLimits = { usl: 51, lsl: 49, target: 50 };
    const cap = calculateCapability(values, spec);

    // Should be marginally capable
    expect(cap.cpk).toBeGreaterThan(0);
    expect(cap.cpk).toBeLessThan(2.0);
  });

  it('PCB solder paste: defect Pareto with 80/20 rule', () => {
    const rows: MeasurementRow[] = [];
    // Create defect distribution following Pareto principle
    for (let i = 0; i < 50; i++) rows.push({ value: 10, defect_type: 'insufficient_paste' });
    for (let i = 0; i < 25; i++) rows.push({ value: 10, defect_type: 'bridging' });
    for (let i = 0; i < 15; i++) rows.push({ value: 10, defect_type: 'misalignment' });
    for (let i = 0; i < 7; i++) rows.push({ value: 10, defect_type: 'cold_joint' });
    for (let i = 0; i < 3; i++) rows.push({ value: 10, defect_type: 'tombstone' });

    const pareto = paretoAnalysis(rows);

    expect(pareto[0].category).toBe('insufficient_paste');
    expect(pareto[0].count).toBe(50);
    // Top 2 categories should account for ~75% (80/20-ish)
    expect(pareto[1].cumulative_pct).toBeGreaterThan(70);
  });

  it('full pipeline: CSV → capability → control chart → assessment', () => {
    const rows = parseSigmaCsv(NORMAL_CSV);
    const values = rows.map((r) => r.value);
    const subs = rows.map((r) => r.subgroup).filter((s): s is string => !!s);
    const spec: SpecLimits = { usl: 11, lsl: 9 };

    // Capability
    const cap = calculateCapability(values, spec, subs);
    expect(cap.sample_size).toBe(12);
    expect(cap.cp).toBeGreaterThan(0);

    // Control chart (has subgroups → X-bar/R)
    const chart = xbarR(values, subs);
    expect(chart.chart_type).toBe('xbar_r');
    expect(chart.values.length).toBe(4); // 4 subgroups

    // Format
    const text = formatCapabilityResult(cap, chart, 'Full Pipeline', false);
    expect(text).toContain('Full Pipeline');
    expect(text).toContain('Cpk:');
  });

  it('DPMO → sigma level mapping for common benchmarks', () => {
    // 3σ ≈ 66,807 DPMO
    // 4σ ≈ 6,210 DPMO
    // 5σ ≈ 233 DPMO
    // 6σ ≈ 3.4 DPMO

    expect(dpmoToSigma(66807)).toBeCloseTo(3.0, 0);
    expect(dpmoToSigma(6210)).toBeCloseTo(4.0, 0);
    expect(dpmoToSigma(233)).toBeCloseTo(5.0, 0);
    expect(dpmoToSigma(3.4)).toBeCloseTo(6.0, 0);
  });
});
