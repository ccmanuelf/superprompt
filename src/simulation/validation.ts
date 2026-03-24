/**
 * Production Line Simulation v3.0 — Input Validation
 *
 * Ported from kpi-operations SimPy V2 (validation.py).
 * Two-phase validation:
 * 1. Schema validation (TypeScript types handle basic structure)
 * 2. Domain validation — manufacturing-specific rules and consistency checks
 *
 * All validation is stateless with no database dependencies.
 */

import {
  type SimulationConfig,
  type OperationInput,
  type ValidationReport,
  type ValidationIssue,
  getDailyPlannedHours,
} from './models.js';

import {
  MAX_PRODUCTS,
  MAX_OPERATIONS_PER_PRODUCT,
  MAX_TOTAL_OPERATIONS,
  DEMAND_CONSISTENCY_TOLERANCE_PCT,
  MIX_PERCENTAGE_TOLERANCE,
  MACHINE_TOOL_SIMILARITY_THRESHOLD,
  THEORETICAL_CAPACITY_BUFFER,
} from './constants.js';

/**
 * Perform comprehensive validation of simulation configuration.
 * Exported for testing.
 */
export function validateSimulationConfig(config: SimulationConfig): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const info: ValidationIssue[] = [];

  // Collect statistics
  const products = new Set<string>();
  const machineTools = new Set<string>();
  const operationsByProduct = new Map<string, OperationInput[]>();

  for (const op of config.operations) {
    products.add(op.product);
    machineTools.add(op.machine_tool);
    const list = operationsByProduct.get(op.product) ?? [];
    list.push(op);
    operationsByProduct.set(op.product, list);
  }

  // Run all validation checks
  validateConfigurationLimits(config, products, errors);
  validateOperationSequences(operationsByProduct, errors);
  validateProductConsistency(operationsByProduct, config, errors, warnings);
  validateMachineToolConsistency(config.operations, warnings);
  validateOperatorsConfiguration(operationsByProduct, info);
  validateDemandConfiguration(config, errors, warnings);
  validateScheduleReasonableness(config, warnings);
  validateBreakdownConfiguration(config, machineTools, warnings);
  validateTheoreticalCapacity(config, operationsByProduct, warnings);

  const isValid = errors.length === 0;

  return {
    errors,
    warnings,
    info,
    products_count: products.size,
    operations_count: config.operations.length,
    machine_tools_count: machineTools.size,
    is_valid: isValid,
    can_proceed: isValid,
  };
}

// ── Check 1: Configuration Limits ────────────────────────────

function validateConfigurationLimits(
  config: SimulationConfig,
  products: Set<string>,
  errors: ValidationIssue[],
): void {
  if (products.size > MAX_PRODUCTS) {
    errors.push({
      severity: 'error',
      category: 'limits',
      message: `Too many products (${products.size}). Maximum allowed is ${MAX_PRODUCTS}`,
      recommendation: `Reduce to ${MAX_PRODUCTS} or fewer products`,
    });
  }

  if (config.operations.length > MAX_TOTAL_OPERATIONS) {
    errors.push({
      severity: 'error',
      category: 'limits',
      message: `Too many total operations (${config.operations.length}). Maximum is ${MAX_TOTAL_OPERATIONS}`,
      recommendation: 'Reduce total operations or simplify product definitions',
    });
  }
}

// ── Check 2: Operation Sequences ─────────────────────────────

function validateOperationSequences(
  operationsByProduct: Map<string, OperationInput[]>,
  errors: ValidationIssue[],
): void {
  for (const [product, ops] of operationsByProduct) {
    if (ops.length > MAX_OPERATIONS_PER_PRODUCT) {
      errors.push({
        severity: 'error',
        category: 'limits',
        product,
        message: `Product '${product}' has ${ops.length} operations. Maximum is ${MAX_OPERATIONS_PER_PRODUCT}`,
        recommendation: 'Reduce operations or combine similar steps',
      });
      continue;
    }

    const steps = ops.map((op) => op.step).sort((a, b) => a - b);

    // Check for duplicates
    const uniqueSteps = new Set(steps);
    if (uniqueSteps.size !== steps.length) {
      const duplicates = steps.filter((s, i) => steps.indexOf(s) !== i);
      errors.push({
        severity: 'error',
        category: 'sequence',
        product,
        message: `Product '${product}' has duplicate step numbers: ${[...new Set(duplicates)]}`,
        recommendation: 'Ensure each step number is unique within the product',
      });
      continue;
    }

    // Check for gaps
    if (steps.length > 0) {
      const firstStep = steps[0];
      const expected = Array.from({ length: steps.length }, (_, i) => firstStep + i);
      const missing = expected.filter((s) => !uniqueSteps.has(s));
      if (missing.length > 0) {
        errors.push({
          severity: 'error',
          category: 'sequence',
          product,
          message: `Product '${product}' has gaps in step sequence. Missing steps: ${missing}`,
          recommendation: 'Steps must be sequential without gaps',
        });
      }
    }
  }
}

