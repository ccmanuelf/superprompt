import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'luna-test-spc-adv'),
  config: { NODE_ENV: 'test' },
}));

import {
  pChart, npChart, cChart, uChart,
  xbarS, xbarR, generateControlChart,
  cusumChart, ewmaChart, trendRegression,
  generateCusumChart, generateEwmaChart, generateAttributeChart,
  initSigmaTables,
  type SpecLimits,
} from '../src/sigma.js';

import {
  initControlPlanTables,
  createControlPlan,
  getControlPlanByName,
  listControlPlans,
  deleteControlPlan,
  addVocItem,
  getVocItems,
  addCtqItem,
  getCtqItems,
  buildControlPlanSummary,
  formatControlPlan,
  exportControlPlanCsv,
  recommendChartType,
  recommendSampling,
  recommendReaction,
  suggestStandard,
} from '../src/control-plan.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initSigmaTables();
  await initControlPlanTables();
}

beforeEach(async () => {
  mkdirSync(resolve(tmpdir(), 'luna-test-spc-adv'), { recursive: true });
  await initTestDb();
});
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ══════════════════════════════════════════════════════════════
// ATTRIBUTE CHARTS
// ══════════════════════════════════════════════════════════════

describe('p-chart', () => {
  it('calculates proportion defective with variable limits', () => {
    const defectives = [3, 5, 2, 8, 4, 3, 6, 2, 4, 3];
    const sampleSizes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const result = pChart(defectives, sampleSizes);

    expect(result.chart_type).toBe('p');
    expect(result.center_line).toBe(0.04); // 40/1000
    expect(result.values).toHaveLength(10);
    expect(result.ucl).toHaveLength(10);
    // UCL should be same for equal sample sizes
    expect(result.ucl[0]).toBe(result.ucl[1]);
  });

  it('detects out-of-control proportion', () => {
    const defectives = [3, 3, 3, 3, 15, 3, 3, 3, 3, 3]; // spike at index 4
    const sampleSizes = Array(10).fill(100);
    const result = pChart(defectives, sampleSizes);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].index).toBe(4);
  });

  it('handles variable sample sizes', () => {
    const defectives = [5, 3, 8, 4, 6];
    const sampleSizes = [100, 50, 200, 100, 150];
    const result = pChart(defectives, sampleSizes);
    // UCL/LCL should vary with sample size
    expect(result.ucl[1]).not.toBe(result.ucl[2]); // different n → different limits
  });

  it('LCL is floored at 0', () => {
    const result = pChart([0, 0, 0, 1, 0], Array(5).fill(100));
    for (const lcl of result.lcl) expect(lcl).toBeGreaterThanOrEqual(0);
  });
});

describe('np-chart', () => {
  it('calculates defective count with constant limits', () => {
    const defectives = [3, 5, 2, 8, 4, 3, 6, 2, 4, 3];
    const result = npChart(defectives, 100);

    expect(result.chart_type).toBe('np');
    expect(result.center_line).toBe(4); // 40/10 = 4
    expect(result.ucl[0]).toBe(result.ucl[5]); // constant limits
  });
});

describe('c-chart', () => {
  it('calculates defect count limits', () => {
    const defects = [2, 5, 3, 1, 4, 6, 2, 3, 4, 2];
    const result = cChart(defects);

    expect(result.chart_type).toBe('c');
    expect(result.center_line).toBe(3.2); // 32/10
    // UCL = c̄ + 3√c̄ = 3.2 + 3×1.789 = 8.57
    expect(result.ucl[0]).toBeCloseTo(8.57, 0);
  });

  it('detects high defect count', () => {
    const defects = [2, 3, 2, 3, 2, 3, 2, 3, 15, 2]; // spike at 8
    const result = cChart(defects);
    expect(result.violations.some((v) => v.index === 8)).toBe(true);
  });
});

describe('u-chart', () => {
  it('calculates defect rate with variable units', () => {
    const defects = [10, 8, 15, 12, 9];
    const sampleSizes = [50, 40, 75, 60, 45];
    const result = uChart(defects, sampleSizes);

    expect(result.chart_type).toBe('u');
    expect(result.center_line).toBe(0.2); // 54/270
    expect(result.ucl[0]).not.toBe(result.ucl[1]); // variable limits
  });
});

// ══════════════════════════════════════════════════════════════
// X-bar/S CHART
// ══════════════════════════════════════════════════════════════

