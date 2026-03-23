import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDatabase } from './db.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// ── Types ────────────────────────────────────────────────────

export type RcaMethod = '5why' | 'fishbone' | 'pdca' | 'fta' | 'mindmap';

export interface RcaDocument {
  id: string;
  name: string;
  method: RcaMethod;
  problem_statement: string;
  created_at: number;
  updated_at: number;
}

export interface RcaNode {
  id: string;
  doc_id: string;
  parent_id: string | null;
  node_type: string; // 'root','why','category','cause','gate_and','gate_or','action','topic','branch'
  label: string;
  detail: string;
  category: string; // for fishbone: Man/Machine/Method/Material/Measurement/Environment
  level: number;
  created_at: number;
}

// PDCA cycle structure
export interface PdcaCycle {
  plan: string[];
  do_items: string[];
  check: string[];
  act: string[];
}

// A3 Report structure
export interface A3Report {
  title: string;
  background: string;
  current_condition: string;
  goal: string;
  root_cause_analysis: string;
  countermeasures: string[];
  implementation_plan: string[];
  follow_up: string[];
}

// ── Database ─────────────────────────────────────────────────

export function initRcaTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS rca_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '5why',
      problem_statement TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rca_nodes (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      parent_id TEXT,
      node_type TEXT NOT NULL DEFAULT 'cause',
      label TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      level INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES rca_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES rca_nodes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rca_nodes_doc ON rca_nodes(doc_id);
    CREATE INDEX IF NOT EXISTS idx_rca_nodes_parent ON rca_nodes(parent_id);
  `);
}

function genId(): string { return randomBytes(16).toString('hex'); }

// ── CRUD ─────────────────────────────────────────────────────

export function createRcaDoc(name: string, method: RcaMethod, problem: string = ''): RcaDocument {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO rca_documents (id, name, method, problem_statement, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, method, problem, now, now);
  return { id, name, method, problem_statement: problem, created_at: now, updated_at: now };
}

export function getRcaDocByName(name: string): RcaDocument | undefined {
  return getDatabase().prepare('SELECT * FROM rca_documents WHERE name = ? COLLATE NOCASE').get(name) as RcaDocument | undefined;
}

export function listRcaDocs(): RcaDocument[] {
  return getDatabase().prepare('SELECT * FROM rca_documents ORDER BY updated_at DESC').all() as RcaDocument[];
}

export function deleteRcaDoc(id: string): boolean {
  return getDatabase().prepare('DELETE FROM rca_documents WHERE id = ?').run(id).changes > 0;
}

export function addRcaNode(
  docId: string, parentId: string | null, nodeType: string, label: string,
  detail: string = '', category: string = '', level: number = 0,
): RcaNode {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO rca_nodes (id, doc_id, parent_id, node_type, label, detail, category, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, docId, parentId, nodeType, label, detail, category, level, now);
  db.prepare('UPDATE rca_documents SET updated_at = ? WHERE id = ?').run(now, docId);
  return { id, doc_id: docId, parent_id: parentId, node_type: nodeType, label, detail, category, level, created_at: now };
}

export function getRcaNodes(docId: string): RcaNode[] {
  return getDatabase().prepare('SELECT * FROM rca_nodes WHERE doc_id = ? ORDER BY level, created_at').all(docId) as RcaNode[];
}

// ── 5 Whys ───────────────────────────────────────────────────

/**
 * Build a 5 Whys chain. Returns the root node and the chain.
 * Exported for testing.
 */
export function build5Whys(
  docId: string, problem: string, whys: string[],
): { root: RcaNode; chain: RcaNode[] } {
  const root = addRcaNode(docId, null, 'root', problem, '', '', 0);
  const chain: RcaNode[] = [root];
  let parentId = root.id;

  for (let i = 0; i < whys.length; i++) {
    const node = addRcaNode(docId, parentId, 'why', whys[i], '', '', i + 1);
    chain.push(node);
    parentId = node.id;
  }

  return { root, chain };
}

// ── Ishikawa / Fishbone ──────────────────────────────────────

const FISHBONE_6M = ['Man', 'Machine', 'Method', 'Material', 'Measurement', 'Environment'] as const;
export type FishboneCategory = typeof FISHBONE_6M[number];

/**
 * Build an Ishikawa/Fishbone diagram structure.
 * Exported for testing.
 */
export function buildFishbone(
  docId: string, problem: string,
  causes: Array<{ category: FishboneCategory; cause: string; sub_causes?: string[] }>,
): { root: RcaNode; nodes: RcaNode[] } {
  const root = addRcaNode(docId, null, 'root', problem, '', '', 0);
  const nodes: RcaNode[] = [root];

  for (const c of causes) {
    const catNode = addRcaNode(docId, root.id, 'category', c.category, '', c.category, 1);
    nodes.push(catNode);

    const causeNode = addRcaNode(docId, catNode.id, 'cause', c.cause, '', c.category, 2);
    nodes.push(causeNode);

    if (c.sub_causes) {
      for (const sub of c.sub_causes) {
        nodes.push(addRcaNode(docId, causeNode.id, 'cause', sub, '', c.category, 3));
      }
    }
  }

  return { root, nodes };
}

// ── PDCA ─────────────────────────────────────────────────────

/**
 * Build a PDCA cycle document.
 * Exported for testing.
 */
export function buildPdca(docId: string, cycle: PdcaCycle): RcaNode[] {
  const nodes: RcaNode[] = [];
  const root = addRcaNode(docId, null, 'root', 'PDCA Cycle', '', '', 0);
  nodes.push(root);

  const phases = [
    { type: 'plan', items: cycle.plan, label: 'PLAN' },
    { type: 'do', items: cycle.do_items, label: 'DO' },
    { type: 'check', items: cycle.check, label: 'CHECK' },
    { type: 'act', items: cycle.act, label: 'ACT' },
  ];

  for (const phase of phases) {
    const phaseNode = addRcaNode(docId, root.id, phase.type, phase.label, '', '', 1);
    nodes.push(phaseNode);
    for (const item of phase.items) {
      nodes.push(addRcaNode(docId, phaseNode.id, 'action', item, '', phase.type, 2));
    }
  }

  return nodes;
}

// ── Fault Tree Analysis ──────────────────────────────────────

/**
 * Build a Fault Tree with AND/OR gate logic.
 * Exported for testing.
 */
export function buildFaultTree(
  docId: string, topEvent: string,
  gates: Array<{ gate_type: 'and' | 'or'; label: string; parent_label?: string; events: string[] }>,
): RcaNode[] {
  const nodes: RcaNode[] = [];
  const root = addRcaNode(docId, null, 'root', topEvent, '', '', 0);
  nodes.push(root);

  const labelToId = new Map<string, string>();
  labelToId.set(topEvent, root.id);

  for (const gate of gates) {
    const parentId = gate.parent_label ? labelToId.get(gate.parent_label) || root.id : root.id;
    const gateNode = addRcaNode(docId, parentId, `gate_${gate.gate_type}`, gate.label, '', gate.gate_type, 1);
    nodes.push(gateNode);
    labelToId.set(gate.label, gateNode.id);

    for (const event of gate.events) {
      const eventNode = addRcaNode(docId, gateNode.id, 'cause', event, '', '', 2);
      nodes.push(eventNode);
      labelToId.set(event, eventNode.id);
    }
  }

  return nodes;
}

// ── Mind Map ─────────────────────────────────────────────────

/**
 * Build a Mind Map brainstorm structure.
 * Exported for testing.
 */
export function buildMindMap(
  docId: string, centralTopic: string,
  branches: Array<{ topic: string; subtopics: string[] }>,
): RcaNode[] {
  const nodes: RcaNode[] = [];
  const root = addRcaNode(docId, null, 'root', centralTopic, '', '', 0);
  nodes.push(root);

  for (const branch of branches) {
    const branchNode = addRcaNode(docId, root.id, 'branch', branch.topic, '', '', 1);
    nodes.push(branchNode);
    for (const sub of branch.subtopics) {
      nodes.push(addRcaNode(docId, branchNode.id, 'topic', sub, '', '', 2));
    }
  }

  return nodes;
}

// ── Mermaid Syntax Generation ────────────────────────────────

/**
 * Generate Mermaid diagram syntax for any RCA method.
 * Users can paste this into any Mermaid renderer for interactive diagrams.
 * Exported for testing.
 */
export function generateMermaidSyntax(doc: RcaDocument, nodes: RcaNode[]): string {
  switch (doc.method) {
    case '5why': return mermaid5Whys(nodes);
    case 'fishbone': return mermaidFishbone(doc, nodes);
    case 'pdca': return mermaidPdca(nodes);
    case 'fta': return mermaidFta(nodes);
    case 'mindmap': return mermaidMindmap(nodes);
    default: return '%%{init: {"theme":"default"}}%%\ngraph TD\n  A[Unknown method]';
  }
}

function mermaid5Whys(nodes: RcaNode[]): string {
  const lines = ['graph TD'];
  const whyNodes = nodes.filter((n) => n.node_type === 'root' || n.node_type === 'why');
  for (let i = 0; i < whyNodes.length; i++) {
    const safe = sanitizeMermaid(whyNodes[i].label);
    const id = `N${i}`;
    if (i === 0) {
      lines.push(`  ${id}["🔴 ${safe}"]`);
    } else {
      lines.push(`  N${i - 1} -->|"Why ${i}?"| ${id}["${safe}"]`);
    }
  }
  // Style root red, last green (root cause)
  if (whyNodes.length > 1) {
    lines.push(`  style N0 fill:#e15759,color:white`);
    lines.push(`  style N${whyNodes.length - 1} fill:#59a14f,color:white`);
  }
  return lines.join('\n');
}

