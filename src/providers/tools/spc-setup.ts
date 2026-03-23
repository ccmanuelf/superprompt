import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
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
  recommendSampling,
  recommendReaction,
  suggestStandard,
  type ProcessType,
  type VocCategory,
  type ChartRecommendation,
} from '../../control-plan.js';

export const spcSetupDefinition: Tool = {
  type: 'function',
  function: {
    name: 'spc_setup',
    description: `SPC Control Plan setup tool. Guides VOC→CTQ→Control Plan creation.
Actions:
- create: Create new control plan. Requires plan_name, process_type (manual/semi_automated/automated/continuous). Optional: product, standard.
- add_voc: Add Voice of Customer requirement. Requires plan_name, requirement. Optional: category (appearance/dimensions/function/reliability/compliance/other), priority (1-5).
- add_ctq: Add CTQ linked to a VOC. Requires plan_name, voc_requirement, ctq_name. Optional: measurement_method, unit, usl, lsl, target, severity (1-10), occurrence (1-10), detection (1-10).
- summary: Show complete control plan with risk analysis. Requires plan_name.
- export: Export control plan as CSV. Requires plan_name.
- suggest_standard: Suggest applicable standard. Requires product.
- list: List all control plans.

The tool auto-generates: RPN scores, chart type recommendations, sampling strategies, and reaction plans based on process type and risk level.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'add_voc', 'add_ctq', 'summary', 'export', 'suggest_standard', 'list'],
        },
        plan_name: { type: 'string', description: 'Control plan name' },
        process_type: { type: 'string', description: 'Process type: manual, semi_automated, automated, continuous' },
        product: { type: 'string', description: 'Product description (used for standard suggestion)' },
        standard: { type: 'string', description: 'Applicable industry standard' },
        requirement: { type: 'string', description: 'VOC requirement text' },
        category: { type: 'string', description: 'VOC category: appearance, dimensions, function, reliability, compliance, other' },
        priority: { type: 'number', description: 'VOC priority 1-5 (5=highest)' },
        voc_requirement: { type: 'string', description: 'VOC requirement text to link CTQ to (matches existing VOC)' },
        ctq_name: { type: 'string', description: 'CTQ characteristic name' },
        measurement_method: { type: 'string', description: 'How to measure this CTQ' },
        unit: { type: 'string', description: 'Measurement unit (mm, N, %, etc.)' },
        usl: { type: 'number', description: 'Upper spec limit' },
        lsl: { type: 'number', description: 'Lower spec limit' },
        target: { type: 'number', description: 'Target value' },
        severity: { type: 'number', description: 'Severity if CTQ fails (1-10)' },
        occurrence: { type: 'number', description: 'How often failure occurs (1-10)' },
        detection: { type: 'number', description: 'How well current controls detect failure (1-10, 10=undetectable)' },
      },
      required: ['action'],
    },
  },
};

export function spcSetup(
  args: Record<string, unknown>,
  chatId: string,
): Record<string, unknown> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'create': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        const processType = (args.process_type as ProcessType) || 'semi_automated';
        const product = (args.product as string) || '';
        let standard = (args.standard as string) || '';
        if (!standard && product) standard = suggestStandard(product, processType);

        const existing = getControlPlanByName(name);
        if (existing) return { error: `Plan "${name}" already exists. Use a different name.` };

        const plan = createControlPlan(name, processType, product, standard);
        return {
          success: true,
          plan_id: plan.id,
          message: `Control plan "${name}" created.${standard ? ` Suggested standard: ${standard}` : ''}\nNext: add VOC items with add_voc action.`,
        };
      }

      case 'add_voc': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        if (!args.requirement) return { error: 'requirement is required.' };
        const plan = getControlPlanByName(name);
        if (!plan) return { error: `Plan "${name}" not found.` };

        const voc = addVocItem(
          plan.id,
          args.requirement as string,
          (args.category as VocCategory) || 'other',
          (args.priority as number) || 3,
        );

        const vocCount = getVocItems(plan.id).length;
        return {
          success: true,
          voc_id: voc.id,
          message: `VOC added: "${voc.requirement}" [${voc.category}, priority=${voc.priority}]. Total VOC items: ${vocCount}.\nNext: add CTQs with add_ctq action, or add more VOC items.`,
        };
      }

      case 'add_ctq': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        if (!args.ctq_name) return { error: 'ctq_name is required.' };
        if (!args.voc_requirement) return { error: 'voc_requirement is required to link CTQ to VOC.' };

        const plan = getControlPlanByName(name);
        if (!plan) return { error: `Plan "${name}" not found.` };

        // Find VOC by matching requirement text
        const vocItems = getVocItems(plan.id);
        const voc = vocItems.find((v) => v.requirement.toLowerCase().includes((args.voc_requirement as string).toLowerCase()));
        if (!voc) return { error: `No VOC matching "${args.voc_requirement}". Add it first with add_voc.` };

        const severity = (args.severity as number) || 5;
        const occurrence = (args.occurrence as number) || 5;
        const detection = (args.detection as number) || 5;
        const rpn = Math.min(severity, 10) * Math.min(occurrence, 10) * Math.min(detection, 10);

        // Auto-generate recommendations
        const sampling = recommendSampling(plan.process_type as ProcessType, rpn, severity, detection);
        const chartType = args.usl !== undefined && args.lsl !== undefined ? 'xbar_r' : 'p';
        const reaction = recommendReaction(severity, chartType as ChartRecommendation);

        const ctq = addCtqItem(plan.id, voc.id, {
          ctq_name: args.ctq_name as string,
          measurement_method: (args.measurement_method as string) || '',
          unit: (args.unit as string) || '',
          usl: args.usl as number | undefined,
          lsl: args.lsl as number | undefined,
          target: args.target as number | undefined,
          severity,
          occurrence,
          detection,
          chart_type: chartType as ChartRecommendation,
          sampling_strategy: sampling,
          reaction_plan: reaction,
        });

        return {
          success: true,
          ctq_id: ctq.id,
          rpn: ctq.rpn,
          risk_level: ctq.rpn >= 200 ? 'HIGH' : ctq.rpn >= 80 ? 'MEDIUM' : 'LOW',
          chart_recommendation: ctq.chart_type,
          sampling_recommendation: sampling,
          message: `CTQ added: "${ctq.ctq_name}" [RPN=${ctq.rpn}]. Chart: ${ctq.chart_type}. Sampling: ${sampling.substring(0, 60)}...`,
        };
      }

      case 'summary': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        const plan = getControlPlanByName(name);
        if (!plan) return { error: `Plan "${name}" not found.` };

        const summary = buildControlPlanSummary(plan.id);
        return { success: true, summary: formatControlPlan(summary, false), risk: summary.risk_summary };
      }

      case 'export': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        const plan = getControlPlanByName(name);
        if (!plan) return { error: `Plan "${name}" not found.` };

        const summary = buildControlPlanSummary(plan.id);
        const csv = exportControlPlanCsv(summary);
        return { success: true, csv, message: `Control plan exported (${summary.ctq_items.length} CTQs).` };
      }

      case 'suggest_standard': {
        const product = (args.product as string) || '';
        if (!product) return { error: 'product is required.' };
        const standard = suggestStandard(product, (args.process_type as ProcessType) || 'semi_automated');
        return { standard: standard || 'No specific standard identified. Check with your quality department.' };
      }

      case 'list': {
        const plans = listControlPlans();
        if (plans.length === 0) return { message: 'No control plans found. Create one with create action.' };
        return {
          plans: plans.map((p) => ({
            name: p.name,
            process_type: p.process_type,
            product: p.product,
            updated: new Date(p.updated_at).toLocaleString(),
          })),
        };
      }

      default:
        return { error: `Unknown action: ${action}.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'SPC setup error');
    return { error: message };
  }
}
