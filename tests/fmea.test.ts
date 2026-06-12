import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  STORE_DIR: resolve(tmpdir(), 'luna-test-fmea'),
  config: { NODE_ENV: 'test' },
}));

import {
  initFmeaTables, createFmeaDoc, getFmeaDocByName, listFmeaDocs, deleteFmeaDoc,
  addFailureMode, getFailureModes, addAction, getActions, completeAction,
  calculateActionPriority, buildRiskMatrix, parseFmeaCsv, executeFmeaFromCsv,
  formatFmeaWorksheet, exportFmeaCsv,
  generateRiskHeatmap, generateRpnPareto, generateRpnTrend,
} from '../src/fmea.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initFmeaTables();
}

beforeEach(async () => {
  mkdirSync(resolve(tmpdir(), 'luna-test-fmea'), { recursive: true });
  await initTestDb();
});
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

const SMT_CSV = `process_step,failure_mode,effect,severity,cause,occurrence,detection_method,detection,current_controls
Solder paste print,Insufficient paste,Cold solder joints,8,Stencil clogged,4,SPI inspection,2,Regular stencil cleaning
Solder paste print,Excess paste,Solder bridges,7,Aperture too large,3,SPI inspection,2,Stencil design review
Component placement,Misalignment,Open circuit,8,Nozzle wear,5,AOI post-place,3,Nozzle maintenance schedule
Component placement,Wrong component,Board failure,10,Feeder error,2,AOI + barcode verify,1,Feeder verification procedure
Reflow,Cold joint,Intermittent failure,9,Profile too low,3,AOI post-reflow,3,Profile validation per recipe
Reflow,Tombstoning,Open circuit,7,Pad imbalance,4,AOI post-reflow,2,Design for manufacturing review
Wave solder,Bridging,Short circuit,8,Flux insufficient,3,Visual + AOI,4,Flux density monitoring
Cleaning,Residue remaining,Corrosion risk,6,Wash temp low,2,Ion chromatography,5,Temp monitoring
ICT,False fail,Yield loss,4,Fixture wear,3,Fixture calibration,4,Monthly calibration
Final test,Undetected defect,Field failure,10,Test coverage gap,2,Test coverage analysis,6,Annual test review`;

// ── Action Priority Tests ────────────────────────────────────

describe('Action Priority (AIAG-VDA)', () => {
  it('severity >= 9 → HIGH regardless', () => {
    expect(calculateActionPriority(9, 1, 1)).toBe('H');
    expect(calculateActionPriority(10, 1, 1)).toBe('H');
  });

  it('high combined risk → HIGH', () => {
    expect(calculateActionPriority(5, 4, 7)).toBe('H');
  });

  it('RPN >= 200 → HIGH', () => {
    expect(calculateActionPriority(5, 5, 8)).toBe('H'); // RPN=200
  });

  it('medium risk → MEDIUM', () => {
    expect(calculateActionPriority(5, 4, 3)).toBe('M');
    expect(calculateActionPriority(6, 2, 7)).toBe('M');
  });

  it('RPN >= 80 → MEDIUM', () => {
    expect(calculateActionPriority(4, 4, 5)).toBe('M'); // RPN=80
  });

  it('low risk → LOW', () => {
    expect(calculateActionPriority(3, 2, 3)).toBe('L');
    expect(calculateActionPriority(2, 2, 2)).toBe('L');
  });
});

// ── CSV Parsing ──────────────────────────────────────────────

describe('CSV Parsing', () => {
  it('parses SMT FMEA CSV', () => {
    const rows = parseFmeaCsv(SMT_CSV);
    expect(rows).toHaveLength(10);
    expect(rows[0].process_step).toBe('Solder paste print');
    expect(rows[0].severity).toBe(8);
    expect(rows[3].failure_mode).toBe('Wrong component');
    expect(rows[3].severity).toBe(10);
  });

  it('throws on missing required columns', () => {
    expect(() => parseFmeaCsv('step,mode\nA,B')).toThrow('process_step');
  });

  it('defaults S/O/D to 5 when not provided', () => {
    const rows = parseFmeaCsv('process_step,failure_mode\nWeld,Crack');
    expect(rows[0].severity).toBe(5);
    expect(rows[0].occurrence).toBe(5);
    expect(rows[0].detection).toBe(5);
  });

  it('handles BOM', () => {
    expect(parseFmeaCsv('\uFEFFprocess_step,failure_mode\nA,B')).toHaveLength(1);
  });
});

// ── Database CRUD ────────────────────────────────────────────

