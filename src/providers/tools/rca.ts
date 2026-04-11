import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  createRcaDoc, getRcaDocByName, listRcaDocs, deleteRcaDoc, getRcaNodes,
  build5Whys, buildFishbone, buildPdca, buildFaultTree, buildMindMap,
  generateMermaidSyntax, formatRcaDocument, generateA3Pdf,
  render5WhysPng, renderFishbonePng, renderPdcaPng, renderFtaPng, renderMindMapPng,
  type RcaMethod, type FishboneCategory, type PdcaCycle, type A3Report,
} from '../../rca.js';

export const rcaManageDefinition: Tool = {
  type: 'function',
  function: {
    name: 'rca_manage',
    description: `Root Cause Analysis tool suite: 5 Whys, Ishikawa/Fishbone, PDCA, Fault Tree, Mind Map, A3 Report.
Actions:
- five_whys: Build 5 Whys chain. Requires doc_name, problem, whys (JSON array of why strings).
- fishbone: Build Ishikawa diagram. Requires doc_name, problem, causes (JSON array: [{category:"Man|Machine|Method|Material|Measurement|Environment", cause:"text", sub_causes:["a","b"]}]).
- pdca: Build PDCA cycle. Requires doc_name, plan (JSON array), do_items (JSON array), check (JSON array), act (JSON array).
- fta: Build Fault Tree. Requires doc_name, top_event, gates (JSON array: [{gate_type:"and|or", label:"text", events:["a","b"]}]).
- mindmap: Build Mind Map. Requires doc_name, central_topic, branches (JSON array: [{topic:"text", subtopics:["a","b"]}]).
- a3: Generate A3 Report PDF. Requires doc_name, title, background, current_condition, goal, root_cause_analysis, countermeasures (JSON array), implementation_plan (JSON array), follow_up (JSON array).
- view: View RCA document text. Requires doc_name.
- mermaid: Get Mermaid diagram syntax. Requires doc_name.
- diagram: Generate diagram PNG. Requires doc_name.
- list: List all RCA documents.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['five_whys', 'fishbone', 'pdca', 'fta', 'mindmap', 'a3', 'view', 'mermaid', 'diagram', 'list'] },
        doc_name: { type: 'string' },
        problem: { type: 'string' },
        whys: { type: 'string', description: 'JSON array of why strings' },
        causes: { type: 'string', description: 'JSON array of fishbone causes' },
        plan: { type: 'string', description: 'JSON array of plan items' },
        do_items: { type: 'string', description: 'JSON array of do items' },
        check: { type: 'string', description: 'JSON array of check items' },
        act: { type: 'string', description: 'JSON array of act items' },
        top_event: { type: 'string' },
        gates: { type: 'string', description: 'JSON array of FTA gates' },
        central_topic: { type: 'string' },
        branches: { type: 'string', description: 'JSON array of mind map branches' },
        title: { type: 'string' },
        background: { type: 'string' },
        current_condition: { type: 'string' },
        goal: { type: 'string' },
        root_cause_analysis: { type: 'string' },
        countermeasures: { type: 'string', description: 'JSON array' },
        implementation_plan: { type: 'string', description: 'JSON array' },
        follow_up: { type: 'string', description: 'JSON array' },
      },
      required: ['action'],
    },
  },
};

export async function rcaManage(
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'five_whys': {
        const name = args.doc_name as string;
        if (!name || !args.problem || !args.whys) return { error: 'doc_name, problem, and whys are required.' };
        const whys = JSON.parse(args.whys as string) as string[];
        const existing = await getRcaDocByName(name);
        if (existing) await deleteRcaDoc(existing.id);
        const doc = await createRcaDoc(name, '5why', args.problem as string);
        await build5Whys(doc.id, args.problem as string, whys);
        const nodes = await getRcaNodes(doc.id);
        const filePath = await render5WhysPng(nodes, name);
        return { success: true, diagram: filePath, text: formatRcaDocument(doc, nodes, false), mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'fishbone': {
        const name = args.doc_name as string;
        if (!name || !args.problem || !args.causes) return { error: 'doc_name, problem, and causes are required.' };
        const causes = JSON.parse(args.causes as string) as Array<{ category: FishboneCategory; cause: string; sub_causes?: string[] }>;
        const existing = await getRcaDocByName(name);
        if (existing) await deleteRcaDoc(existing.id);
        const doc = await createRcaDoc(name, 'fishbone', args.problem as string);
        await buildFishbone(doc.id, args.problem as string, causes);
        const nodes = await getRcaNodes(doc.id);
        const filePath = await renderFishbonePng(nodes, name);
        return { success: true, diagram: filePath, text: formatRcaDocument(doc, nodes, false), mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'pdca': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const cycle: PdcaCycle = {
          plan: JSON.parse((args.plan as string) || '[]'),
          do_items: JSON.parse((args.do_items as string) || '[]'),
          check: JSON.parse((args.check as string) || '[]'),
          act: JSON.parse((args.act as string) || '[]'),
        };
        const existing = await getRcaDocByName(name);
        if (existing) await deleteRcaDoc(existing.id);
        const doc = await createRcaDoc(name, 'pdca');
        await buildPdca(doc.id, cycle);
        const nodes = await getRcaNodes(doc.id);
        const filePath = await renderPdcaPng(nodes, name);
        return { success: true, diagram: filePath, text: formatRcaDocument(doc, nodes, false), mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'fta': {
        const name = args.doc_name as string;
        if (!name || !args.top_event || !args.gates) return { error: 'doc_name, top_event, and gates are required.' };
        const gates = JSON.parse(args.gates as string) as Array<{ gate_type: 'and' | 'or'; label: string; parent_label?: string; events: string[] }>;
        const existing = await getRcaDocByName(name);
        if (existing) await deleteRcaDoc(existing.id);
        const doc = await createRcaDoc(name, 'fta', args.top_event as string);
        await buildFaultTree(doc.id, args.top_event as string, gates);
        const nodes = await getRcaNodes(doc.id);
        const filePath = await renderFtaPng(nodes, name);
        return { success: true, diagram: filePath, text: formatRcaDocument(doc, nodes, false), mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'mindmap': {
        const name = args.doc_name as string;
        if (!name || !args.central_topic || !args.branches) return { error: 'doc_name, central_topic, and branches are required.' };
        const branches = JSON.parse(args.branches as string) as Array<{ topic: string; subtopics: string[] }>;
        const existing = await getRcaDocByName(name);
        if (existing) await deleteRcaDoc(existing.id);
        const doc = await createRcaDoc(name, 'mindmap');
        await buildMindMap(doc.id, args.central_topic as string, branches);
        const nodes = await getRcaNodes(doc.id);
        const filePath = await renderMindMapPng(nodes, name);
        return { success: true, diagram: filePath, text: formatRcaDocument(doc, nodes, false), mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'a3': {
        const report: A3Report = {
          title: (args.title as string) || (args.doc_name as string) || 'A3 Report',
          background: (args.background as string) || '',
          current_condition: (args.current_condition as string) || '',
          goal: (args.goal as string) || '',
          root_cause_analysis: (args.root_cause_analysis as string) || '',
          countermeasures: JSON.parse((args.countermeasures as string) || '[]'),
          implementation_plan: JSON.parse((args.implementation_plan as string) || '[]'),
          follow_up: JSON.parse((args.follow_up as string) || '[]'),
        };
        const filePath = await generateA3Pdf(report);
        return { success: true, file: filePath, message: `A3 report generated: ${report.title}` };
      }

      case 'view': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = await getRcaDocByName(name);
        if (!doc) return { error: `RCA "${name}" not found.` };
        const nodes = await getRcaNodes(doc.id);
        return { text: formatRcaDocument(doc, nodes, false) };
      }

      case 'mermaid': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = await getRcaDocByName(name);
        if (!doc) return { error: `RCA "${name}" not found.` };
        const nodes = await getRcaNodes(doc.id);
        return { mermaid: generateMermaidSyntax(doc, nodes) };
      }

      case 'diagram': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = await getRcaDocByName(name);
        if (!doc) return { error: `RCA "${name}" not found.` };
        const nodes = await getRcaNodes(doc.id);
        const renderers: Record<string, (n: typeof nodes, name: string) => Promise<string>> = {
          '5why': render5WhysPng, fishbone: renderFishbonePng, pdca: renderPdcaPng,
          fta: renderFtaPng, mindmap: renderMindMapPng,
        };
        const renderer = renderers[doc.method];
        if (!renderer) return { error: `No diagram renderer for method "${doc.method}".` };
        const filePath = await renderer(nodes, name);
        return { success: true, file: filePath };
      }

      case 'list': {
        const docs = await listRcaDocs();
        if (docs.length === 0) return { message: 'No RCA documents.' };
        return { documents: docs.map((d) => ({ name: d.name, method: d.method, problem: d.problem_statement, updated: new Date(d.updated_at).toLocaleString() })) };
      }

      default:
        return { error: `Unknown action: ${action}.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'RCA error');
    return { error: message };
  }
}