// ── Check 3: Product Consistency ─────────────────────────────

function validateProductConsistency(
  operationsByProduct: Map<string, OperationInput[]>,
  config: SimulationConfig,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const opsProducts = new Set(operationsByProduct.keys());
  const demandProducts = new Set(config.demands.map((d) => d.product));

  // Products in demand but not in operations — ERROR
  for (const product of demandProducts) {
    if (!opsProducts.has(product)) {
      errors.push({
        severity: 'error',
        category: 'product_consistency',
        product,
        message: `Product '${product}' has demand specified but no operations defined`,
        recommendation: 'Add operations for this product or remove from demand configuration',
      });
    }
  }

  // Products in operations but not in demand — WARNING
  for (const product of opsProducts) {
    if (!demandProducts.has(product)) {
      warnings.push({
        severity: 'warning',
        category: 'product_consistency',
        product,
        message: `Product '${product}' has operations defined but no demand specified`,
        recommendation: 'This product will be excluded from simulation. Add demand or remove operations.',
      });
    }
  }
}

// ── Check 4: Machine Tool Consistency (typo detection) ───────

function validateMachineToolConsistency(
  operations: OperationInput[],
  warnings: ValidationIssue[],
): void {
  const tools = [...new Set(operations.map((op) => op.machine_tool))];

  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const similarity = stringSimilarity(tools[i], tools[j]);
      if (similarity >= MACHINE_TOOL_SIMILARITY_THRESHOLD && similarity < 1.0) {
        warnings.push({
          severity: 'warning',
          category: 'machine_tool',
          message: `Machine tools '${tools[i]}' and '${tools[j]}' are very similar (${(similarity * 100).toFixed(0)}% match). Possible typo?`,
          recommendation: 'Verify these are intentionally different machine tools',
        });
      }
    }
  }
}

// ── Check 5: Operator Configuration ──────────────────────────

function validateOperatorsConfiguration(
  operationsByProduct: Map<string, OperationInput[]>,
  info: ValidationIssue[],
): void {
  // Check if same tool has varying operator counts across operations
  const toolOperators = new Map<string, Set<number>>();
  for (const [, ops] of operationsByProduct) {
    for (const op of ops) {
      const set = toolOperators.get(op.machine_tool) ?? new Set();
      set.add(op.operators ?? 1);
      toolOperators.set(op.machine_tool, set);
    }
  }

  for (const [tool, counts] of toolOperators) {
    if (counts.size > 1) {
      info.push({
        severity: 'info',
        category: 'operators',
        message: `Machine tool '${tool}' has varying operator counts across operations: ${[...counts].join(', ')}`,
        recommendation: 'This is valid (resource pooling sums all operators for this tool)',
      });
    }
  }
}

// ── Check 6: Demand Configuration ────────────────────────────

function validateDemandConfiguration(
  config: SimulationConfig,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const mode = config.mode ?? 'demand-driven';

  if (mode === 'mix-driven') {
    // Mix percentages must sum to 100%
    const totalMix = config.demands.reduce((s, d) => s + (d.mix_share_pct ?? 0), 0);
    if (Math.abs(totalMix - 100) > MIX_PERCENTAGE_TOLERANCE) {
      errors.push({
        severity: 'error',
        category: 'demand',
        message: `Mix percentages sum to ${totalMix.toFixed(1)}%, must be 100% (±${MIX_PERCENTAGE_TOLERANCE}%)`,
        recommendation: 'Adjust mix percentages to sum to 100%',
      });
    }

    if (!config.total_demand || config.total_demand <= 0) {
      errors.push({
        severity: 'error',
        category: 'demand',
        message: 'Mix-driven mode requires total_demand > 0',
        recommendation: 'Set total_demand to the total daily production target',
      });
    }
  } else {
    // Demand-driven: check daily vs weekly consistency
    for (const demand of config.demands) {
      if (demand.daily_demand && demand.weekly_demand) {
        const expectedWeekly = demand.daily_demand * config.schedule.work_days;
        const diff = Math.abs(expectedWeekly - demand.weekly_demand) / expectedWeekly * 100;
        if (diff > DEMAND_CONSISTENCY_TOLERANCE_PCT) {
          warnings.push({
            severity: 'warning',
            category: 'demand',
            product: demand.product,
            message: `Product '${demand.product}': daily_demand × work_days (${expectedWeekly}) differs from weekly_demand (${demand.weekly_demand}) by ${diff.toFixed(1)}%`,
            recommendation: 'Verify demand values are consistent',
          });
        }
      }
    }
  }
}

