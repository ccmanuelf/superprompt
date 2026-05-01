import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRecentResult,
  getRecentResult,
  clearRecentResult,
  _clearAllRecentResults,
} from '../src/calculations/recent-results.js';
import { maybeRecordRecent } from '../src/calculations/handler-boundary.js';
import type { CalculationResult } from '../src/calculations/types.js';

beforeEach(() => {
  _clearAllRecentResults();
});

function fakeResult(mode: 'standard' | 'site_adjusted' = 'site_adjusted'): CalculationResult<{ x: number }> {
  return {
    value: { x: 42 },
    mode,
    inputsUsed: { sample: 'input' },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}

describe('recordRecentResult / getRecentResult', () => {
  it('round-trips a result keyed by chatId', () => {
    recordRecentResult('user-1', 'capacity', 'Capacity: My Plan', fakeResult());
    const got = getRecentResult('user-1');
    expect(got).toBeTruthy();
    expect(got!.metricName).toBe('capacity');
    expect(got!.label).toBe('Capacity: My Plan');
    expect(got!.result.value).toEqual({ x: 42 });
  });

  it('different chatIds get different stashes', () => {
    recordRecentResult('user-1', 'capacity', 'A', fakeResult());
    recordRecentResult('user-2', 'simulation', 'B', fakeResult());
    expect(getRecentResult('user-1')!.metricName).toBe('capacity');
    expect(getRecentResult('user-2')!.metricName).toBe('simulation');
  });

  it('overwrite-most-recent semantics: only one stashed per chatId', () => {
    recordRecentResult('user-1', 'capacity', 'first', fakeResult());
    recordRecentResult('user-1', 'simulation', 'second', fakeResult());
    expect(getRecentResult('user-1')!.label).toBe('second');
  });

  it('empty chatId is a no-op', () => {
    recordRecentResult('', 'capacity', 'no-id', fakeResult());
    expect(getRecentResult('')).toBeUndefined();
  });

  it('returns undefined when nothing stashed', () => {
    expect(getRecentResult('never-set')).toBeUndefined();
  });
});

describe('clearRecentResult', () => {
  it('removes a stashed result and reports true', () => {
    recordRecentResult('user-1', 'capacity', 'A', fakeResult());
    expect(clearRecentResult('user-1')).toBe(true);
    expect(getRecentResult('user-1')).toBeUndefined();
  });

  it('returns false when nothing was there', () => {
    expect(clearRecentResult('never-set')).toBe(false);
  });
});

describe('maybeRecordRecent — handler-boundary integration', () => {
  it('stashes site_adjusted results', () => {
    maybeRecordRecent('user-1', 'capacity', 'site label', fakeResult('site_adjusted'));
    expect(getRecentResult('user-1')).toBeTruthy();
  });

  it('skips standard results', () => {
    maybeRecordRecent('user-1', 'capacity', 'std label', fakeResult('standard'));
    expect(getRecentResult('user-1')).toBeUndefined();
  });

  it('skips empty chatId even in site_adjusted mode', () => {
    maybeRecordRecent('', 'capacity', 'no-id', fakeResult('site_adjusted'));
    expect(getRecentResult('')).toBeUndefined();
  });
});
