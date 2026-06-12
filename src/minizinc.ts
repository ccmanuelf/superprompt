/**
 * MiniZinc Integration — Constraint Optimization for Manufacturing
 *
 * Generates .mzn model files dynamically and invokes the MiniZinc CLI solver.
 * Four manufacturing optimization models:
 * 1. Operator assignment: minimize headcount while meeting throughput
 * 2. Production sequencing: minimize total changeover time (TSP-like)
 * 3. Shift scheduling: minimize labor cost with coverage constraints
 * 4. Line rebalancing: minimize max utilization imbalance
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

// ── Core MiniZinc Solver ─────────────────────────────────────

/**
 * Solve a MiniZinc model and return the JSON result.
 * Writes model to temp file, invokes CLI, parses output.
 * Exported for testing.
 */
export function solveMzn(
  model: string,
  timeoutMs: number = 30000,
): Record<string, unknown> | null {
  const tmpFile = resolve(tmpdir(), `mzn-${randomBytes(4).toString('hex')}.mzn`);

  try {
    writeFileSync(tmpFile, model, 'utf-8');

    const result = execSync(
      `minizinc --solver gecode --output-mode json "${tmpFile}"`,
      { timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Parse first JSON object from output (before "----------")
    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      logger.warn({ output: result.substring(0, 200) }, 'MiniZinc: no JSON output');
      return null;
    }

    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message.substring(0, 200) }, 'MiniZinc solver error');
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Check if MiniZinc is available on the system.
 * Exported for testing.
 */
export function isMiniZincAvailable(): boolean {
  try {
    execSync('minizinc --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ── Model 1: Operator Assignment ─────────────────────────────

export interface OperatorAssignmentInput {
  stations: Array<{
    name: string;
    sam_per_piece: number; // minutes
  }>;
  available_minutes: number; // per shift
  demand: number; // pieces per shift
  max_operators_per_station?: number;
}

export interface OperatorAssignmentResult {
  operators: number[];
  total_operators: number;
  station_assignments: Array<{ station: string; operators: number; capacity: number }>;
}

/**
 * Minimize total operators while meeting throughput demand at every station.
 * Exported for testing.
 */
export function optimizeOperators(input: OperatorAssignmentInput): OperatorAssignmentResult | null {
  const n = input.stations.length;
  const maxOps = input.max_operators_per_station ?? 10;

  const model = `
% Operator Assignment: minimize total operators while meeting demand
int: n_stations = ${n};
int: demand = ${input.demand};
float: available_minutes = ${input.available_minutes};
int: max_ops = ${maxOps};
array[1..n_stations] of float: sam_per_piece = [${input.stations.map((s) => s.sam_per_piece).join(', ')}];

array[1..n_stations] of var 1..max_ops: operators;

% Each station must have enough capacity to meet demand
constraint forall(i in 1..n_stations)(
  operators[i] * available_minutes / sam_per_piece[i] >= demand
);

solve minimize sum(operators);
`;

  const result = solveMzn(model);
  if (!result || !result.operators) return null;

  const ops = result.operators as number[];
  return {
    operators: ops,
    total_operators: ops.reduce((s, v) => s + v, 0),
    station_assignments: input.stations.map((s, i) => ({
      station: s.name,
      operators: ops[i],
      capacity: Math.floor(ops[i] * input.available_minutes / s.sam_per_piece),
    })),
  };
}

// ── Model 2: Production Sequencing ───────────────────────────

export interface SequencingInput {
  products: string[];
  changeover_matrix: number[][]; // [from][to] in minutes
}

export interface SequencingResult {
  sequence: number[];
  product_order: string[];
  total_changeover_minutes: number;
}

/**
 * Minimize total changeover time across products (TSP-like).
 * Exported for testing.
 */
export function optimizeSequence(input: SequencingInput): SequencingResult | null {
  const n = input.products.length;
  if (n < 2) return { sequence: [1], product_order: input.products, total_changeover_minutes: 0 };

  const matrixStr = input.changeover_matrix
    .map((row) => row.join(', '))
    .join(' |\n  ');

  const model = `
include "alldifferent.mzn";
int: n = ${n};
array[1..n, 1..n] of int: changeover = [|
  ${matrixStr} |];
array[1..n] of var 1..n: sequence;
constraint alldifferent(sequence);
var int: total = sum(i in 1..n-1)(changeover[sequence[i], sequence[i+1]]);
solve minimize total;
`;

  const result = solveMzn(model);
  if (!result || !result.sequence) return null;

  const seq = result.sequence as number[];

  // Compute total changeover from sequence (MiniZinc only outputs decision vars)
  let total = 0;
  for (let i = 0; i < seq.length - 1; i++) {
    total += input.changeover_matrix[seq[i] - 1][seq[i + 1] - 1];
  }

  return {
    sequence: seq,
    product_order: seq.map((i) => input.products[i - 1]),
    total_changeover_minutes: total,
  };
}

// ── Model 3: Shift Scheduling ────────────────────────────────

export interface ShiftSchedulingInput {
  days: number; // planning horizon (e.g. 7)
  shifts_per_day: number; // 1-3
  min_operators_per_shift: number;
  max_operators_per_shift: number;
  demand_per_day: number[]; // pieces needed each day
  capacity_per_operator_per_shift: number; // pieces one operator produces per shift
  operator_cost_per_shift: number; // cost per operator per shift
}

export interface ShiftSchedulingResult {
  schedule: number[][]; // [day][shift] = operators
  total_operators_used: number;
  total_cost: number;
  daily_capacity: number[];
}

/**
 * Minimize labor cost while ensuring demand coverage per day.
 * Exported for testing.
 */
export function optimizeSchedule(input: ShiftSchedulingInput): ShiftSchedulingResult | null {
  const d = input.days;
  const s = input.shifts_per_day;

  const demandStr = input.demand_per_day.join(', ');

  const model = `
int: days = ${d};
int: shifts = ${s};
int: min_ops = ${input.min_operators_per_shift};
int: max_ops = ${input.max_operators_per_shift};
float: cap_per_op = ${input.capacity_per_operator_per_shift};
float: cost_per_op = ${input.operator_cost_per_shift};
array[1..days] of int: demand = [${demandStr}];

array[1..days, 1..shifts] of var min_ops..max_ops: schedule;

% Daily capacity must meet demand
constraint forall(day in 1..days)(
  sum(sh in 1..shifts)(schedule[day, sh]) * cap_per_op >= demand[day]
);

var float: total_cost = sum(day in 1..days, sh in 1..shifts)(schedule[day, sh]) * cost_per_op;

solve minimize total_cost;
`;

  const result = solveMzn(model);
  if (!result || !result.schedule) return null;

  // MiniZinc returns 2D array as nested array or flat array
  const raw = result.schedule;
  let flat: number[];
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    // Nested array — flatten
    flat = (raw as number[][]).flat();
  } else {
    flat = raw as number[];
  }

  const schedule: number[][] = [];
  for (let day = 0; day < d; day++) {
    const daySchedule: number[] = [];
    for (let shift = 0; shift < s; shift++) {
      const idx = day * s + shift;
      daySchedule.push(idx < flat.length ? flat[idx] : input.min_operators_per_shift);
    }
    schedule.push(daySchedule);
  }

  const totalOps = schedule.reduce((sum, day) => sum + day.reduce((s2, v) => s2 + v, 0), 0);
  const dailyCapacity = schedule.map((day) =>
    Math.floor(day.reduce((sum, ops) => sum + ops, 0) * input.capacity_per_operator_per_shift),
  );

  return {
    schedule,
    total_operators_used: totalOps,
    total_cost: totalOps * input.operator_cost_per_shift,
    daily_capacity: dailyCapacity,
  };
}

// ── Model 4: Line Rebalancing ────────────────────────────────

export interface RebalancingInput {
  stations: Array<{
    name: string;
    current_operators: number;
    utilization_pct: number;
    sam_per_piece: number;
  }>;
  total_operators: number; // fixed headcount to redistribute
  available_minutes: number;
  demand: number;
}

export interface RebalancingResult {
  operators: number[];
  station_assignments: Array<{
    station: string;
    operators_before: number;
    operators_after: number;
    utilization_before: number;
    utilization_after: number;
  }>;
  max_utilization_after: number;
}

/**
 * Redistribute operators to minimize maximum utilization imbalance.
 * Fixed total headcount — no new hires.
 * Exported for testing.
 */
export function rebalanceLine(input: RebalancingInput): RebalancingResult | null {
  const n = input.stations.length;

  const model = `
int: n_stations = ${n};
int: total_ops = ${input.total_operators};
float: available_minutes = ${input.available_minutes};
int: demand = ${input.demand};
array[1..n_stations] of float: sam = [${input.stations.map((s) => s.sam_per_piece).join(', ')}];

array[1..n_stations] of var 1..total_ops: operators;

% Total operators fixed
constraint sum(operators) = total_ops;

% Each station must be feasible
constraint forall(i in 1..n_stations)(
  operators[i] * available_minutes / sam[i] >= demand
);

% Minimize max utilization (balance the line)
var float: max_util = max(i in 1..n_stations)(
  (demand * sam[i]) / (operators[i] * available_minutes) * 100.0
);

solve minimize max_util;
`;

  const result = solveMzn(model);
  if (!result || !result.operators) return null;

  const ops = result.operators as number[];

  // Compute utilizations from result (MiniZinc may not output var float in JSON)
  const utilizations = input.stations.map((s, i) =>
    (input.demand * s.sam_per_piece) / (ops[i] * input.available_minutes) * 100,
  );
  const maxUtil = Math.max(...utilizations);

  return {
    operators: ops,
    station_assignments: input.stations.map((s, i) => ({
      station: s.name,
      operators_before: s.current_operators,
      operators_after: ops[i],
      utilization_before: s.utilization_pct,
      utilization_after: Math.round(utilizations[i] * 100) / 100,
    })),
    max_utilization_after: Math.round(maxUtil * 100) / 100,
  };
}

// ── Auto-Chain: Optimize → Simulate → Validate ──────────────

export interface OptimizeAndValidateInput {
  optimization_type: 'operators' | 'rebalance';
  config: import('./simulation/models.js').SimulationConfig;
  replications?: number;
}

export interface OptimizeAndValidateResult {
  optimization: OperatorAssignmentResult | RebalancingResult;
  original_throughput: number;
  optimized_throughput: import('./simulation/models.js').DistributionStats;
  demand_met_pct: number;
  improvement_pct: number;
  confidence: string;
  recommendation: string;
}

/**
 * MiniZinc → Sim auto-chain: optimize operators, apply to config,
 * run Monte Carlo, report if the "optimal" solution survives uncertainty.
 * Exported for testing.
 */
export async function optimizeAndValidate(
  input: OptimizeAndValidateInput,
): Promise<OptimizeAndValidateResult | null> {
  const { runSimulation } = await import('./simulation/engine.js');
  const { runMonteCarlo } = await import('./simulation/monte-carlo.js');
  const { getDailyPlannedHours } = await import('./simulation/models.js');

  const config = input.config;
  const reps = input.replications ?? 30;

  // Step 1: Run original config once to get baseline throughput
  const { metrics: baseMetrics } = await runSimulation(config, 42);
  let originalThroughput = 0;
  for (const [, count] of baseMetrics.throughput_by_product) originalThroughput += count;

  // Step 2: Optimize
  const availableMinutes = getDailyPlannedHours(config.schedule) * 60 * (config.horizon_days ?? 1);
  let dailyDemand = 0;
  for (const d of config.demands) {
    if (d.daily_demand) dailyDemand += d.daily_demand;
    else if (d.weekly_demand) dailyDemand += d.weekly_demand / config.schedule.work_days;
    else if (config.mode === 'mix-driven' && config.total_demand && d.mix_share_pct) {
      dailyDemand += config.total_demand * d.mix_share_pct / 100;
    }
  }
  const totalDemand = dailyDemand * (config.horizon_days ?? 1);

  let optimization: OperatorAssignmentResult | RebalancingResult | null;
  const optimizedConfig = { ...config, operations: [...config.operations] };

  if (input.optimization_type === 'operators') {
    // Build station list from unique machine tools
    const toolSam = new Map<string, number>();
    for (const op of config.operations) {
      const current = toolSam.get(op.machine_tool) ?? 0;
      toolSam.set(op.machine_tool, current + op.sam_min);
    }

    const stations = [...toolSam.entries()].map(([name, sam]) => ({ name, sam_per_piece: sam }));
    const result = optimizeOperators({ stations, available_minutes: availableMinutes, demand: Math.ceil(totalDemand) });
    if (!result) return null;
    optimization = result;

    // Apply optimized operators back to config
    const toolOps = new Map<string, number>();
    for (const sa of result.station_assignments) toolOps.set(sa.station, sa.operators);

    optimizedConfig.operations = config.operations.map((op) => {
      const totalForTool = toolOps.get(op.machine_tool);
      if (totalForTool !== undefined) {
        // Distribute equally among operations sharing this tool
        const opsForTool = config.operations.filter((o) => o.machine_tool === op.machine_tool);
        const perOp = Math.max(1, Math.round(totalForTool / opsForTool.length));
        return { ...op, operators: perOp };
      }
      return op;
    });
  } else {
    // Rebalance — use current station performance
    const { calculateAllBlocks } = await import('./simulation/calculations.js');
    const { validateSimulationConfig } = await import('./simulation/validation.js');
    const report = validateSimulationConfig(config);
    const results = calculateAllBlocks(config, baseMetrics, report, 0);

    const totalOps = config.operations.reduce((s, op) => s + (op.operators ?? 1), 0);
    const stations = results.station_performance
      .filter((s, i, arr) => arr.findIndex((x) => x.machine_tool === s.machine_tool) === i)
      .map((s) => ({
        name: s.machine_tool,
        current_operators: s.operators,
        utilization_pct: s.util_pct,
        sam_per_piece: config.operations.filter((op) => op.machine_tool === s.machine_tool).reduce((sum, op) => sum + op.sam_min, 0),
      }));

    const result = rebalanceLine({ stations, total_operators: totalOps, available_minutes: availableMinutes, demand: Math.ceil(totalDemand) });
    if (!result) return null;
    optimization = result;

    // Apply rebalanced operators
    const toolOps = new Map<string, number>();
    for (const sa of result.station_assignments) toolOps.set(sa.station, sa.operators_after);

    optimizedConfig.operations = config.operations.map((op) => {
      const totalForTool = toolOps.get(op.machine_tool);
      if (totalForTool !== undefined) {
        const opsForTool = config.operations.filter((o) => o.machine_tool === op.machine_tool);
        const perOp = Math.max(1, Math.round(totalForTool / opsForTool.length));
        return { ...op, operators: perOp };
      }
      return op;
    });
  }

  // Step 3: Run Monte Carlo on optimized config
  const mc = await runMonteCarlo(optimizedConfig, reps);

  // Step 4: Report
  const improvementPct = originalThroughput > 0
    ? ((mc.throughput.mean - originalThroughput) / originalThroughput) * 100 : 0;

  let confidence: string;
  let recommendation: string;

  if (mc.demand_met_pct >= 95) {
    confidence = 'HIGH';
    recommendation = `Optimized solution meets demand in ${mc.demand_met_pct}% of runs. Safe to implement.`;
  } else if (mc.demand_met_pct >= 80) {
    confidence = 'MEDIUM';
    recommendation = `Optimized solution meets demand in ${mc.demand_met_pct}% of runs. Consider adding buffer capacity.`;
  } else {
    confidence = 'LOW';
    recommendation = `Optimized solution only meets demand in ${mc.demand_met_pct}% of runs. Add operators or reduce demand.`;
  }

  return {
    optimization,
    original_throughput: originalThroughput,
    optimized_throughput: mc.throughput,
    demand_met_pct: mc.demand_met_pct,
    improvement_pct: Math.round(improvementPct * 100) / 100,
    confidence,
    recommendation,
  };
}
