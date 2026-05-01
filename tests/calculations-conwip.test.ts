import { describe, it, expect } from 'vitest';
import {
  calculateConwipMetrics,
  calculateHeijunkaMetrics,
} from '../src/calculations/conwip.js';
import type { CONWIPConfig, HeijunkaConfig } from '../src/conwip/models.js';

const CONWIP_CONFIG: CONWIPConfig = {
  name: 'Test CONWIP',
  stages: [
    { id: 'S1', name: 'Stage 1', sequence: 1, cycle_time_minutes: 5, capacity_per_hour: 12 },
    { id: 'S2', name: 'Stage 2', sequence: 2, cycle_time_minutes: 4, capacity_per_hour: 15 },
    { id: 'S3', name: 'Stage 3', sequence: 3, cycle_time_minutes: 6, capacity_per_hour: 10 },
  ],
  wip_limit: 10,
  products: [
    { id: 'P1', name: 'Product A', mix_pct: 60, cycle_time_minutes: 5, changeover_minutes: 2 },
    { id: 'P2', name: 'Product B', mix_pct: 40, cycle_time_minutes: 5, changeover_minutes: 3 },
  ],
  available_minutes_per_day: 480,
  demand_per_day: 80,
};

const HEIJUNKA_CONFIG: HeijunkaConfig = {
  name: 'Test Heijunka',
  products: [
    { id: 'P1', name: 'Product A', mix_pct: 50, cycle_time_minutes: 5, changeover_minutes: 2 },
    { id: 'P2', name: 'Product B', mix_pct: 30, cycle_time_minutes: 5, changeover_minutes: 3 },
    { id: 'P3', name: 'Product C', mix_pct: 20, cycle_time_minutes: 5, changeover_minutes: 4 },
  ],
  takt_time_minutes: 6,
  pitch_minutes: 30,
  pack_out_quantity: 5,
  slots_per_shift: 16,
  shifts_per_day: 1,
  demand_per_day: 80,
};

describe('calculateConwipMetrics', () => {
  it('produces token flow analysis with bottleneck identification', () => {
    const result = calculateConwipMetrics(CONWIP_CONFIG, {}, 'standard');
    expect(result.value.config_name).toBe('Test CONWIP');
    expect(result.value.stage_utilization).toHaveLength(3);
    expect(result.value.wip_limit).toBe(10);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateConwipMetrics(CONWIP_CONFIG, {}, 'standard');
    const adjusted = calculateConwipMetrics(CONWIP_CONFIG, {}, 'site_adjusted');
    expect(adjusted.value.throughput_per_hour).toBe(standard.value.throughput_per_hour);
    expect(adjusted.value.avg_cycle_time).toBe(standard.value.avg_cycle_time);
  });

  it('records inputsUsed envelope and empty assumptions', () => {
    const result = calculateConwipMetrics(CONWIP_CONFIG, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.stageCount).toBe(3);
    expect(result.inputsUsed.productCount).toBe(2);
    expect(result.inputsUsed.wipLimit).toBe(10);
    expect(result.inputsUsed.demandPerDay).toBe(80);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('calculateHeijunkaMetrics', () => {
  it('produces leveling box and score', () => {
    const result = calculateHeijunkaMetrics(HEIJUNKA_CONFIG, {}, 'standard');
    expect(result.value.config_name).toBe('Test Heijunka');
    expect(result.value.takt_time).toBe(6);
    expect(typeof result.value.leveling_score).toBe('number');
    expect(result.value.heijunka_box.shifts).toBe(1);
  });

  it('site-adjusted with no overrides equals standard', () => {
    const standard = calculateHeijunkaMetrics(HEIJUNKA_CONFIG, {}, 'standard');
    const adjusted = calculateHeijunkaMetrics(HEIJUNKA_CONFIG, {}, 'site_adjusted');
    expect(adjusted.value.leveling_score).toBe(standard.value.leveling_score);
    expect(adjusted.value.changeover_count).toBe(standard.value.changeover_count);
  });

  it('records inputsUsed envelope', () => {
    const result = calculateHeijunkaMetrics(HEIJUNKA_CONFIG, {}, 'site_adjusted');
    expect(result.inputsUsed.taktTimeMinutes).toBe(6);
    expect(result.inputsUsed.packOutQuantity).toBe(5);
    expect(result.inputsUsed.slotsPerShift).toBe(16);
    expect(result.assumptionsApplied).toEqual([]);
  });
});
