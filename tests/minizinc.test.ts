import { describe, it, expect, beforeAll } from 'vitest';

import {
  isMiniZincAvailable,
  solveMzn,
  optimizeOperators,
  optimizeSequence,
  optimizeSchedule,
  rebalanceLine,
  optimizeAndValidate,
} from '../src/minizinc.js';

// MiniZinc tests require the solver to be installed.
// Skip gracefully if not available.
const MZN_AVAILABLE = isMiniZincAvailable();
const describeIfMzn = MZN_AVAILABLE ? describe : describe.skip;

describeIfMzn('MiniZinc Solver', () => {
  it('solveMzn returns parsed JSON for simple model', () => {
    const model = 'var int: x; constraint x > 0; constraint x < 5; solve satisfy;';
    const result = solveMzn(model);
    expect(result).not.toBeNull();
    expect(result!.x).toBeGreaterThan(0);
    expect(result!.x).toBeLessThan(5);
  });

  it('solveMzn returns null for infeasible model', () => {
    const model = 'var int: x; constraint x > 10; constraint x < 5; solve satisfy;';
    const result = solveMzn(model);
    // MiniZinc returns UNSATISFIABLE — no JSON output
    expect(result).toBeNull();
  });
});

describeIfMzn('Model 1: Operator Assignment', () => {
  it('minimizes operators while meeting demand', () => {
    const result = optimizeOperators({
      stations: [
        { name: 'Cutting', sam_per_piece: 2.0 },
        { name: 'Sewing', sam_per_piece: 6.0 },
        { name: 'QC', sam_per_piece: 1.0 },
      ],
      available_minutes: 480,
      demand: 200,
    });

    expect(result).not.toBeNull();
    expect(result!.total_operators).toBeGreaterThan(0);

    // Verify constraints: each station can meet demand
    for (const sa of result!.station_assignments) {
      expect(sa.capacity).toBeGreaterThanOrEqual(200);
    }

    // Sewing (6.0 SAM) should get the most operators
    const sewing = result!.station_assignments.find((s) => s.station === 'Sewing');
    const cutting = result!.station_assignments.find((s) => s.station === 'Cutting');
    expect(sewing!.operators).toBeGreaterThanOrEqual(cutting!.operators);
  });

  it('returns minimum feasible allocation', () => {
    // With exact SAM match: 480 min / 2.0 SAM = 240 capacity per operator
    // Need 200 demand → 1 operator is enough for 2.0 SAM station
    const result = optimizeOperators({
      stations: [{ name: 'Station', sam_per_piece: 2.0 }],
      available_minutes: 480,
      demand: 200,
    });
    expect(result!.total_operators).toBe(1);
    expect(result!.station_assignments[0].capacity).toBeGreaterThanOrEqual(200);
  });
});