describe('Database CRUD', () => {
  it('creates and retrieves FMEA doc', async () => {
    const doc = await createFmeaDoc('SMT Line 3', 'pfmea', 'Control Board', 'SMT Assembly');
    expect(doc.fmea_type).toBe('pfmea');
    const found = await getFmeaDocByName('smt line 3');
    expect(found).toBeDefined();
    expect(found!.product).toBe('Control Board');
  });

  it('adds failure modes with auto-calculated RPN and AP', async () => {
    const doc = await createFmeaDoc('Test');
    const fm = await addFailureMode(doc.id, {
      process_step: 'Solder', failure_mode: 'Cold joint',
      severity: 9, occurrence: 3, detection: 3,
    });
    expect(fm.rpn).toBe(81); // 9×3×3
    expect(fm.action_priority).toBe('H'); // sev >= 9
  });

  it('failure modes sorted by RPN desc', async () => {
    const doc = await createFmeaDoc('Sort Test');
    await addFailureMode(doc.id, { process_step: 'A', failure_mode: 'Low', severity: 2, occurrence: 2, detection: 2 });
    await addFailureMode(doc.id, { process_step: 'B', failure_mode: 'High', severity: 9, occurrence: 5, detection: 5 });
    await addFailureMode(doc.id, { process_step: 'C', failure_mode: 'Med', severity: 5, occurrence: 5, detection: 5 });

    const fms = await getFailureModes(doc.id);
    expect(fms[0].failure_mode).toBe('High');
    expect(fms[0].rpn).toBeGreaterThan(fms[1].rpn);
    expect(fms[1].rpn).toBeGreaterThan(fms[2].rpn);
  });

  it('adds and retrieves action items', async () => {
    const doc = await createFmeaDoc('Action Test');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y', severity: 8, occurrence: 4, detection: 3 });
    const act = await addAction(fm.id, doc.id, 'Redesign fixture', 'John', '2026-04-01', fm.rpn);

    expect(act.status).toBe('open');
    expect(act.rpn_before).toBe(96);

    const acts = await getActions(doc.id);
    expect(acts).toHaveLength(1);
    expect(acts[0].owner).toBe('John');
  });

  it('completes action with new S/O/D and updates failure mode', async () => {
    const doc = await createFmeaDoc('Complete Test');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y', severity: 8, occurrence: 6, detection: 5 });
    const act = await addAction(fm.id, doc.id, 'Fix it', 'Jane', '', fm.rpn);

    const result = await completeAction(act.id, 8, 2, 2);
    expect(result).not.toBeNull();
    expect(result!.rpn_before).toBe(240);
    expect(result!.rpn_after).toBe(32); // 8×2×2
    expect(result!.status).toBe('completed');

    // Failure mode should be updated
    const fms = await getFailureModes(doc.id);
    expect(fms[0].rpn).toBe(32);
    expect(fms[0].occurrence).toBe(2);
  });

  it('cascades delete', async () => {
    const doc = await createFmeaDoc('Cascade');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y' });
    await addAction(fm.id, doc.id, 'Fix', '', '', fm.rpn);

    await deleteFmeaDoc(doc.id);
    expect(await getFailureModes(doc.id)).toHaveLength(0);
    expect(await getActions(doc.id)).toHaveLength(0);
  });
});

// ── Risk Matrix ──────────────────────────────────────────────

describe('Risk Matrix', () => {
  it('groups failure modes by severity × occurrence', async () => {
    const doc = await createFmeaDoc('Matrix');
    await addFailureMode(doc.id, { process_step: 'A', failure_mode: 'FM1', severity: 8, occurrence: 4 });
    await addFailureMode(doc.id, { process_step: 'B', failure_mode: 'FM2', severity: 8, occurrence: 4 });
    await addFailureMode(doc.id, { process_step: 'C', failure_mode: 'FM3', severity: 5, occurrence: 2 });

    const fms = await getFailureModes(doc.id);
    const matrix = buildRiskMatrix(fms);

    const cell84 = matrix.find((c) => c.severity === 8 && c.occurrence === 4);
    expect(cell84).toBeDefined();
    expect(cell84!.count).toBe(2);
    expect(cell84!.failure_modes).toContain('FM1');
    expect(cell84!.failure_modes).toContain('FM2');
  });

  it('sorts by risk (S×O) descending', async () => {
    const doc = await createFmeaDoc('Sort');
    await addFailureMode(doc.id, { process_step: 'A', failure_mode: 'Low', severity: 2, occurrence: 1 });
    await addFailureMode(doc.id, { process_step: 'B', failure_mode: 'High', severity: 9, occurrence: 8 });

    const matrix = buildRiskMatrix(await getFailureModes(doc.id));
    expect(matrix[0].severity * matrix[0].occurrence).toBeGreaterThan(
      matrix[1].severity * matrix[1].occurrence,
    );
  });
});

// ── Full Pipeline ────────────────────────────────────────────

