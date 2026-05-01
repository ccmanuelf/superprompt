import { describe, it, expect } from 'vitest';
import {
  calculateDispatchSchedule,
  calculateRuleComparison,
  calculateGeneticSchedule,
} from '../src/calculations/sequencer.js';
import type { SequencerConfig } from '../src/sequencer/models.js';

const SAMPLE_CONFIG: SequencerConfig = {
  name: 'Test Shop',
  jobs: [
    { id: 'J1', name: 'Job 1', product: 'A', quantity: 1, processing_minutes: 30, due_date: '2026-04-30T17:00:00' },
    { id: 'J2', name: 'Job 2', product: 'B', quantity: 1, processing_minutes: 20, due_date: '2026-04-30T18:00:00' },
    { id: 'J3', name: 'Job 3', product: 'A', quantity: 1, processing_minutes: 45, due_date: '2026-04-30T19:00:00' },
    { id: 'J4', name: 'Job 4', product: 'C', quantity: 1, processing_minutes: 15, due_date: '2026-04-30T16:00:00' },
  ],
  machines: [
    { id: 'M1', name: 'Machine 1', capacity_hours_per_day: 8 },
  ],
  planning_start_date: '2026-04-30',
  working_hours_per_day: 8,
};

describe('calculateDispatchSchedule', () => {
  it('produces a schedule with metrics for SPT rule', () => {
    const result = calculateDispatchSchedule(
      { config: SAMPLE_CONFIG, rule: 'SPT' },
      {},
      'standard',
    );
    expect(result.value.rule_or_method).toBe('SPT');
    expect(result.value.entries.length).toBeGreaterThan(0);
    expect(typeof result.value.metrics.makespan).toBe('number');
  });

  it('site-adjusted with no overrides equals standard', () => {
    const standard = calculateDispatchSchedule(
      { config: SAMPLE_CONFIG, rule: 'EDD' },
      {},
      'standard',
    );
    const adjusted = calculateDispatchSchedule(
      { config: SAMPLE_CONFIG, rule: 'EDD' },
      {},
      'site_adjusted',
    );
    expect(adjusted.value.metrics.makespan).toBe(standard.value.metrics.makespan);
    expect(adjusted.value.metrics.total_lateness).toBe(
      standard.value.metrics.total_lateness,
    );
  });

  it('records inputsUsed envelope', () => {
    const result = calculateDispatchSchedule(
      { config: SAMPLE_CONFIG, rule: 'FIFO' },
      {},
      'site_adjusted',
    );
    expect(result.inputsUsed.rule).toBe('FIFO');
    expect(result.inputsUsed.jobCount).toBe(4);
    expect(result.inputsUsed.machineCount).toBe(1);
    expect(result.inputsUsed.hasSetupMatrix).toBe(false);
    expect(result.assumptionsApplied).toEqual([]);
  });
});

describe('calculateRuleComparison', () => {
  it('runs every dispatching rule and identifies bests', () => {
    const result = calculateRuleComparison(SAMPLE_CONFIG, {}, 'standard');
    expect(result.value.rules.length).toBeGreaterThan(0);
    expect(result.value.best_overall).toBeTruthy();
  });

  it('site-adjusted with no overrides equals standard', () => {
    const standard = calculateRuleComparison(SAMPLE_CONFIG, {}, 'standard');
    const adjusted = calculateRuleComparison(SAMPLE_CONFIG, {}, 'site_adjusted');
    expect(adjusted.value.best_overall).toBe(standard.value.best_overall);
  });
});

describe('calculateGeneticSchedule', () => {
  it('runs GA and returns best fitness', () => {
    const result = calculateGeneticSchedule(
      {
        config: SAMPLE_CONFIG,
        gaConfig: { population_size: 20, generations: 30 },
      },
      {},
      'standard',
    );
    expect(result.value.rule_or_method).toBe('GA');
    expect(typeof result.value.best_fitness).toBe('number');
    expect(result.value.fitness_history.length).toBeGreaterThan(0);
  });

  it('records inputsUsed envelope including GA hyperparameters', () => {
    const result = calculateGeneticSchedule(
      {
        config: SAMPLE_CONFIG,
        gaConfig: { population_size: 20, generations: 30, objective: 'makespan' },
      },
      {},
      'site_adjusted',
    );
    expect(result.inputsUsed.populationSize).toBe(20);
    expect(result.inputsUsed.generations).toBe(30);
    expect(result.inputsUsed.objective).toBe('makespan');
    expect(result.assumptionsApplied).toEqual([]);
  });

  it('omitted GA config surfaces as null in inputsUsed', () => {
    const result = calculateGeneticSchedule(
      { config: SAMPLE_CONFIG },
      {},
      'standard',
    );
    expect(result.inputsUsed.populationSize).toBeNull();
    expect(result.inputsUsed.generations).toBeNull();
  });
});
