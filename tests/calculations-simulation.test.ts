import { describe, it, expect } from 'vitest';
import {
  calculateSimulationMetrics,
  calculateMonteCarloMetrics,
} from '../src/calculations/simulation.js';
import { validateSimulationConfig } from '../src/simulation/validation.js';
import type { SimulationConfig } from '../src/simulation/models.js';

const MINIMAL_CONFIG: SimulationConfig = {
  operations: [
    {
      product: 'P1',
      step: 1,
      operation: 'Op1',
      machine_tool: 'M1',
      sam_min: 1.0,
    },
    {
      product: 'P1',
      step: 2,
      operation: 'Op2',
      machine_tool: 'M2',
      sam_min: 1.0,
    },
  ],
  schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
  demands: [{ product: 'P1', daily_demand: 100, bundle_size: 1 }],
  horizon_days: 1,
};

describe('calculateSimulationMetrics', () => {
  it('produces 8-block results in standard mode', async () => {
    const report = validateSimulationConfig(MINIMAL_CONFIG);
    const result = await calculateSimulationMetrics(
      { config: MINIMAL_CONFIG, validationReport: report },
      {},
      'standard',
    );
    expect(result.value).toHaveProperty('weekly_demand_capacity');
    expect(result.value).toHaveProperty('daily_summary');
    expect(result.value).toHaveProperty('station_performance');
    expect(result.value).toHaveProperty('free_capacity');
    expect(result.value).toHaveProperty('bundle_metrics');
    expect(result.value).toHaveProperty('per_product_summary');
    expect(result.value).toHaveProperty('rebalancing_suggestions');
    expect(result.value).toHaveProperty('assumption_log');
  });

  it('site-adjusted with no overrides equals standard for the same seed', async () => {
    const report = validateSimulationConfig(MINIMAL_CONFIG);
    const standard = await calculateSimulationMetrics(
      { config: MINIMAL_CONFIG, validationReport: report, seed: 7 },
      {},
      'standard',
    );
    const adjusted = await calculateSimulationMetrics(
      { config: MINIMAL_CONFIG, validationReport: report, seed: 7 },
      {},
      'site_adjusted',
    );
    expect(adjusted.value.daily_summary.daily_throughput_pcs).toBe(
      standard.value.daily_summary.daily_throughput_pcs,
    );
  });

  it('records inputsUsed envelope and seed', async () => {
    const report = validateSimulationConfig(MINIMAL_CONFIG);
    const result = await calculateSimulationMetrics(
      { config: MINIMAL_CONFIG, validationReport: report, seed: 99 },
      {},
      'site_adjusted',
    );
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.operationCount).toBe(2);
    expect(result.inputsUsed.demandCount).toBe(1);
    expect(result.inputsUsed.horizonDays).toBe(1);
    expect(result.inputsUsed.seed).toBe(99);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('default seed is 42 when omitted', async () => {
    const report = validateSimulationConfig(MINIMAL_CONFIG);
    const result = await calculateSimulationMetrics(
      { config: MINIMAL_CONFIG, validationReport: report },
      {},
      'standard',
    );
    expect(result.inputsUsed.seed).toBe(42);
  });
});

describe('calculateMonteCarloMetrics', () => {
  it('runs N replications and aggregates throughput stats', async () => {
    const result = await calculateMonteCarloMetrics(
      { config: MINIMAL_CONFIG, replications: 3 },
      {},
      'standard',
    );
    expect(result.value.replications).toBe(3);
    expect(result.value.throughput).toHaveProperty('mean');
    expect(result.value.throughput).toHaveProperty('p50');
    expect(result.value.cycle_time).toHaveProperty('mean');
  });

  it('site-adjusted with no overrides equals standard at same baseSeed', async () => {
    const standard = await calculateMonteCarloMetrics(
      { config: MINIMAL_CONFIG, replications: 3, baseSeed: 13 },
      {},
      'standard',
    );
    const adjusted = await calculateMonteCarloMetrics(
      { config: MINIMAL_CONFIG, replications: 3, baseSeed: 13 },
      {},
      'site_adjusted',
    );
    expect(adjusted.value.throughput.mean).toBe(standard.value.throughput.mean);
  });

  it('records inputsUsed envelope including resolved replications', async () => {
    const result = await calculateMonteCarloMetrics(
      { config: MINIMAL_CONFIG, replications: 2, baseSeed: 100 },
      {},
      'site_adjusted',
    );
    expect(result.inputsUsed.replications).toBe(2);
    expect(result.inputsUsed.baseSeed).toBe(100);
    expect(result.inputsUsed.operationCount).toBe(2);
    expect(result.assumptionsApplied).toEqual([]);
  });
});