function mermaidFishbone(doc: RcaDocument, nodes: RcaNode[]): string {
  // Mermaid doesn't have native fishbone. Use a tree layout.
  const lines = ['graph LR'];
  const root = nodes.find((n) => n.node_type === 'root');
  if (!root) return 'graph TD\n  A[No data]';

  lines.push(`  EFFECT["🔴 ${sanitizeMermaid(root.label)}"]`);

  const categories = nodes.filter((n) => n.node_type === 'category');
  for (const cat of categories) {
    const catId = `CAT_${sanitizeMermaid(cat.label).replace(/\s/g, '_')}`;
    lines.push(`  ${catId}["📌 ${cat.label}"] --> EFFECT`);

    const causes = nodes.filter((n) => n.parent_id === cat.id);
    for (let ci = 0; ci < causes.length; ci++) {
      const causeId = `${catId}_C${ci}`;
      lines.push(`  ${causeId}["${sanitizeMermaid(causes[ci].label)}"] --> ${catId}`);

      const subCauses = nodes.filter((n) => n.parent_id === causes[ci].id);
      for (let si = 0; si < subCauses.length; si++) {
        lines.push(`  ${causeId}_S${si}["${sanitizeMermaid(subCauses[si].label)}"] --> ${causeId}`);
      }
    }
  }

  return lines.join('\n');
}