describeIfMzn('Model 2: Production Sequencing', () => {
  it('minimizes total changeover time', () => {
    const result = optimizeSequence({
      products: ['A', 'B', 'C', 'D'],
      changeover_matrix: [
        [0, 15, 30, 10],
        [15, 0, 20, 25],
        [30, 20, 0, 35],
        [10, 25, 35, 0],
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.sequence).toHaveLength(4);
    expect(result!.product_order).toHaveLength(4);
    expect(result!.total_changeover_minutes).toBeGreaterThan(0);

    // Verify all products appear in sequence
    expect(new Set(result!.product_order).size).toBe(4);

    // Verify total matches sum of transitions
    let total = 0;
    for (let i = 0; i < result!.sequence.length - 1; i++) {
      const from = result!.sequence[i] - 1;
      const to = result!.sequence[i + 1] - 1;
      total += [
        [0, 15, 30, 10],
        [15, 0, 20, 25],
        [30, 20, 0, 35],
        [10, 25, 35, 0],
      ][from][to];
    }
    expect(result!.total_changeover_minutes).toBe(total);
  });

  it('handles 2 products', () => {
    const result = optimizeSequence({
      products: ['X', 'Y'],
      changeover_matrix: [[0, 10], [20, 0]],
    });
    expect(result).not.toBeNull();
    expect(result!.total_changeover_minutes).toBe(10); // X→Y = 10 (cheaper than Y→X = 20)
  });

  it('handles single product', () => {
    const result = optimizeSequence({
      products: ['Only'],
      changeover_matrix: [[0]],
    });
    expect(result).not.toBeNull();
    expect(result!.total_changeover_minutes).toBe(0);
  });
});

describeIfMzn('Model 3: Shift Scheduling', () => {
  it('minimizes cost while meeting daily demand', () => {
    const result = optimizeSchedule({
      days: 5,
      shifts_per_day: 2,
      min_operators_per_shift: 3,
      max_operators_per_shift: 15,
      demand_per_day: [200, 250, 180, 220, 200],
      capacity_per_operator_per_shift: 20,
      operator_cost_per_shift: 150,
    });

    expect(result).not.toBeNull();
    expect(result!.schedule).toHaveLength(5); // 5 days
    expect(result!.schedule[0]).toHaveLength(2); // 2 shifts per day
    expect(result!.total_cost).toBeGreaterThan(0);

    // Verify each day meets demand
    for (let d = 0; d < 5; d++) {
      expect(result!.daily_capacity[d]).toBeGreaterThanOrEqual([200, 250, 180, 220, 200][d]);
    }

    // Day 2 (250 demand) should have more operators than day 3 (180)
    const day2ops = result!.schedule[1].reduce((s, v) => s + v, 0);
    const day3ops = result!.schedule[2].reduce((s, v) => s + v, 0);
    expect(day2ops).toBeGreaterThanOrEqual(day3ops);
  });
});

describeIfMzn('Model 4: Line Rebalancing', () => {
  it('redistributes operators to minimize max utilization', () => {
    const result = rebalanceLine({
      stations: [
        { name: 'Cutting', current_operators: 2, utilization_pct: 55, sam_per_piece: 2.0 },
        { name: 'Sewing', current_operators: 3, utilization_pct: 92, sam_per_piece: 6.0 },
        { name: 'QC', current_operators: 2, utilization_pct: 40, sam_per_piece: 1.5 },
      ],
      total_operators: 7,
      available_minutes: 480,
      demand: 200,
    });

    expect(result).not.toBeNull();

    // Total operators preserved
    const totalAfter = result!.operators.reduce((s, v) => s + v, 0);
    expect(totalAfter).toBe(7);

    // Max utilization should be reasonable
    expect(result!.max_utilization_after).toBeGreaterThan(0);
    expect(result!.max_utilization_after).toBeLessThan(200);

    // Sewing should get the most operators (highest SAM)
    const sewingAfter = result!.station_assignments.find((s) => s.station === 'Sewing')!.operators_after;
    expect(sewingAfter).toBeGreaterThanOrEqual(2);
  });
});

describeIfMzn('Auto-Chain: Optimize → Simulate → Validate', () => {
  it('runs full pipeline and produces confidence report', async () => {
    const config = {
      operations: [
        { product: 'T', step: 1, operation: 'Cut', machine_tool: 'Cutter', sam_min: 2.0, operators: 1 },
        { product: 'T', step: 2, operation: 'Sew', machine_tool: 'Sewing', sam_min: 3.0, operators: 1 },
        { product: 'T', step: 3, operation: 'QC', machine_tool: 'QC', sam_min: 1.0, operators: 1 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'T', bundle_size: 5, daily_demand: 100 }],
      mode: 'demand-driven' as const,
      horizon_days: 1,
    };

    const result = await optimizeAndValidate({
      optimization_type: 'operators',
      config,
      replications: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.original_throughput).toBeGreaterThan(0);
    expect(result!.optimized_throughput.mean).toBeGreaterThan(0);
    expect(result!.demand_met_pct).toBeGreaterThanOrEqual(0);
    expect(result!.demand_met_pct).toBeLessThanOrEqual(100);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(result!.confidence);
    expect(result!.recommendation.length).toBeGreaterThan(0);

    // Optimized should be >= original throughput
    expect(result!.optimized_throughput.mean).toBeGreaterThanOrEqual(result!.original_throughput);
  });

  it('rebalance mode works', async () => {
    const config = {
      operations: [
        { product: 'T', step: 1, operation: 'Op1', machine_tool: 'T1', sam_min: 1.0, operators: 3 },
        { product: 'T', step: 2, operation: 'Op2', machine_tool: 'T2', sam_min: 2.0, operators: 2 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'T', bundle_size: 5, daily_demand: 100 }],
      mode: 'demand-driven' as const,
      horizon_days: 1,
    };

    const result = await optimizeAndValidate({
      optimization_type: 'rebalance',
      config,
      replications: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeTruthy();
  });
});

// Always run this test
describe('MiniZinc availability check', () => {
  it('isMiniZincAvailable returns boolean', () => {
    const available = isMiniZincAvailable();
    expect(typeof available).toBe('boolean');
    if (!available) {
      console.log('MiniZinc not installed — optimization tests skipped. Install with: brew install minizinc');
    }
  });
});
