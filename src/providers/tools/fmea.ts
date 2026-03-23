import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  executeFmeaFromCsv, createFmeaDoc, getFmeaDocByName, listFmeaDocs, deleteFmeaDoc,
  addFailureMode, getFailureModes, addAction, getActions, completeAction,
  formatFmeaWorksheet, exportFmeaCsv, buildRiskMatrix,
  generateRiskHeatmap, generateRpnPareto, generateRpnTrend,
  type FmeaType,
} from '../../fmea.js';

export const fmeaManageDefinition: Tool = {
  type: 'function',
  function: {
    name: 'fmea_manage',
    description: `FMEA (Failure Mode and Effects Analysis) management tool — PFMEA and DFMEA.
Actions:
- create: Create FMEA document. Requires doc_name. Optional: fmea_type (pfmea/dfmea), product, process.
- add: Add failure mode. Requires doc_name, process_step, failure_mode. Optional: effect, severity (1-10), cause, occurrence (1-10), detection_method, detection (1-10), current_controls.
- add_action: Add action item. Requires doc_name, failure_mode (text match), action. Optional: owner, deadline.
- complete_action: Complete action with new S/O/D. Requires action_id, severity_after, occurrence_after, detection_after.
- import: Import FMEA from CSV. Requires csv_content, doc_name. Optional: fmea_type, product, process.
- risk: Show risk matrix and top risks. Requires doc_name.
- actions: Show action items. Requires doc_name.
- report: Full FMEA worksheet. Requires doc_name.
- heatmap: Generate risk heatmap chart. Requires doc_name.
- pareto: Generate RPN Pareto chart. Requires doc_name.
- trend: Generate RPN reduction trend chart. Requires doc_name.
- export: Export as CSV. Requires doc_name.
- list: List all FMEA documents.

RPN = Severity × Occurrence × Detection. Action Priority per AIAG-VDA: H/M/L.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'add', 'add_action', 'complete_action', 'import', 'risk', 'actions', 'report', 'heatmap', 'pareto', 'trend', 'export', 'list'],
        },
        doc_name: { type: 'string' },
        fmea_type: { type: 'string', description: 'pfmea or dfmea' },
        product: { type: 'string' },
        process: { type: 'string' },
        process_step: { type: 'string' },
        failure_mode: { type: 'string' },
        effect: { type: 'string' },
        severity: { type: 'number' },
        cause: { type: 'string' },
        occurrence: { type: 'number' },
        detection_method: { type: 'string' },
        detection: { type: 'number' },
        current_controls: { type: 'string' },
        csv_content: { type: 'string' },
        owner: { type: 'string' },
        deadline: { type: 'string' },
        action_text: { type: 'string', description: 'Action description (for add_action)' },
        action_id: { type: 'string' },
        severity_after: { type: 'number' },
        occurrence_after: { type: 'number' },
        detection_after: { type: 'number' },
      },
      required: ['action'],
    },
  },
};

export async function fmeaManage(
  args: Record<string, unknown>,
  chatId: string,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'create': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        if (getFmeaDocByName(name)) return { error: `FMEA "${name}" already exists.` };
        const doc = createFmeaDoc(name, (args.fmea_type as FmeaType) || 'pfmea', (args.product as string) || '', (args.process as string) || '');
        return { success: true, doc_id: doc.id, message: `FMEA "${name}" created (${doc.fmea_type.toUpperCase()}). Add failure modes with add action.` };
      }

      case 'add': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        if (!args.process_step || !args.failure_mode) return { error: 'process_step and failure_mode are required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };

        const fm = addFailureMode(doc.id, {
          process_step: args.process_step as string,
          failure_mode: args.failure_mode as string,
          effect: args.effect as string,
          severity: args.severity as number,
          cause: args.cause as string,
          occurrence: args.occurrence as number,
          detection_method: args.detection_method as string,
          detection: args.detection as number,
          current_controls: args.current_controls as string,
        });

        return {
          success: true, fm_id: fm.id,
          rpn: fm.rpn, action_priority: fm.action_priority,
          message: `Failure mode added: "${fm.failure_mode}" RPN=${fm.rpn} [${fm.action_priority}]`,
        };
      }

      case 'add_action': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const actionText = (args.action_text as string) || (args.action as string);
        if (!actionText || actionText === 'add_action') return { error: 'action_text is required.' };
        if (!args.failure_mode) return { error: 'failure_mode is required to link action.' };

        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };

        const fms = getFailureModes(doc.id);
        const fm = fms.find((f) => f.failure_mode.toLowerCase().includes((args.failure_mode as string).toLowerCase()));
        if (!fm) return { error: `No failure mode matching "${args.failure_mode}".` };

        const act = addAction(fm.id, doc.id, actionText, (args.owner as string) || '', (args.deadline as string) || '', fm.rpn);
        return { success: true, action_id: act.id, message: `Action added for "${fm.failure_mode}": ${actionText}` };
      }

      case 'complete_action': {
        if (!args.action_id) return { error: 'action_id is required.' };
        if (args.severity_after === undefined || args.occurrence_after === undefined || args.detection_after === undefined) {
          return { error: 'severity_after, occurrence_after, and detection_after are required.' };
        }
        const result = completeAction(args.action_id as string, args.severity_after as number, args.occurrence_after as number, args.detection_after as number);
        if (!result) return { error: 'Action not found.' };
        return {
          success: true,
          rpn_before: result.rpn_before, rpn_after: result.rpn_after,
          reduction: result.rpn_before - (result.rpn_after || 0),
          message: `Action completed. RPN: ${result.rpn_before} → ${result.rpn_after} (reduced by ${result.rpn_before - (result.rpn_after || 0)})`,
        };
      }

      case 'import': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.doc_name) return { error: 'doc_name is required.' };
        const { doc, failureModes, actions } = executeFmeaFromCsv(
          args.csv_content as string, args.doc_name as string,
          (args.fmea_type as FmeaType) || 'pfmea', (args.product as string) || '', (args.process as string) || '',
        );
        const summary = formatFmeaWorksheet(doc, failureModes, actions, false);
        return {
          success: true, summary, failure_modes: failureModes.length,
          high_risk: failureModes.filter((f) => f.action_priority === 'H').length,
          auto_actions: actions.length,
        };
      }

      case 'risk': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const fms = getFailureModes(doc.id);
        const matrix = buildRiskMatrix(fms);
        const top5 = fms.slice(0, 5).map((fm) => ({ step: fm.process_step, mode: fm.failure_mode, rpn: fm.rpn, ap: fm.action_priority }));
        return { top_risks: top5, matrix: matrix.slice(0, 10) };
      }

      case 'actions': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const acts = getActions(doc.id);
        return {
          actions: acts.map((a) => ({
            id: a.id.slice(0, 8), action: a.action, owner: a.owner, deadline: a.deadline,
            status: a.status, rpn_before: a.rpn_before, rpn_after: a.rpn_after,
          })),
          open: acts.filter((a) => a.status === 'open' || a.status === 'in_progress').length,
        };
      }

      case 'report': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const fms = getFailureModes(doc.id);
        const acts = getActions(doc.id);
        return { report: formatFmeaWorksheet(doc, fms, acts, false) };
      }

      case 'heatmap': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const fms = getFailureModes(doc.id);
        if (fms.length === 0) return { error: 'No failure modes to chart.' };
        const filePath = await generateRiskHeatmap(fms, name);
        return { success: true, file: filePath };
      }

      case 'pareto': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const fms = getFailureModes(doc.id);
        if (fms.length === 0) return { error: 'No failure modes to chart.' };
        const filePath = await generateRpnPareto(fms, name);
        return { success: true, file: filePath };
      }

      case 'trend': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const acts = getActions(doc.id);
        const filePath = await generateRpnTrend(acts, name);
        return { success: true, file: filePath };
      }

      case 'export': {
        const name = args.doc_name as string;
        if (!name) return { error: 'doc_name is required.' };
        const doc = getFmeaDocByName(name);
        if (!doc) return { error: `FMEA "${name}" not found.` };
        const fms = getFailureModes(doc.id);
        const acts = getActions(doc.id);
        return { csv: exportFmeaCsv(doc, fms, acts) };
      }

      case 'list': {
        const docs = listFmeaDocs();
        if (docs.length === 0) return { message: 'No FMEA documents. Create one with create action.' };
        return { documents: docs.map((d) => ({ name: d.name, type: d.fmea_type, product: d.product, updated: new Date(d.updated_at).toLocaleString() })) };
      }

      default:
        return { error: `Unknown action: ${action}.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'FMEA error');
    return { error: message };
  }
}