function mermaidPdca(nodes: RcaNode[]): string {
  const lines = ['graph TD'];
  const phases = ['plan', 'do', 'check', 'act'];
  const phaseEmoji: Record<string, string> = { plan: '📋', do: '⚙️', check: '🔍', act: '✅' };

  lines.push('  PLAN["📋 PLAN"] --> DO["⚙️ DO"]');
  lines.push('  DO --> CHECK["🔍 CHECK"]');
  lines.push('  CHECK --> ACT["✅ ACT"]');
  lines.push('  ACT -->|"Repeat"| PLAN');

  for (const phase of phases) {
    const phaseNode = nodes.find((n) => n.node_type === phase);
    if (!phaseNode) continue;
    const items = nodes.filter((n) => n.parent_id === phaseNode.id);
    const phaseId = phase.toUpperCase();
    for (let i = 0; i < items.length; i++) {
      lines.push(`  ${phaseId}_${i}["${sanitizeMermaid(items[i].label)}"] -.-> ${phaseId}`);
    }
  }

  lines.push('  style PLAN fill:#4e79a7,color:white');
  lines.push('  style DO fill:#f28e2b,color:white');
  lines.push('  style CHECK fill:#59a14f,color:white');
  lines.push('  style ACT fill:#e15759,color:white');

  return lines.join('\n');
}