describe('Full Pipeline (CSV → FMEA)', () => {
  it('imports SMT FMEA and auto-generates actions for HIGH', async () => {
    const { doc, failureModes, actions } = await executeFmeaFromCsv(
      SMT_CSV, 'SMT PFMEA', 'pfmea', 'Control Board', 'SMT Assembly',
    );

    expect(doc.name).toBe('SMT PFMEA');
    expect(failureModes).toHaveLength(10);
    expect(failureModes[0].rpn).toBeGreaterThanOrEqual(failureModes[1].rpn); // sorted

    // HIGH priority items should have auto-generated actions
    const highFms = failureModes.filter((f) => f.action_priority === 'H');
    expect(highFms.length).toBeGreaterThan(0);
    expect(actions.length).toBe(highFms.length);

    // Verify specific known HIGH items
    const wrongComp = failureModes.find((f) => f.failure_mode === 'Wrong component')!;
    expect(wrongComp.severity).toBe(10);
    expect(wrongComp.action_priority).toBe('H');

    const coldJoint = failureModes.find((f) => f.failure_mode === 'Cold joint')!;
    expect(coldJoint.severity).toBe(9);
    expect(coldJoint.action_priority).toBe('H');

    const undetected = failureModes.find((f) => f.failure_mode === 'Undetected defect')!;
    expect(undetected.severity).toBe(10);
    expect(undetected.action_priority).toBe('H');
  });

  it('reuse existing doc on re-import', async () => {
    await executeFmeaFromCsv(SMT_CSV, 'Reuse Test');
    const { failureModes } = await executeFmeaFromCsv(SMT_CSV, 'Reuse Test');
    expect(failureModes).toHaveLength(10); // not 20
    expect((await listFmeaDocs()).filter((d) => d.name === 'Reuse Test')).toHaveLength(1);
  });
});

// ── Formatting ───────────────────────────────────────────────

describe('Formatting', () => {
  it('formats FMEA worksheet with all sections', async () => {
    const { doc, failureModes, actions } = await executeFmeaFromCsv(SMT_CSV, 'Format Test');
    const text = formatFmeaWorksheet(doc, failureModes, actions, false);

    expect(text).toContain('FMEA: Format Test');
    expect(text).toContain('PFMEA');
    expect(text).toContain('HIGH');
    expect(text).toContain('RPN=');
    expect(text).toContain('S=');
    expect(text).toContain('Effect:');
    expect(text).toContain('Cause:');
    expect(text).toContain('[Open]'); // auto-generated actions
  });

  it('formats as HTML', async () => {
    const doc = await createFmeaDoc('HTML');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y' });
    const text = formatFmeaWorksheet(doc, [fm], [], true);
    expect(text).toContain('<b>');
  });

  it('shows RPN reduction for completed actions', async () => {
    const doc = await createFmeaDoc('Reduction');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y', severity: 8, occurrence: 5, detection: 4 });
    const act = await addAction(fm.id, doc.id, 'Fix', 'Bob', '', fm.rpn);
    await completeAction(act.id, 8, 2, 2);

    const text = formatFmeaWorksheet(doc, await getFailureModes(doc.id), await getActions(doc.id), false);
    expect(text).toContain('160→32'); // RPN before→after
    expect(text).toContain('[Done]');
  });
});

// ── CSV Export ────────────────────────────────────────────────

describe('CSV Export', () => {
  it('exports with all columns', async () => {
    const { doc, failureModes, actions } = await executeFmeaFromCsv(SMT_CSV, 'Export Test');
    const csv = exportFmeaCsv(doc, failureModes, actions);
    const lines = csv.split('\n');

    expect(lines[0]).toContain('Process Step');
    expect(lines[0]).toContain('RPN');
    expect(lines[0]).toContain('Action Priority');
    expect(lines[0]).toContain('Recommended Action');
    expect(lines.length).toBeGreaterThan(10); // header + 10 FMs (some with actions)
  });

  it('includes action details in export', async () => {
    const doc = await createFmeaDoc('ActExport');
    const fm = await addFailureMode(doc.id, { process_step: 'X', failure_mode: 'Y', severity: 9 });
    await addAction(fm.id, doc.id, 'Redesign', 'Alice', '2026-05-01', fm.rpn);

    const csv = exportFmeaCsv(doc, await getFailureModes(doc.id), await getActions(doc.id));
    expect(csv).toContain('Redesign');
    expect(csv).toContain('Alice');
    expect(csv).toContain('2026-05-01');
  });
});

// ── Chart Generation ─────────────────────────────────────────

