import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = resolve(tmpdir(), 'clauded-test-rca');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'rca-test.db');

let db: Database.Database;

vi.mock('../src/db.js', () => ({ getDatabase: () => db }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'clauded-test-rca'),
  config: { NODE_ENV: 'test' },
}));

import {
  initRcaTables, createRcaDoc, getRcaDocByName, listRcaDocs, deleteRcaDoc,
  addRcaNode, getRcaNodes,
  build5Whys, buildFishbone, buildPdca, buildFaultTree, buildMindMap,
  generateMermaidSyntax, formatRcaDocument, generateA3Pdf,
  render5WhysPng, renderFishbonePng, renderPdcaPng, renderFtaPng, renderMindMapPng,
  type FishboneCategory, type PdcaCycle,
} from '../src/rca.js';

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initRcaTables();
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ── CRUD Tests ───────────────────────────────────────────────

describe('Database CRUD', () => {
  it('creates and retrieves RCA doc', () => {
    const doc = createRcaDoc('Solder Issue', '5why', 'Solder bridges on Board X');
    expect(doc.method).toBe('5why');
    const found = getRcaDocByName('solder issue');
    expect(found).toBeDefined();
  });

  it('adds and retrieves nodes', () => {
    const doc = createRcaDoc('Test', '5why');
    const root = addRcaNode(doc.id, null, 'root', 'Problem', '', '', 0);
    addRcaNode(doc.id, root.id, 'why', 'Cause 1', '', '', 1);
    const nodes = getRcaNodes(doc.id);
    expect(nodes).toHaveLength(2);
  });

  it('cascades delete', () => {
    const doc = createRcaDoc('Del', '5why');
    addRcaNode(doc.id, null, 'root', 'P');
    deleteRcaDoc(doc.id);
    expect(getRcaNodes(doc.id)).toHaveLength(0);
  });
});

// ── 5 Whys Tests ─────────────────────────────────────────────

describe('5 Whys', () => {
  it('builds a chain of whys', () => {
    const doc = createRcaDoc('5Why Test', '5why', 'Machine stopped');
    const { root, chain } = build5Whys(doc.id, 'Machine stopped', [
      'Fuse blew',
      'Overload on circuit',
      'Bearing seized',
      'Insufficient lubrication',
      'No maintenance schedule',
    ]);
    expect(chain).toHaveLength(6); // root + 5 whys
    expect(chain[0].node_type).toBe('root');
    expect(chain[5].label).toBe('No maintenance schedule');
    expect(chain[5].level).toBe(5);
  });

  it('generates mermaid syntax', () => {
    const doc = createRcaDoc('Mermaid 5W', '5why');
    build5Whys(doc.id, 'Defect found', ['Cause A', 'Cause B']);
    const nodes = getRcaNodes(doc.id);
    const mermaid = generateMermaidSyntax(doc, nodes);
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('Defect found');
    expect(mermaid).toContain('Why 1');
  });

  it('formats as text', () => {
    const doc = createRcaDoc('Format 5W', '5why', 'Board failed');
    build5Whys(doc.id, 'Board failed', ['Cold solder', 'Profile wrong']);
    const text = formatRcaDocument(doc, getRcaNodes(doc.id), false);
    expect(text).toContain('5 Whys');
    expect(text).toContain('Problem:');
    expect(text).toContain('Root Cause:');
    expect(text).toContain('Profile wrong');
  });
});

// ── Fishbone Tests ───────────────────────────────────────────

describe('Fishbone / Ishikawa', () => {
  it('builds 6M categorized structure', () => {
    const doc = createRcaDoc('Fish Test', 'fishbone', 'Solder bridges');
    const { root, nodes } = buildFishbone(doc.id, 'Solder bridges', [
      { category: 'Machine', cause: 'Stencil worn', sub_causes: ['Aperture enlarged', 'Fiducial shift'] },
      { category: 'Method', cause: 'Print speed too fast' },
      { category: 'Material', cause: 'Paste expired', sub_causes: ['Viscosity changed'] },
      { category: 'Man', cause: 'Operator untrained' },
    ]);
    expect(root.label).toBe('Solder bridges');
    const categories = nodes.filter((n) => n.node_type === 'category');
    expect(categories).toHaveLength(4);
    const subCauses = nodes.filter((n) => n.level === 3);
    expect(subCauses).toHaveLength(3);
  });

  it('generates mermaid syntax', () => {
    const doc = createRcaDoc('Mermaid Fish', 'fishbone');
    buildFishbone(doc.id, 'Defect', [{ category: 'Machine', cause: 'Worn tool' }]);
    const mermaid = generateMermaidSyntax(doc, getRcaNodes(doc.id));
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('Machine');
    expect(mermaid).toContain('EFFECT');
  });
});

// ── PDCA Tests ───────────────────────────────────────────────