function mermaidFta(nodes: RcaNode[]): string {
  const lines = ['graph TD'];
  const root = nodes.find((n) => n.node_type === 'root');
  if (!root) return 'graph TD\n  A[No data]';

  lines.push(`  TOP["🔴 ${sanitizeMermaid(root.label)}"]`);

  const gateNodes = nodes.filter((n) => n.node_type.startsWith('gate_'));
  for (let gi = 0; gi < gateNodes.length; gi++) {
    const gate = gateNodes[gi];
    const gateId = `G${gi}`;
    const gateSymbol = gate.category === 'and' ? '🔲 AND' : '🔷 OR';
    const parentId = gate.parent_id === root.id ? 'TOP' : `G${gateNodes.findIndex((g) => g.id === gate.parent_id)}`;
    lines.push(`  ${parentId} --> ${gateId}{"${gateSymbol}: ${sanitizeMermaid(gate.label)}"}`);

    const events = nodes.filter((n) => n.parent_id === gate.id && n.node_type === 'cause');
    for (let ei = 0; ei < events.length; ei++) {
      lines.push(`  ${gateId} --> ${gateId}_E${ei}["${sanitizeMermaid(events[ei].label)}"]`);
    }
  }

  lines.push('  style TOP fill:#e15759,color:white');
  return lines.join('\n');
}

function mermaidMindmap(nodes: RcaNode[]): string {
  // Use Mermaid mindmap syntax
  const lines = ['mindmap'];
  const root = nodes.find((n) => n.node_type === 'root');
  if (!root) return 'mindmap\n  No data';

  lines.push(`  root((${sanitizeMermaid(root.label)}))`);

  const branches = nodes.filter((n) => n.node_type === 'branch');
  for (const branch of branches) {
    lines.push(`    ${sanitizeMermaid(branch.label)}`);
    const subtopics = nodes.filter((n) => n.parent_id === branch.id);
    for (const sub of subtopics) {
      lines.push(`      ${sanitizeMermaid(sub.label)}`);
    }
  }

  return lines.join('\n');
}

function sanitizeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/[[\]{}()]/g, '').replace(/\n/g, ' ').substring(0, 60);
}

// ── Canvas Diagram Rendering ─────────────────────────────────

/**
 * Render a 5 Whys chain as PNG.
 * Exported for testing.
 */
export async function render5WhysPng(nodes: RcaNode[], docName: string): Promise<string> {
  const { createCanvas } = await import('canvas');
  const whyNodes = nodes.filter((n) => n.node_type === 'root' || n.node_type === 'why');
  const boxW = 320;
  const boxH = 50;
  const gap = 30;
  const padding = 40;
  const totalH = whyNodes.length * (boxH + gap) - gap + padding * 2 + 40;
  const canvas = createCanvas(boxW + padding * 2, totalH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`5 Whys: ${docName}`, canvas.width / 2, 25);

  for (let i = 0; i < whyNodes.length; i++) {
    const x = padding;
    const y = padding + 20 + i * (boxH + gap);

    // Box
    const isRoot = i === 0;
    const isLast = i === whyNodes.length - 1 && whyNodes.length > 1;
    ctx.fillStyle = isRoot ? '#e15759' : isLast ? '#59a14f' : '#4e79a7';
    ctx.beginPath();
    roundRect(ctx, x, y, boxW, boxH, 8);
    ctx.fill();

    // Text
    ctx.fillStyle = '#fff';
    ctx.font = isRoot ? 'bold 13px sans-serif' : '12px sans-serif';
    ctx.textAlign = 'center';
    const label = isRoot ? `PROBLEM: ${whyNodes[i].label}` : `Why ${i}: ${whyNodes[i].label}`;
    ctx.fillText(truncate(label, 42), x + boxW / 2, y + boxH / 2 + 5);

    // Arrow
    if (i < whyNodes.length - 1) {
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + boxW / 2, y + boxH);
      ctx.lineTo(x + boxW / 2, y + boxH + gap);
      ctx.stroke();
      // Arrowhead
      ctx.fillStyle = '#999';
      ctx.beginPath();
      ctx.moveTo(x + boxW / 2 - 5, y + boxH + gap - 6);
      ctx.lineTo(x + boxW / 2, y + boxH + gap);
      ctx.lineTo(x + boxW / 2 + 5, y + boxH + gap - 6);
      ctx.fill();
    }
  }

  if (whyNodes.length > 1) {
    ctx.fillStyle = '#59a14f';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↑ ROOT CAUSE', canvas.width / 2, totalH - 8);
  }

  const filePath = resolve(STORE_DIR, `rca-5why-${Date.now()}.png`);
  writeFileSync(filePath, canvas.toBuffer('image/png'));
  return filePath;
}