describe('Chart Generation', () => {
  it('generates risk heatmap PNG', async () => {
    const { failureModes } = await executeFmeaFromCsv(SMT_CSV, 'Heatmap Test');
    const filePath = await generateRiskHeatmap(failureModes, 'Heatmap Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('generates RPN Pareto PNG', async () => {
    const { failureModes } = await executeFmeaFromCsv(SMT_CSV, 'Pareto Test');
    const filePath = await generateRpnPareto(failureModes, 'Pareto Test');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('generates RPN trend PNG after completing actions', async () => {
    const doc = await createFmeaDoc('Trend');
    const fm1 = await addFailureMode(doc.id, { process_step: 'A', failure_mode: 'F1', severity: 8, occurrence: 5, detection: 4 });
    const fm2 = await addFailureMode(doc.id, { process_step: 'B', failure_mode: 'F2', severity: 7, occurrence: 4, detection: 5 });
    const a1 = await addAction(fm1.id, doc.id, 'Fix 1', '', '', fm1.rpn);
    const a2 = await addAction(fm2.id, doc.id, 'Fix 2', '', '', fm2.rpn);
    await completeAction(a1.id, 8, 2, 2);
    await completeAction(a2.id, 7, 2, 2);

    const filePath = await generateRpnTrend(await getActions(doc.id), 'Trend');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });
});

// ── Real-World Scenarios ─────────────────────────────────────

describe('Real-World Scenarios', () => {
  it('SMT assembly PFMEA: correct risk distribution', async () => {
    const { failureModes } = await executeFmeaFromCsv(SMT_CSV, 'SMT Validation');

    const high = failureModes.filter((f) => f.action_priority === 'H');
    const med = failureModes.filter((f) => f.action_priority === 'M');
    const low = failureModes.filter((f) => f.action_priority === 'L');

    // Items with severity >= 9 should be HIGH
    for (const fm of failureModes) {
      if (fm.severity >= 9) expect(fm.action_priority).toBe('H');
    }

    // Should have a mix of risk levels
    expect(high.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);
    // Total should be 10
    expect(high.length + med.length + low.length).toBe(10);
  });

  it('action completion reduces RPN and updates failure mode', async () => {
    const { doc, failureModes } = await executeFmeaFromCsv(SMT_CSV, 'Action Flow');

    // Find the highest RPN failure mode
    const topFm = failureModes[0];
    const originalRpn = topFm.rpn;

    // Add a corrective action
    const act = await addAction(topFm.id, doc.id,
      'Implement poka-yoke on feeder loading', 'Quality Eng', '2026-04-15', topFm.rpn);

    // Complete with improved scores
    const result = await completeAction(act.id, topFm.severity, 1, 1);
    expect(result!.rpn_after!).toBeLessThan(originalRpn);

    // Verify the failure mode is updated in DB
    const updatedFms = await getFailureModes(doc.id);
    const updatedFm = updatedFms.find((f) => f.id === topFm.id)!;
    expect(updatedFm.rpn).toBe(result!.rpn_after);
    expect(updatedFm.rpn).toBeLessThan(originalRpn);
  });

  it('full FMEA lifecycle: create → add → action → complete → report', async () => {
    // 1. Create
    const doc = await createFmeaDoc('Lifecycle Test', 'pfmea', 'Harness', 'Crimp Process');

    // 2. Add failure modes
    await addFailureMode(doc.id, {
      process_step: 'Wire strip', failure_mode: 'Nick in conductor',
      effect: 'Reduced current capacity', severity: 7, cause: 'Blade wear',
      occurrence: 4, detection_method: 'Visual + pull test', detection: 5,
    });
    const fm2 = await addFailureMode(doc.id, {
      process_step: 'Terminal crimp', failure_mode: 'Crimp too loose',
      effect: 'Intermittent connection', severity: 9, cause: 'Die wear',
      occurrence: 3, detection_method: 'Crimp force monitor', detection: 2,
    });

    // 3. Add actions for high-risk item
    const act = await addAction(fm2.id, doc.id,
      'Replace crimp die set and implement preventive schedule', 'Maint Lead', '2026-04-01', fm2.rpn);

    // 4. Complete action
    await completeAction(act.id, 9, 1, 2); // occurrence reduced from 3→1

    // 5. Generate report
    const fms = await getFailureModes(doc.id);
    const acts = await getActions(doc.id);
    const report = formatFmeaWorksheet(doc, fms, acts, false);

    expect(report).toContain('Lifecycle Test');
    expect(report).toContain('PFMEA');
    expect(report).toContain('Nick in conductor');
    expect(report).toContain('Crimp too loose');
    expect(report).toContain('[Done]');
    expect(report).toContain('54→18'); // RPN 9×3×2=54 → 9×1×2=18

    // 6. CSV export
    const csv = exportFmeaCsv(doc, fms, acts);
    expect(csv).toContain('Terminal crimp');
    expect(csv).toContain('Replace crimp die');
  });
});