describe('PDCA', () => {
  it('builds cycle with all 4 phases', () => {
    const doc = createRcaDoc('PDCA Test', 'pdca');
    const cycle: PdcaCycle = {
      plan: ['Define problem', 'Set target'],
      do_items: ['Implement fix', 'Train operators'],
      check: ['Measure results', 'Compare to target'],
      act: ['Standardize if good', 'Revise if not'],
    };
    const nodes = buildPdca(doc.id, cycle);
    expect(nodes).toHaveLength(1 + 4 + 8); // root + 4 phases + 8 items

    const phases = nodes.filter((n) => ['plan', 'do', 'check', 'act'].includes(n.node_type));
    expect(phases).toHaveLength(4);
  });

  it('generates mermaid syntax', () => {
    const doc = createRcaDoc('Mermaid PDCA', 'pdca');
    buildPdca(doc.id, { plan: ['A'], do_items: ['B'], check: ['C'], act: ['D'] });
    const mermaid = generateMermaidSyntax(doc, getRcaNodes(doc.id));
    expect(mermaid).toContain('PLAN');
    expect(mermaid).toContain('DO');
    expect(mermaid).toContain('CHECK');
    expect(mermaid).toContain('ACT');
    expect(mermaid).toContain('Repeat');
  });
});

// ── Fault Tree Tests ─────────────────────────────────────────

describe('Fault Tree', () => {
  it('builds tree with AND/OR gates', () => {
    const doc = createRcaDoc('FTA Test', 'fta', 'System failure');
    const nodes = buildFaultTree(doc.id, 'System failure', [
      { gate_type: 'or', label: 'Power loss', events: ['Fuse blown', 'Cable disconnected'] },
      { gate_type: 'and', label: 'Overload', parent_label: 'Power loss', events: ['High current', 'No protection'] },
    ]);

    const root = nodes.find((n) => n.node_type === 'root');
    expect(root!.label).toBe('System failure');

    const gates = nodes.filter((n) => n.node_type.startsWith('gate_'));
    expect(gates).toHaveLength(2);
    expect(gates[0].category).toBe('or');
    expect(gates[1].category).toBe('and');
  });

  it('generates mermaid syntax', () => {
    const doc = createRcaDoc('Mermaid FTA', 'fta');
    buildFaultTree(doc.id, 'Top Event', [
      { gate_type: 'or', label: 'Gate 1', events: ['E1', 'E2'] },
    ]);
    const mermaid = generateMermaidSyntax(doc, getRcaNodes(doc.id));
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('TOP');
    expect(mermaid).toContain('OR');
  });
});

// ── Mind Map Tests ───────────────────────────────────────────

describe('Mind Map', () => {
  it('builds radial structure', () => {
    const doc = createRcaDoc('MM Test', 'mindmap');
    const nodes = buildMindMap(doc.id, 'Quality Improvement', [
      { topic: 'Reduce Defects', subtopics: ['SPC', 'Poka-yoke', 'Training'] },
      { topic: 'Increase Throughput', subtopics: ['Line balance', 'Bottleneck analysis'] },
      { topic: 'Cost Reduction', subtopics: ['Waste elimination', 'Inventory optimization'] },
    ]);

    const root = nodes.find((n) => n.node_type === 'root');
    expect(root!.label).toBe('Quality Improvement');
    const branches = nodes.filter((n) => n.node_type === 'branch');
    expect(branches).toHaveLength(3);
    const topics = nodes.filter((n) => n.node_type === 'topic');
    // 3+2+2 = 7 subtopics across 3 branches
    expect(topics).toHaveLength(7);
  });

  it('generates mermaid syntax', () => {
    const doc = createRcaDoc('Mermaid MM', 'mindmap');
    buildMindMap(doc.id, 'Center', [{ topic: 'Branch 1', subtopics: ['Sub A'] }]);
    const mermaid = generateMermaidSyntax(doc, getRcaNodes(doc.id));
    expect(mermaid).toContain('mindmap');
    expect(mermaid).toContain('Center');
    expect(mermaid).toContain('Branch 1');
  });
});

// ── Diagram Rendering Tests ──────────────────────────────────

