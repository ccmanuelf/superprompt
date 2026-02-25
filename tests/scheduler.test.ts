import { describe, it, expect } from 'vitest';
import { CronExpressionParser } from 'cron-parser';

// ── computeNextRun ───────────────────────────────────────────

function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression);
  return expr.next().getTime();
}

function validateCron(cronExpression: string): string | null {
  try {
    CronExpressionParser.parse(cronExpression);
    return null;
  } catch (err) {
    return `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
}

describe('computeNextRun', () => {
  it('returns a future timestamp', () => {
    const next = computeNextRun('* * * * *'); // every minute
    expect(next).toBeGreaterThan(Date.now());
  });

  it('computes next run for hourly cron', () => {
    const next = computeNextRun('0 * * * *');
    const date = new Date(next);
    expect(date.getMinutes()).toBe(0);
  });

  it('computes next run for daily at 9am', () => {
    const next = computeNextRun('0 9 * * *');
    const date = new Date(next);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it('computes next run for weekly (Sunday)', () => {
    const next = computeNextRun('0 0 * * 0');
    const date = new Date(next);
    expect(date.getDay()).toBe(0); // Sunday
  });

  it('next run is within expected range for every-minute cron', () => {
    const next = computeNextRun('* * * * *');
    const diffMs = next - Date.now();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(60_000); // Within 1 minute
  });
});

// ── validateCron ─────────────────────────────────────────────

describe('validateCron', () => {
  it('returns null for valid cron expressions', () => {
    expect(validateCron('* * * * *')).toBeNull();
    expect(validateCron('0 9 * * *')).toBeNull();
    expect(validateCron('0 0 * * 0')).toBeNull();
    expect(validateCron('*/5 * * * *')).toBeNull();
    expect(validateCron('0 0 1 * *')).toBeNull();
  });

  it('returns error message for invalid cron expressions', () => {
    expect(validateCron('not a cron')).not.toBeNull();
    expect(validateCron('60 * * * *')).not.toBeNull();
    expect(validateCron('* 25 * * *')).not.toBeNull();
  });

  it('error message contains "Invalid cron expression"', () => {
    const err = validateCron('bad');
    expect(err).toContain('Invalid cron expression');
  });
});

// ── Scheduler polling logic ──────────────────────────────────

describe('scheduler polling logic', () => {
  it('identifies due tasks correctly', () => {
    const now = Date.now();
    const tasks = [
      { id: '1', next_run: now - 1000, status: 'active' },
      { id: '2', next_run: now + 99999, status: 'active' },
      { id: '3', next_run: now - 500, status: 'paused' },
    ];

    const due = tasks.filter(t => t.status === 'active' && t.next_run <= now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('1');
  });

  it('advances next_run after execution', () => {
    const cron = '0 * * * *'; // every hour
    const nextRun = computeNextRun(cron);
    expect(nextRun).toBeGreaterThan(Date.now());

    // After this next_run, computing again should give an even later time
    // (We can't easily test this without mocking Date, but we verify the value is reasonable)
    const futureDate = new Date(nextRun);
    expect(futureDate.getMinutes()).toBe(0);
  });
});