/**
 * Render a Fishbone/Ishikawa diagram as PNG.
 * Exported for testing.
 */
export async function renderFishbonePng(nodes: RcaNode[], docName: string): Promise<string> {
  const { createCanvas } = await import('canvas');
  const W = 900;
  const H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Ishikawa Diagram: ${docName}`, W / 2, 25);

  // Spine (horizontal line)
  const spineY = H / 2;
  const spineLeft = 80;
  const spineRight = W - 120;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(spineLeft, spineY);
  ctx.lineTo(spineRight, spineY);
  ctx.stroke();

  // Effect box at right
  const root = nodes.find((n) => n.node_type === 'root');
  if (root) {
    ctx.fillStyle = '#e15759';
    ctx.beginPath();
    roundRect(ctx, spineRight - 10, spineY - 25, 140, 50, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(truncate(root.label, 18), spineRight + 60, spineY + 5);
  }

  // Category branches (3 above, 3 below spine)
  const categories = nodes.filter((n) => n.node_type === 'category');
  const colors = ['#4e79a7', '#f28e2b', '#76b7b2', '#59a14f', '#edc948', '#b07aa1'];
  const branchSpacing = (spineRight - spineLeft - 80) / Math.max(Math.ceil(categories.length / 2), 1);

  for (let ci = 0; ci < categories.length; ci++) {
    const cat = categories[ci];
    const isTop = ci % 2 === 0;
    const col = Math.floor(ci / 2);
    const branchX = spineLeft + 40 + col * branchSpacing;
    const branchEndY = isTop ? spineY - 120 : spineY + 120;
    const color = colors[ci % colors.length];

    // Branch line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(branchX, spineY);
    ctx.lineTo(branchX, branchEndY);
    ctx.stroke();

    // Category label
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cat.label, branchX, isTop ? branchEndY - 10 : branchEndY + 18);

    // Causes
    const causes = nodes.filter((n) => n.parent_id === cat.id && n.node_type === 'cause');
    for (let k = 0; k < causes.length; k++) {
      const causeY = isTop
        ? branchEndY + 20 + k * 22
        : branchEndY - 30 - k * 22;
      const causeX = branchX + (k % 2 === 0 ? 15 : -15);

      // Cause tick line
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(branchX, causeY);
      ctx.lineTo(causeX + (causeX > branchX ? 8 : -8), causeY);
      ctx.stroke();

      // Cause text
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = causeX > branchX ? 'left' : 'right';
      ctx.fillText(truncate(causes[k].label, 22), causeX + (causeX > branchX ? 12 : -12), causeY + 4);

      // Sub-causes
      const subCauses = nodes.filter((n) => n.parent_id === causes[k].id);
      for (let si = 0; si < subCauses.length; si++) {
        const subY = causeY + (isTop ? 12 : -12) * (si + 1);
        ctx.fillStyle = '#888';
        ctx.font = '9px sans-serif';
        ctx.fillText('• ' + truncate(subCauses[si].label, 20), causeX + (causeX > branchX ? 20 : -20), subY + 4);
      }
    }
  }

  const filePath = resolve(STORE_DIR, `rca-fishbone-${Date.now()}.png`);
  writeFileSync(filePath, canvas.toBuffer('image/png'));
  return filePath;
}

/**
 * Render a PDCA wheel as PNG.
 * Exported for testing.
 */
export async function renderPdcaPng(nodes: RcaNode[], docName: string): Promise<string> {
  const { createCanvas } = await import('canvas');
  const SIZE = 550;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`PDCA Cycle: ${docName}`, SIZE / 2, 25);

  const cx = SIZE / 2;
  const cy = SIZE / 2 + 10;
  const r = 160;

  const phases = [
    { key: 'plan', label: 'PLAN', color: '#4e79a7', startAngle: -Math.PI, endAngle: -Math.PI / 2 },
    { key: 'do', label: 'DO', color: '#f28e2b', startAngle: -Math.PI / 2, endAngle: 0 },
    { key: 'check', label: 'CHECK', color: '#59a14f', startAngle: 0, endAngle: Math.PI / 2 },
    { key: 'act', label: 'ACT', color: '#e15759', startAngle: Math.PI / 2, endAngle: Math.PI },
  ];

  for (const phase of phases) {
    // Draw arc sector
    ctx.fillStyle = phase.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, phase.startAngle, phase.endAngle);
    ctx.closePath();
    ctx.fill();

    // Phase label
    const midAngle = (phase.startAngle + phase.endAngle) / 2;
    const labelR = r * 0.6;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(phase.label, cx + Math.cos(midAngle) * labelR, cy + Math.sin(midAngle) * labelR + 6);

    // Action items outside the wheel
    const phaseNode = nodes.find((n) => n.node_type === phase.key);
    if (phaseNode) {
      const items = nodes.filter((n) => n.parent_id === phaseNode.id);
      const itemR = r + 30;
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#333';

      for (let i = 0; i < items.length; i++) {
        const angle = phase.startAngle + (i + 0.5) * (phase.endAngle - phase.startAngle) / Math.max(items.length, 1);
        const tx = cx + Math.cos(angle) * itemR;
        const ty = cy + Math.sin(angle) * itemR;
        ctx.textAlign = tx > cx ? 'left' : 'right';
        ctx.fillText('• ' + truncate(items[i].label, 28), tx, ty + 4);
      }
    }
  }

  // Center circle
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#333';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PDCA', cx, cy + 4);

  // Rotation arrow
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 12, -Math.PI * 0.9, Math.PI * 0.7);
  ctx.stroke();

  const filePath = resolve(STORE_DIR, `rca-pdca-${Date.now()}.png`);
  writeFileSync(filePath, canvas.toBuffer('image/png'));
  return filePath;
}

/**
 * Render a Fault Tree as PNG.
 * Exported for testing.
 */
export async function renderFtaPng(nodes: RcaNode[], docName: string): Promise<string> {
  const { createCanvas } = await import('canvas');
  const W = 800;
  const H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Fault Tree Analysis: ${docName}`, W / 2, 25);

  // Simple top-down tree layout
  const root = nodes.find((n) => n.node_type === 'root');
  if (!root) { writeFileSync(resolve(STORE_DIR, `rca-fta-${Date.now()}.png`), canvas.toBuffer('image/png')); return ''; }

  // Layout: BFS to assign positions
  type LayoutNode = { node: RcaNode; x: number; y: number; children: LayoutNode[] };
  function layoutTree(node: RcaNode, x: number, y: number, spread: number): LayoutNode {
    const children = nodes.filter((n) => n.parent_id === node.id);
    const layoutChildren: LayoutNode[] = [];
    const totalWidth = children.length * spread;
    let startX = x - totalWidth / 2 + spread / 2;
    for (const child of children) {
      layoutChildren.push(layoutTree(child, startX, y + 90, spread / Math.max(children.length, 1.5)));
      startX += spread;
    }
    return { node, x, y, children: layoutChildren };
  }

  const tree = layoutTree(root, W / 2, 60, W / 3);

  // Draw tree
  function drawTree(t: LayoutNode) {
    const bw = 130;
    const bh = 40;

    // Box
    const isGate = t.node.node_type.startsWith('gate_');
    const isRoot = t.node.node_type === 'root';
    ctx.fillStyle = isRoot ? '#e15759' : isGate ? '#f28e2b' : '#4e79a7';
    if (isGate) {
      // Diamond for gates
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - bh / 2);
      ctx.lineTo(t.x + bw / 2, t.y);
      ctx.lineTo(t.x, t.y + bh / 2);
      ctx.lineTo(t.x - bw / 2, t.y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      roundRect(ctx, t.x - bw / 2, t.y - bh / 2, bw, bh, 6);
      ctx.fill();
    }

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = isGate ? 'bold 11px sans-serif' : '11px sans-serif';
    ctx.textAlign = 'center';
    const prefix = isGate ? (t.node.category === 'and' ? 'AND: ' : 'OR: ') : '';
    ctx.fillText(truncate(prefix + t.node.label, 20), t.x, t.y + 4);

    // Draw children + connectors
    for (const child of t.children) {
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y + bh / 2);
      ctx.lineTo(child.x, child.y - bh / 2);
      ctx.stroke();

      drawTree(child);
    }
  }

  drawTree(tree);

  const filePath = resolve(STORE_DIR, `rca-fta-${Date.now()}.png`);
  writeFileSync(filePath, canvas.toBuffer('image/png'));
  return filePath;
}