// ── Check 7: Schedule Reasonableness ─────────────────────────

function validateScheduleReasonableness(
  config: SimulationConfig,
  warnings: ValidationIssue[],
): void {
  const schedule = config.schedule;

  if (schedule.shifts_enabled >= 2 && (schedule.shift2_hours ?? 0) === 0) {
    warnings.push({
      severity: 'warning',
      category: 'schedule',
      message: 'Multiple shifts enabled but shift 2 hours is 0',
      recommendation: 'Set shift 2 hours or reduce shifts_enabled to 1',
    });
  }

  if (schedule.shifts_enabled >= 3 && (schedule.shift3_hours ?? 0) === 0) {
    warnings.push({
      severity: 'warning',
      category: 'schedule',
      message: 'Three shifts enabled but shift 3 hours is 0',
      recommendation: 'Set shift 3 hours or reduce shifts_enabled',
    });
  }

  const totalShiftHours = getDailyPlannedHours(schedule);
  if (totalShiftHours > 24) {
    warnings.push({
      severity: 'warning',
      category: 'schedule',
      message: `Total shift hours (${totalShiftHours}) exceeds 24 hours per day`,
      recommendation: 'Verify shift hours configuration',
    });
  }
}

// ── Check 8: Breakdown Configuration ─────────────────────────

function validateBreakdownConfiguration(
  config: SimulationConfig,
  machineTools: Set<string>,
  warnings: ValidationIssue[],
): void {
  if (!config.breakdowns) return;

  for (const b of config.breakdowns) {
    if (!machineTools.has(b.machine_tool)) {
      warnings.push({
        severity: 'warning',
        category: 'breakdowns',
        message: `Breakdown configured for '${b.machine_tool}' which is not in any operation`,
        recommendation: 'Remove this breakdown rule or add an operation using this machine tool',
      });
    }
  }
}

// ── Check 9: Theoretical Capacity ────────────────────────────

function validateTheoreticalCapacity(
  config: SimulationConfig,
  operationsByProduct: Map<string, OperationInput[]>,
  warnings: ValidationIssue[],
): void {
  const dailyHours = getDailyPlannedHours(config.schedule);
  const horizonDays = config.horizon_days ?? 1;
  const availableMinutes = dailyHours * 60 * horizonDays;

  for (const demand of config.demands) {
    const ops = operationsByProduct.get(demand.product);
    if (!ops) continue;

    let dailyDemand = demand.daily_demand ?? 0;
    if (!dailyDemand && demand.weekly_demand) {
      dailyDemand = demand.weekly_demand / config.schedule.work_days;
    }
    if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      dailyDemand = config.total_demand * demand.mix_share_pct / 100;
    }

    if (dailyDemand <= 0) continue;

    const totalDemand = dailyDemand * horizonDays;

    // Find bottleneck SAM (highest SAM per operator)
    for (const op of ops) {
      const samPerPiece = op.sam_min;
      const operators = op.operators ?? 1;
      const requiredMinutes = (totalDemand * samPerPiece) / operators;

      if (requiredMinutes > availableMinutes * THEORETICAL_CAPACITY_BUFFER) {
        warnings.push({
          severity: 'warning',
          category: 'capacity',
          product: demand.product,
          message: `Operation '${op.operation}' (step ${op.step}) for '${demand.product}' may not have sufficient capacity. ` +
            `Needs ${requiredMinutes.toFixed(0)} min but only ${availableMinutes.toFixed(0)} min available (with ${THEORETICAL_CAPACITY_BUFFER}x buffer)`,
          recommendation: 'Consider adding operators or reducing demand',
        });
      }
    }
  }
}

// ── String Similarity (Levenshtein-based) ────────────────────

/** Calculate string similarity ratio (0-1) using Levenshtein distance. */
function stringSimilarity(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;

  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(la, lb);
  return 1 - distance / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}