describe('Diagram Rendering', () => {
  it('renders 5 Whys PNG', async () => {
    const doc = createRcaDoc('Render 5W', '5why');
    build5Whys(doc.id, 'Problem X', ['Cause 1', 'Cause 2', 'Root cause']);
    const filePath = await render5WhysPng(getRcaNodes(doc.id), 'Render 5W');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('renders Fishbone PNG', async () => {
    const doc = createRcaDoc('Render Fish', 'fishbone');
    buildFishbone(doc.id, 'Defect', [
      { category: 'Machine', cause: 'Worn tool', sub_causes: ['Age', 'No PM'] },
      { category: 'Man', cause: 'Untrained' },
      { category: 'Method', cause: 'Wrong sequence' },
    ]);
    const filePath = await renderFishbonePng(getRcaNodes(doc.id), 'Render Fish');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('renders PDCA PNG', async () => {
    const doc = createRcaDoc('Render PDCA', 'pdca');
    buildPdca(doc.id, { plan: ['Define'], do_items: ['Execute'], check: ['Measure'], act: ['Standardize'] });
    const filePath = await renderPdcaPng(getRcaNodes(doc.id), 'Render PDCA');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('renders FTA PNG', async () => {
    const doc = createRcaDoc('Render FTA', 'fta');
    buildFaultTree(doc.id, 'Failure', [
      { gate_type: 'or', label: 'Electrical', events: ['Short', 'Open'] },
    ]);
    const filePath = await renderFtaPng(getRcaNodes(doc.id), 'Render FTA');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });

  it('renders Mind Map PNG', async () => {
    const doc = createRcaDoc('Render MM', 'mindmap');
    buildMindMap(doc.id, 'Center Topic', [
      { topic: 'Branch A', subtopics: ['A1', 'A2'] },
      { topic: 'Branch B', subtopics: ['B1'] },
    ]);
    const filePath = await renderMindMapPng(getRcaNodes(doc.id), 'Render MM');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)[0]).toBe(0x89);
    rmSync(filePath);
  });
});

// ── A3 Report Tests ──────────────────────────────────────────

describe('A3 Report', () => {
  it('generates PDF file', async () => {
    const filePath = await generateA3Pdf({
      title: 'Solder Bridge Reduction',
      background: 'Line 3 has 5% solder bridge rate, up from 2% baseline.',
      current_condition: 'AOI catching 85% of bridges. 15% escape to ICT.',
      goal: 'Reduce solder bridge rate to < 1% within 30 days.',
      root_cause_analysis: '5 Whys identified stencil aperture design as root cause.',
      countermeasures: ['Redesign stencil apertures', 'Add SPI feedback loop', 'Train operators on paste handling'],
      implementation_plan: ['Week 1: Order new stencils', 'Week 2: Install + validate', 'Week 3: Monitor SPC', 'Week 4: Confirm results'],
      follow_up: ['Monthly stencil inspection', 'SPC chart review every shift', 'Quarterly FMEA update'],
    });
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain('.pdf');
    const buffer = readFileSync(filePath);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    rmSync(filePath);
  });
});

// ── Real-World Scenarios ─────────────────────────────────────

describe('Real-World Scenarios', () => {
  it('SMT solder bridge: full 5 Whys', () => {
    const doc = createRcaDoc('SMT Bridge 5W', '5why', 'Solder bridges detected at AOI');
    build5Whys(doc.id, 'Solder bridges detected at AOI', [
      'Excess solder paste on pads',
      'Stencil apertures are oversized',
      'Stencil was not updated after PCB revision',
      'No change management process for stencil updates',
      'Engineering change process does not include stencil review step',
    ]);
    const nodes = getRcaNodes(doc.id);
    expect(nodes).toHaveLength(6);
    expect(nodes[5].label).toContain('Engineering change process');
    const text = formatRcaDocument(doc, nodes, false);
    expect(text).toContain('Root Cause:');
  });

  it('wire harness: Ishikawa with 6M causes', () => {
    const doc = createRcaDoc('Harness Fishbone', 'fishbone', 'Intermittent connection failures');
    buildFishbone(doc.id, 'Intermittent connection failures', [
      { category: 'Man', cause: 'Operator fatigue', sub_causes: ['Long shifts', 'Poor lighting'] },
      { category: 'Machine', cause: 'Crimp press misaligned', sub_causes: ['Die wear', 'No calibration'] },
      { category: 'Method', cause: 'Wrong crimp height spec' },
      { category: 'Material', cause: 'Terminal plating defect' },
      { category: 'Measurement', cause: 'Pull test sample too small' },
      { category: 'Environment', cause: 'Humidity causing oxidation' },
    ]);
    const nodes = getRcaNodes(doc.id);
    const categories = nodes.filter((n) => n.node_type === 'category');
    expect(categories).toHaveLength(6); // all 6M covered
  });

  it('PDCA cycle for defect reduction project', () => {
    const doc = createRcaDoc('Defect PDCA', 'pdca');
    buildPdca(doc.id, {
      plan: ['Analyze Pareto of top defects', 'Set target: reduce from 5% to 1%', 'Assign team and timeline'],
      do_items: ['Install SPI feedback', 'New stencil design', 'Operator training'],
      check: ['Monitor SPC daily', 'Weekly defect rate review', 'Compare to 1% target'],
      act: ['Standardize new process', 'Update control plan', 'Share lessons learned'],
    });
    const nodes = getRcaNodes(doc.id);
    const items = nodes.filter((n) => n.level === 2);
    // 3+3+3+3 = 12 action items across 4 phases
    expect(items).toHaveLength(12);
  });

  it('FTA for field failure with nested gates', () => {
    const doc = createRcaDoc('Field Failure FTA', 'fta', 'Product fails in field');
    buildFaultTree(doc.id, 'Product fails in field', [
      { gate_type: 'or', label: 'Electrical failure', events: ['Solder joint crack', 'Component failure'] },
      { gate_type: 'or', label: 'Mechanical failure', events: ['Connector loosened', 'Enclosure cracked'] },
      { gate_type: 'and', label: 'Thermal + vibration', parent_label: 'Solder joint crack', events: ['Thermal cycling', 'Vibration stress'] },
    ]);
    const nodes = getRcaNodes(doc.id);
    const gates = nodes.filter((n) => n.node_type.startsWith('gate_'));
    expect(gates).toHaveLength(3);
  });
});