/**
 * Render a Mind Map as PNG.
 * Exported for testing.
 */
export async function renderMindMapPng(nodes: RcaNode[], docName: string): Promise<string> {
  const { createCanvas } = await import('canvas');
  const SIZE = 700;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const root = nodes.find((n) => n.node_type === 'root');
  if (!root) { writeFileSync(resolve(STORE_DIR, `rca-mindmap-${Date.now()}.png`), canvas.toBuffer('image/png')); return ''; }

  const colors = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7'];
  const branches = nodes.filter((n) => n.node_type === 'branch');
  const branchAngleStep = (2 * Math.PI) / Math.max(branches.length, 1);

  // Draw branches
  for (let bi = 0; bi < branches.length; bi++) {
    const angle = bi * branchAngleStep - Math.PI / 2;
    const branchR = 180;
    const bx = cx + Math.cos(angle) * branchR;
    const by = cy + Math.sin(angle) * branchR;
    const color = colors[bi % colors.length];

    // Line from center to branch
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(bx, by);
    ctx.stroke();

    // Branch bubble
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(bx, by, 35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(truncate(branches[bi].label, 12), bx, by + 4);

    // Subtopics
    const subtopics = nodes.filter((n) => n.parent_id === branches[bi].id);
    for (let si = 0; si < subtopics.length; si++) {
      const subAngle = angle + (si - (subtopics.length - 1) / 2) * 0.3;
      const subR = branchR + 80;
      const sx = cx + Math.cos(subAngle) * subR;
      const sy = cy + Math.sin(subAngle) * subR;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(sx, sy);
      ctx.stroke();

      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = sx > cx ? 'left' : 'right';
      ctx.fillText(truncate(subtopics[si].label, 20), sx + (sx > cx ? 5 : -5), sy + 4);
    }
  }

  // Center bubble
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.arc(cx, cy, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(truncate(root.label, 14), cx, cy - 2);
  ctx.font = '10px sans-serif';
  ctx.fillText(truncate(docName, 14), cx, cy + 12);

  const filePath = resolve(STORE_DIR, `rca-mindmap-${Date.now()}.png`);
  writeFileSync(filePath, canvas.toBuffer('image/png'));
  return filePath;
}

// ── A3 Report Generation ─────────────────────────────────────

/**
 * Generate A3 report as PDF using PDFKit.
 * Exported for testing.
 */
export async function generateA3Pdf(report: A3Report): Promise<string> {
  const PDFDocument = (await import('pdfkit')).default;
  const filePath = resolve(STORE_DIR, `rca-a3-${Date.now()}.pdf`);

  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      writeFileSync(filePath, Buffer.concat(chunks));
      resolvePromise(filePath);
    });
    doc.on('error', reject);

    const colW = (doc.page.width - 80) / 2;

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(`A3 Report: ${report.title}`, 40, 40, { width: doc.page.width - 80 });
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
    doc.moveDown(0.5);

    const startY = doc.y;

    // Left column
    const sections = [
      { title: '1. Background', content: report.background },
      { title: '2. Current Condition', content: report.current_condition },
      { title: '3. Goal / Target', content: report.goal },
      { title: '4. Root Cause Analysis', content: report.root_cause_analysis },
    ];

    let y = startY;
    for (const section of sections) {
      doc.fontSize(12).font('Helvetica-Bold').text(section.title, 40, y, { width: colW });
      y = doc.y + 4;
      doc.fontSize(10).font('Helvetica').text(section.content, 40, y, { width: colW });
      y = doc.y + 16;
    }

    // Right column
    y = startY;
    const rightX = 40 + colW + 20;

    doc.fontSize(12).font('Helvetica-Bold').text('5. Countermeasures', rightX, y, { width: colW });
    y = doc.y + 4;
    for (const item of report.countermeasures) {
      doc.fontSize(10).font('Helvetica').text(`• ${item}`, rightX, y, { width: colW });
      y = doc.y + 2;
    }
    y += 14;

    doc.fontSize(12).font('Helvetica-Bold').text('6. Implementation Plan', rightX, y, { width: colW });
    y = doc.y + 4;
    for (const item of report.implementation_plan) {
      doc.fontSize(10).font('Helvetica').text(`• ${item}`, rightX, y, { width: colW });
      y = doc.y + 2;
    }
    y += 14;

    doc.fontSize(12).font('Helvetica-Bold').text('7. Follow-up / Verification', rightX, y, { width: colW });
    y = doc.y + 4;
    for (const item of report.follow_up) {
      doc.fontSize(10).font('Helvetica').text(`• ${item}`, rightX, y, { width: colW });
      y = doc.y + 2;
    }

    doc.end();
  });
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format RCA document for display.
 * Exported for testing.
 */