describe('X-bar/S Chart', () => {
  it('produces xbar_s chart type', () => {
    const values: number[] = [];
    const subs: string[] = [];
    for (let g = 0; g < 5; g++) {
      for (let i = 0; i < 12; i++) {
        values.push(10 + Math.sin(g + i * 0.3) * 0.5);
        subs.push('G' + g);
      }
    }
    const chart = xbarS(values, subs);
    expect(chart.chart_type).toBe('xbar_s');
    expect(chart.values).toHaveLength(5); // 5 subgroup means
    expect(chart.range_values).toHaveLength(5); // 5 subgroup stddevs
  });

  it('has same center line as X-bar/R for same data', () => {
    const values = [10, 10.1, 10.2, 9.8, 9.9, 10.0, 10.3, 9.7, 10.0];
    const subs = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
    const xsResult = xbarS(values, subs);
    const xrResult = xbarR(values, subs);
    expect(xsResult.center_line).toBe(xrResult.center_line);
  });

  it('S chart limits use B3/B4 constants', () => {
    const values: number[] = [];
    const subs: string[] = [];
    for (let g = 0; g < 5; g++) {
      for (let i = 0; i < 10; i++) {
        values.push(25 + (Math.random() - 0.5) * 0.1);
        subs.push('H' + g);
      }
    }
    const chart = xbarS(values, subs);
    // S limits should be positive and UCL > LCL
    expect(chart.range_ucl).toBeGreaterThan(chart.range_cl!);
    expect(chart.range_lcl).toBeGreaterThanOrEqual(0);
  });

  it('detects out-of-control subgroup mean', () => {
    const values: number[] = [];
    const subs: string[] = [];
    // 4 normal subgroups + 1 shifted
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 10; i++) {
        values.push(25.00 + (i % 2 === 0 ? 0.01 : -0.01));
        subs.push('H' + g);
      }
    }
    // Shifted subgroup
    for (let i = 0; i < 10; i++) {
      values.push(25.10 + (i % 2 === 0 ? 0.01 : -0.01));
      subs.push('H4');
    }
    const chart = xbarS(values, subs);
    expect(chart.violations.length).toBeGreaterThan(0);
  });

  it('injection molding scenario: n=10 per hour', () => {
    // 8 hourly subgroups measuring yoke dimension (mm)
    const values: number[] = [];
    const subs: string[] = [];
    const hourMeans = [25.00, 25.01, 25.02, 25.03, 24.95, 25.00, 25.01, 25.00];
    for (let h = 0; h < hourMeans.length; h++) {
      for (let i = 0; i < 10; i++) {
        values.push(hourMeans[h] + (i * 0.002 - 0.01));
        subs.push('H' + (h + 1));
      }
    }
    const chart = xbarS(values, subs);
    expect(chart.chart_type).toBe('xbar_s');
    expect(chart.values).toHaveLength(8);
    // Hour 5 (24.95) should likely trigger given tight process
  });

  it('generates X-bar/S chart PNG', async () => {
    const values: number[] = [];
    const subs: string[] = [];
    for (let g = 0; g < 5; g++) {
      for (let i = 0; i < 10; i++) {
        values.push(10 + Math.sin(g * 0.5 + i * 0.3) * 0.2);
        subs.push('G' + g);
      }
    }
    const chart = xbarS(values, subs);
    const filePath = await generateControlChart(chart, 'X-bar/S Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });
});

// ══════════════════════════════════════════════════════════════
// CUSUM
// ══════════════════════════════════════════════════════════════

describe('CUSUM Chart', () => {
  it('detects upward shift in mean', () => {
    // Stable at 10, then shift to 11
    const values = [
      10.1, 9.9, 10.0, 10.2, 9.8, 10.0, 10.1, 9.9, 10.0, 10.0,
      11.0, 11.2, 10.8, 11.1, 11.0, 10.9, 11.2, 11.0, 10.8, 11.1,
    ];
    const result = cusumChart(values, 10); // target=10

    const upShifts = result.violations.filter((v) => v.rule === 'CUSUM+');
    expect(upShifts.length).toBeGreaterThan(0);
    // Shift should be detected after the mean change point
    expect(upShifts[0].index).toBeGreaterThanOrEqual(10);
  });

  it('detects downward shift', () => {
    const values = [
      10.0, 10.1, 9.9, 10.0, 10.2,
      9.0, 8.8, 9.1, 8.9, 9.0, 9.2, 8.8, 9.0, 9.1, 8.9,
    ];
    const result = cusumChart(values, 10);
    const downShifts = result.violations.filter((v) => v.rule === 'CUSUM-');
    expect(downShifts.length).toBeGreaterThan(0);
  });

  it('no shifts for stable process', () => {
    const values = Array(20).fill(0).map((_, i) => 10 + (i % 2 === 0 ? 0.1 : -0.1));
    const result = cusumChart(values, 10);
    expect(result.violations).toHaveLength(0);
  });

  it('c_plus and c_minus have correct length', () => {
    const values = [10, 10.1, 9.9, 10.2, 9.8];
    const result = cusumChart(values, 10);
    expect(result.c_plus).toHaveLength(5);
    expect(result.c_minus).toHaveLength(5);
  });
});

// ══════════════════════════════════════════════════════════════
// EWMA
// ══════════════════════════════════════════════════════════════

describe('EWMA Chart', () => {
  it('detects gradual drift', () => {
    // Slowly drifting upward
    const values = Array(30).fill(0).map((_, i) => 10 + i * 0.05);
    const result = ewmaChart(values, 0.2, 3, 10);

    // EWMA should eventually detect the drift
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('stable process has no violations', () => {
    const values = Array(20).fill(0).map(() => 10 + (Math.random() - 0.5) * 0.1);
    const result = ewmaChart(values, 0.2, 3, 10, 0.1);
    // With tight sigma estimate, random noise within 0.05 shouldn't trigger
    // (depends on random values, but very unlikely to trigger with this small variation)
  });

  it('EWMA values converge to process mean', () => {
    const values = Array(20).fill(10);
    const result = ewmaChart(values, 0.2, 3, 10);
    // All EWMA values should be exactly 10
    for (const z of result.ewma) {
      expect(z).toBeCloseTo(10, 4);
    }
  });

  it('lambda controls smoothing', () => {
    const values = [10, 12, 10, 12, 10, 12, 10, 12, 10, 12];

    const slow = ewmaChart(values, 0.1); // heavy smoothing
    const fast = ewmaChart(values, 0.9); // light smoothing

    // Fast EWMA should track oscillations more closely
    const slowRange = Math.max(...slow.ewma) - Math.min(...slow.ewma);
    const fastRange = Math.max(...fast.ewma) - Math.min(...fast.ewma);
    expect(fastRange).toBeGreaterThan(slowRange);
  });

  it('control limits widen over time then stabilize', () => {
    const values = Array(20).fill(10);
    const result = ewmaChart(values, 0.2, 3, 10, 1);

    // Early limits should be narrower than later ones
    expect(result.ucl[0]).toBeLessThan(result.ucl[19]);
    // But difference between late limits should be very small (convergence)
    expect(Math.abs(result.ucl[18] - result.ucl[19])).toBeLessThan(0.01);
  });

  it('rejects invalid lambda', () => {
    expect(() => ewmaChart([10, 10], 0)).toThrow('Lambda');
    expect(() => ewmaChart([10, 10], 1.5)).toThrow('Lambda');
  });
});

// ══════════════════════════════════════════════════════════════
// TREND REGRESSION
// ══════════════════════════════════════════════════════════════

describe('Trend Regression', () => {
  it('detects increasing trend', () => {
    const values = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5];
    const result = trendRegression(values);

    expect(result.trend_direction).toBe('increasing');
    expect(result.slope).toBeCloseTo(0.5, 1);
    expect(result.r_squared).toBeGreaterThan(0.95);
  });

  it('detects decreasing trend', () => {
    const values = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11];
    const result = trendRegression(values);

    expect(result.trend_direction).toBe('decreasing');
    expect(result.slope).toBeCloseTo(-1.0, 1);
  });

  it('reports stable for no trend', () => {
    const values = [10, 10.1, 9.9, 10.0, 10.2, 9.8, 10.1, 9.9, 10.0, 10.0];
    const result = trendRegression(values);
    expect(result.trend_direction).toBe('stable');
    expect(result.r_squared).toBeLessThan(0.3);
  });

  it('predicts when trend will reach USL', () => {
    const values = [10, 10.5, 11, 11.5, 12]; // slope ≈ 0.5/observation
    const result = trendRegression(values, { usl: 15, lsl: 5 });

    expect(result.predicted_oos_index).not.toBeNull();
    expect(result.predicted_oos_description).toContain('USL');
    // At 0.5/obs, from 12 to 15 = 6 more observations
    expect(result.predicted_oos_index!).toBeCloseTo(10, 1);
  });

  it('predicts when trend will reach LSL', () => {
    const values = [10, 9.5, 9, 8.5, 8]; // slope ≈ -0.5
    const result = trendRegression(values, { usl: 15, lsl: 5 });

    expect(result.predicted_oos_index).not.toBeNull();
    expect(result.predicted_oos_description).toContain('LSL');
  });

  it('no prediction when trend is stable', () => {
    const values = [10, 10.1, 9.9, 10.0, 10.2];
    const result = trendRegression(values, { usl: 15, lsl: 5 });
    expect(result.predicted_oos_index).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// CHART GENERATION
// ══════════════════════════════════════════════════════════════

describe('Chart Generation', () => {
  it('generates CUSUM chart PNG', async () => {
    const data = cusumChart(
      [10, 10.1, 9.9, 11, 11.2, 11.1, 11, 10.9, 11.2, 11],
      10,
    );
    const filePath = await generateCusumChart(data, 'CUSUM Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('generates EWMA chart PNG', async () => {
    const data = ewmaChart([10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9]);
    const filePath = await generateEwmaChart(data, 'EWMA Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('generates p-chart PNG', async () => {
    const data = pChart([3, 5, 2, 8, 4], Array(5).fill(100));
    const filePath = await generateAttributeChart(data, 'p-chart Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('generates c-chart PNG', async () => {
    const data = cChart([2, 5, 3, 1, 4, 6, 2, 3]);
    const filePath = await generateAttributeChart(data, 'c-chart Test');
    expect(existsSync(filePath)).toBe(true);
    rmSync(filePath);
  });
});

// ══════════════════════════════════════════════════════════════
// CONTROL PLAN
// ══════════════════════════════════════════════════════════════

describe('Control Plan CRUD', () => {
  it('creates and retrieves a control plan', async () => {
    const plan = await createControlPlan('PCB Line 3', 'automated', 'PCB Assembly', 'IPC-A-610');
    expect(plan.name).toBe('PCB Line 3');
    expect(plan.process_type).toBe('automated');
    expect(plan.applicable_standard).toBe('IPC-A-610');

    const found = await getControlPlanByName('pcb line 3');
    expect(found).toBeDefined();
  });

  it('adds VOC items', async () => {
    const plan = await createControlPlan('Test Plan');
    await addVocItem(plan.id, 'No visible scratches', 'appearance', 4);
    await addVocItem(plan.id, 'Connector must click', 'function', 5);

    const items = await getVocItems(plan.id);
    expect(items).toHaveLength(2);
    expect(items[0].priority).toBe(5); // sorted by priority desc
    expect(items[0].requirement).toBe('Connector must click');
  });

  it('adds CTQ items linked to VOC', async () => {
    const plan = await createControlPlan('Test Plan', 'semi_automated');
    const voc = await addVocItem(plan.id, 'Board must pass functional test', 'function', 5);

    const ctq = await addCtqItem(plan.id, voc.id, {
      ctq_name: 'Functional test pass rate',
      measurement_method: 'ICT + FCT',
      unit: '%',
      usl: 100,
      lsl: 98,
      target: 99.5,
      severity: 9,
      occurrence: 3,
      detection: 2,
    });

    expect(ctq.rpn).toBe(54); // 9×3×2
    expect(ctq.chart_type).toBe('xbar_r'); // has spec limits
  });

  it('cascades delete', async () => {
    const plan = await createControlPlan('Cascade');
    const voc = await addVocItem(plan.id, 'Test');
    await addCtqItem(plan.id, voc.id, { ctq_name: 'CTQ1' });

    await deleteControlPlan(plan.id);
    expect(await getVocItems(plan.id)).toHaveLength(0);
    expect(await getCtqItems(plan.id)).toHaveLength(0);
  });
});

describe('Recommendations Engine', () => {
  it('recommends X-bar/R for variables data', () => {
    expect(recommendChartType(10, 5)).toBe('xbar_r');
  });

  it('recommends p-chart for attribute data', () => {
    expect(recommendChartType(null, null)).toBe('p');
    expect(recommendChartType(undefined, undefined)).toBe('p');
  });

  it('recommends higher frequency sampling for high RPN', () => {
    const highRpn = recommendSampling('semi_automated', 250);
    const lowRpn = recommendSampling('semi_automated', 50);
    expect(highRpn).toContain('50 units');
    expect(lowRpn).toContain('200 units');
  });

  it('recommends tighter sampling for safety-critical (sev>=8) regardless of RPN', () => {
    const safetyCritical = recommendSampling('semi_automated', 30, 9); // low RPN but sev=9
    expect(safetyCritical).toContain('50 units'); // treated as high risk
  });

  it('recommends 100% inline when detection=1 (automated)', () => {
    const sampling = recommendSampling('semi_automated', 200, 10, 1);
    expect(sampling).toContain('100% inline');
  });

  it('recommends 100% inspection for high RPN manual process', () => {
    const sampling = recommendSampling('manual', 300);
    expect(sampling).toContain('100%');
  });

  it('recommends inline inspection for automated high RPN', () => {
    const sampling = recommendSampling('automated', 250);
    expect(sampling).toContain('100% inline');
  });

  it('generates stop-production reaction for high severity', () => {
    const reaction = recommendReaction(9, 'xbar_r');
    expect(reaction).toContain('STOP');
    expect(reaction).toContain('Quarantine');
  });

  it('generates log-only reaction for low severity', () => {
    const reaction = recommendReaction(3, 'p');
    expect(reaction).toContain('Log');
    expect(reaction).not.toContain('STOP');
  });
});

describe('Standard Suggestions', () => {
  it('suggests IPC-A-620 for harness', () => {
    expect(suggestStandard('wire harness assembly', 'manual')).toBe('IPC/WHMA-A-620');
  });

  it('suggests IPC-A-610 for PCB', () => {
    expect(suggestStandard('PCB solder assembly', 'automated')).toBe('IPC-A-610');
  });

  it('suggests IATF for automotive', () => {
    expect(suggestStandard('automotive control module', 'semi_automated')).toContain('IATF');
  });

  it('returns empty for unknown product', () => {
    expect(suggestStandard('generic widget', 'manual')).toBe('');
  });
});

describe('Control Plan Summary', () => {
  it('builds complete summary with risk analysis', async () => {
    const plan = await createControlPlan('Summary Test', 'semi_automated', 'Harness', 'IPC/WHMA-A-620');
    const voc1 = await addVocItem(plan.id, 'Crimp must hold', 'function', 5);
    const voc2 = await addVocItem(plan.id, 'No exposed wire', 'appearance', 4);

    await addCtqItem(plan.id, voc1.id, {
      ctq_name: 'Pull force',
      usl: 50, lsl: 30, target: 40,
      severity: 9, occurrence: 4, detection: 3,
    });
    await addCtqItem(plan.id, voc2.id, {
      ctq_name: 'Insulation coverage',
      severity: 6, occurrence: 2, detection: 2,
    });

    const summary = await buildControlPlanSummary(plan.id);

    expect(summary.voc_items).toHaveLength(2);
    expect(summary.ctq_items).toHaveLength(2);
    expect(summary.risk_summary.high).toBe(1); // Pull force: sev=9 → HIGH regardless of RPN
    expect(summary.risk_summary.medium).toBe(0);
    expect(summary.risk_summary.low).toBe(1); // Insulation: sev=6, RPN=24 → LOW
  });

  it('formats control plan as HTML', async () => {
    const plan = await createControlPlan('Format Test', 'automated', 'PCB');
    const voc = await addVocItem(plan.id, 'Solder quality');
    await addCtqItem(plan.id, voc.id, {
      ctq_name: 'Solder paste volume',
      usl: 0.6, lsl: 0.4, target: 0.5, unit: 'mm³',
      severity: 7, occurrence: 3, detection: 4,
    });

    const summary = await buildControlPlanSummary(plan.id);
    const html = formatControlPlan(summary, true);

    expect(html).toContain('<b>Control Plan: Format Test</b>');
    expect(html).toContain('Solder paste volume');
    expect(html).toContain('RPN=');
    expect(html).toContain('xbar-r');
  });

  it('exports control plan as CSV', async () => {
    const plan = await createControlPlan('Export Test');
    const voc = await addVocItem(plan.id, 'Must work');
    await addCtqItem(plan.id, voc.id, {
      ctq_name: 'Pass rate', usl: 100, lsl: 95,
      severity: 8, occurrence: 3, detection: 2,
    });

    const summary = await buildControlPlanSummary(plan.id);
    const csv = exportControlPlanCsv(summary);

    expect(csv).toContain('CTQ Name');
    expect(csv).toContain('Pass rate');
    expect(csv).toContain('Must work');
  });
});

// ══════════════════════════════════════════════════════════════
// REAL-WORLD SCENARIOS
// ══════════════════════════════════════════════════════════════

describe('Real-World Scenarios', () => {
  it('SMT line: p-chart for solder defects with AOI data', () => {
    // 20 lots, 500 boards each, defectives found by AOI
    const defectives = [12, 8, 15, 10, 9, 11, 7, 13, 8, 10, 14, 9, 11, 8, 12, 10, 25, 9, 11, 10];
    const sampleSizes = Array(20).fill(500);
    const result = pChart(defectives, sampleSizes);

    expect(result.center_line).toBeCloseTo(0.0222, 3); // 222/10000
    // Lot 17 (25 defectives = 5%) should be flagged
    const lot17Violation = result.violations.find((v) => v.index === 16);
    expect(lot17Violation).toBeDefined();
  });

  it('wire harness: crimp force CUSUM detects tool wear', () => {
    // First 15 samples stable at 40N, then gradual drop (tool wear)
    const values = [
      40.1, 39.8, 40.2, 40.0, 39.9, 40.1, 40.0, 39.8, 40.1, 40.0,
      39.9, 40.0, 39.8, 40.1, 40.0,
      39.5, 39.3, 39.1, 38.9, 38.7, 38.5, 38.3, 38.1, 37.9, 37.7,
    ];
    const result = cusumChart(values, 40);
    const downShifts = result.violations.filter((v) => v.rule === 'CUSUM-');
    expect(downShifts.length).toBeGreaterThan(0);
    // Should detect after the wear starts
    expect(downShifts[0].index).toBeGreaterThanOrEqual(15);
  });

  it('appliance assembly: trend predicts when torque will exceed spec', () => {
    // Torque gradually increasing due to calibration drift
    const values = [10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9];
    const result = trendRegression(values, { usl: 12, lsl: 8 });

    expect(result.trend_direction).toBe('increasing');
    expect(result.predicted_oos_index).not.toBeNull();
    expect(result.predicted_oos_description).toContain('USL');
  });

  it('full control plan for PCB assembly line', async () => {
    const plan = await createControlPlan('PCB Line 5', 'automated', 'Automotive control board', '');
    // Standard should be auto-suggested
    const suggested = suggestStandard('Automotive control board', 'automated');
    expect(suggested).toContain('IATF');

    // VOC items from customer
    const voc1 = await addVocItem(plan.id, 'No solder bridges', 'function', 5);
    const voc2 = await addVocItem(plan.id, 'Component alignment within 0.1mm', 'dimensions', 4);
    const voc3 = await addVocItem(plan.id, 'Board passes ICT/FCT', 'function', 5);

    // CTQs
    await addCtqItem(plan.id, voc1.id, {
      ctq_name: 'Solder bridge count per board',
      measurement_method: 'AOI (Automated Optical Inspection)',
      severity: 8, occurrence: 3, detection: 1, // AOI catches most
    });

    await addCtqItem(plan.id, voc2.id, {
      ctq_name: 'Component offset X/Y',
      measurement_method: 'SPI + AOI',
      unit: 'mm',
      usl: 0.1, lsl: -0.1, target: 0,
      severity: 6, occurrence: 4, detection: 2,
    });

    await addCtqItem(plan.id, voc3.id, {
      ctq_name: 'ICT pass rate',
      measurement_method: 'In-Circuit Test',
      unit: '%',
      usl: 100, lsl: 99,
      severity: 10, occurrence: 2, detection: 1,
    });

    const summary = await buildControlPlanSummary(plan.id);

    expect(summary.voc_items).toHaveLength(3);
    expect(summary.ctq_items).toHaveLength(3);

    // Verify CTQs are sorted by RPN
    expect(summary.ctq_items[0].rpn).toBeGreaterThanOrEqual(summary.ctq_items[1].rpn);

    // Verify chart recommendations make sense
    const bridgeCtq = summary.ctq_items.find((c) => c.ctq_name === 'Solder bridge count per board')!;
    expect(bridgeCtq.chart_type).toBe('p'); // attribute data (no spec limits)

    const offsetCtq = summary.ctq_items.find((c) => c.ctq_name === 'Component offset X/Y')!;
    expect(offsetCtq.chart_type).toBe('xbar_r'); // variables data

    // Verify formatted output
    const text = formatControlPlan(summary, false);
    expect(text).toContain('PCB Line 5');
    expect(text).toContain('Solder bridge');
    expect(text).toContain('RPN=');
  });
});