export function formatRcaDocument(doc: RcaDocument, nodes: RcaNode[], html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  const methodNames: Record<string, string> = {
    '5why': '5 Whys', fishbone: 'Ishikawa / Fishbone', pdca: 'PDCA Cycle',
    fta: 'Fault Tree Analysis', mindmap: 'Mind Map',
  };

  lines.push(`${b}${methodNames[doc.method] || doc.method}: ${doc.name}${bEnd}`);
  if (doc.problem_statement) lines.push(`${b}Problem:${bEnd} ${doc.problem_statement}`);
  lines.push('');

  switch (doc.method) {
    case '5why': {
      const whys = nodes.filter((n) => n.node_type === 'root' || n.node_type === 'why');
      for (let i = 0; i < whys.length; i++) {
        if (i === 0) lines.push(`${b}Problem:${bEnd} ${whys[i].label}`);
        else lines.push(`${b}Why ${i}:${bEnd} ${whys[i].label}`);
      }
      if (whys.length > 1) {
        lines.push('');
        lines.push(`${b}Root Cause:${bEnd} ${whys[whys.length - 1].label}`);
      }
      break;
    }
    case 'fishbone': {
      const categories = nodes.filter((n) => n.node_type === 'category');
      for (const cat of categories) {
        lines.push(`${b}${cat.label}:${bEnd}`);
        const causes = nodes.filter((n) => n.parent_id === cat.id);
        for (const cause of causes) {
          lines.push(`  • ${cause.label}`);
          const subs = nodes.filter((n) => n.parent_id === cause.id);
          for (const sub of subs) lines.push(`    - ${sub.label}`);
        }
      }
      break;
    }
    case 'pdca': {
      for (const phase of ['plan', 'do', 'check', 'act']) {
        const phaseNode = nodes.find((n) => n.node_type === phase);
        if (!phaseNode) continue;
        lines.push(`${b}${phase.toUpperCase()}:${bEnd}`);
        const items = nodes.filter((n) => n.parent_id === phaseNode.id);
        for (const item of items) lines.push(`  • ${item.label}`);
      }
      break;
    }
    case 'fta': {
      const root = nodes.find((n) => n.node_type === 'root');
      if (root) lines.push(`${b}Top Event:${bEnd} ${root.label}`);
      const gates = nodes.filter((n) => n.node_type.startsWith('gate_'));
      for (const gate of gates) {
        lines.push(`  ${b}${gate.category.toUpperCase()} Gate:${bEnd} ${gate.label}`);
        const events = nodes.filter((n) => n.parent_id === gate.id && n.node_type === 'cause');
        for (const e of events) lines.push(`    • ${e.label}`);
      }
      break;
    }
    case 'mindmap': {
      const root = nodes.find((n) => n.node_type === 'root');
      if (root) lines.push(`${b}Central:${bEnd} ${root.label}`);
      const branches = nodes.filter((n) => n.node_type === 'branch');
      for (const br of branches) {
        lines.push(`  ${b}${br.label}:${bEnd}`);
        const subs = nodes.filter((n) => n.parent_id === br.id);
        for (const sub of subs) lines.push(`    • ${sub.label}`);
      }
      break;
    }
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

function roundRect(
  ctx: import('canvas').CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}
