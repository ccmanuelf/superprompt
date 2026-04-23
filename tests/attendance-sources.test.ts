/**
 * Tests for the three data sources + the selector fallback chain.
 *
 * These are pure-unit tests — no DB, no filesystem beyond tmp fixture
 * files the test suite writes itself. The selector's dependencies are
 * injected so we can simulate "API is down, CSV is up" without standing
 * anything real up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AttendanceDataSource,
  AttendanceDataSourceConfig,
  ColumnMapping,
  CsvSourceConfig,
  ApiSourceConfig,
} from '../src/attendance/types.js';
import { CsvAttendanceSource } from '../src/attendance/sources/csv.js';
import { ApiAttendanceSource } from '../src/attendance/sources/api.js';
import { SupervisorSensorSource } from '../src/attendance/sources/supervisor-sensor.js';
import { selectAttendanceSource } from '../src/attendance/sources/selector.js';

const now = Date.now();

function mkMapping(fields: Record<string, string>): ColumnMapping {
  return {
    id: 'map1',
    moduleId: 'M1',
    dataType: 'roster',
    fields,
    samplePreview: [],
    createdAt: now,
    updatedAt: now,
  };
}

function mkCsvConfig(filePath: string): AttendanceDataSourceConfig {
  const config: CsvSourceConfig = { kind: 'csv', filePath, columnMappingId: 'map1' };
  return {
    id: 'ds1', moduleId: 'M1', dataType: 'roster',
    preferredKind: 'csv', config, enabled: true,
    createdAt: now, updatedAt: now,
  };
}

function mkApiConfig(endpointUrl: string): AttendanceDataSourceConfig {
  const config: ApiSourceConfig = { kind: 'api', endpointUrl, authMethod: 'none' };
  return {
    id: 'ds2', moduleId: 'M1', dataType: 'roster',
    preferredKind: 'api', config, enabled: true,
    createdAt: now, updatedAt: now,
  };
}

// ── CsvAttendanceSource ──────────────────────────────────────

describe('CsvAttendanceSource', () => {
  let tmpDir: string;
  let csvPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'luna-csv-src-'));
    csvPath = join(tmpDir, 'roster.csv');
    writeFileSync(csvPath,
      'BadgeNumber,FullName,CostCenter,LaborType,Line,Supervisor\n' +
      '001,Alice,CC1,direct,L1,Doe\n' +
      '002,Bob,CC2,direct,L2,Doe\n');
  });

  it('healthCheck returns available when file + mapping are present', async () => {
    const src = new CsvAttendanceSource('M1', 'roster', { kind: 'csv', filePath: csvPath, columnMappingId: 'map1' }, {
      getMapping: async () => mkMapping({
        badge_id: 'BadgeNumber', full_name: 'FullName', cost_center: 'CostCenter',
        labor_type: 'LaborType', line: 'Line', supervisor_name: 'Supervisor',
      }),
      getSiteIdForModule: async () => 'S1',
    });
    const h = await src.healthCheck();
    expect(h.available).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('healthCheck fails when file is missing', async () => {
    const src = new CsvAttendanceSource('M1', 'roster', { kind: 'csv', filePath: '/nonexistent.csv', columnMappingId: 'map1' }, {
      getMapping: async () => null,
      getSiteIdForModule: async () => 'S1',
    });
    const h = await src.healthCheck();
    expect(h.available).toBe(false);
    expect(h.reason).toMatch(/not found/);
  });

  it('healthCheck fails when no mapping is configured', async () => {
    const src = new CsvAttendanceSource('M1', 'roster', { kind: 'csv', filePath: csvPath, columnMappingId: 'map1' }, {
      getMapping: async () => null,
      getSiteIdForModule: async () => 'S1',
    });
    const h = await src.healthCheck();
    expect(h.available).toBe(false);
    expect(h.reason).toMatch(/mapping/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getRoster emits normalised RosterEntry objects', async () => {
    const src = new CsvAttendanceSource('M1', 'roster', { kind: 'csv', filePath: csvPath, columnMappingId: 'map1' }, {
      getMapping: async () => mkMapping({
        badge_id: 'BadgeNumber', full_name: 'FullName', cost_center: 'CostCenter',
        labor_type: 'LaborType', line: 'Line', supervisor_name: 'Supervisor',
      }),
      getSiteIdForModule: async () => 'S1',
    });
    const roster = await src.getRoster('2026-04-23');
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({
      badgeId: '001', fullName: 'Alice', costCenter: 'CC1', laborType: 'direct', line: 'L1',
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws if asked for badge records when configured for roster', async () => {
    const src = new CsvAttendanceSource('M1', 'roster', { kind: 'csv', filePath: csvPath, columnMappingId: 'map1' }, {
      getMapping: async () => mkMapping({ badge_id: 'BadgeNumber' }),
      getSiteIdForModule: async () => 'S1',
    });
    await expect(src.getBadgeRecords('2026-04-23')).rejects.toThrow(/cannot serve badge/);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── ApiAttendanceSource ──────────────────────────────────────

describe('ApiAttendanceSource', () => {
  it('healthCheck returns unavailable when endpointUrl is empty', async () => {
    const src = new ApiAttendanceSource('M1', 'roster', {
      kind: 'api', endpointUrl: '', authMethod: 'none',
    });
    const h = await src.healthCheck();
    expect(h.available).toBe(false);
    expect(h.reason).toMatch(/not configured/);
  });

  it('healthCheck returns unavailable when endpoint unreachable', async () => {
    const src = new ApiAttendanceSource('M1', 'roster', {
      kind: 'api', endpointUrl: 'http://127.0.0.1:1/nonexistent', authMethod: 'none',
    });
    const h = await src.healthCheck();
    expect(h.available).toBe(false);
  });

  it('healthCheck returns available on 200', async () => {
    const fetchFn = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const src = new ApiAttendanceSource(
      'M1', 'roster',
      { kind: 'api', endpointUrl: 'http://mock/roster', authMethod: 'none' },
      { fetchFn },
    );
    const h = await src.healthCheck();
    expect(h.available).toBe(true);
  });

  it('healthCheck tolerates 405 Method Not Allowed on HEAD', async () => {
    const fetchFn = (async () => ({ ok: false, status: 405 })) as unknown as typeof fetch;
    const src = new ApiAttendanceSource(
      'M1', 'roster',
      { kind: 'api', endpointUrl: 'http://mock/roster', authMethod: 'none' },
      { fetchFn },
    );
    const h = await src.healthCheck();
    expect(h.available).toBe(true);
  });

  it('getRoster throws with a helpful implement-me message', async () => {
    const src = new ApiAttendanceSource('M1', 'roster', {
      kind: 'api', endpointUrl: 'http://mock', authMethod: 'none',
    });
    await expect(src.getRoster('2026-04-23')).rejects.toThrow(/not implemented/);
  });
});

// ── SupervisorSensorSource ───────────────────────────────────

describe('SupervisorSensorSource', () => {
  const stubRoster: AttendanceDataSource = {
    kind: 'csv',
    moduleId: 'M1',
    async healthCheck() { return { available: true }; },
    async getRoster() {
      return [{
        badgeId: '001', fullName: 'Alice', costCenter: 'CC1', laborType: 'direct',
        line: 'L1', moduleId: 'M1', supervisorName: 'Doe', rawRow: {},
      }];
    },
    async getBadgeRecords() { return []; },
  };

  it('forwards roster to the wrapped source', async () => {
    const src = new SupervisorSensorSource('M1', stubRoster);
    const roster = await src.getRoster('2026-04-23');
    expect(roster).toHaveLength(1);
  });

  it('returns empty badge records (the whole point)', async () => {
    const src = new SupervisorSensorSource('M1', stubRoster);
    const badges = await src.getBadgeRecords('2026-04-23');
    expect(badges).toEqual([]);
  });

  it('is unavailable when the wrapped roster source is unavailable', async () => {
    const unhealthyRoster: AttendanceDataSource = {
      ...stubRoster,
      async healthCheck() { return { available: false, reason: 'test' }; },
    };
    const src = new SupervisorSensorSource('M1', unhealthyRoster);
    const h = await src.healthCheck();
    expect(h.available).toBe(false);
    expect(h.reason).toMatch(/roster source unavailable/);
  });
});

// ── Selector — fallback chain ────────────────────────────────

describe('selectAttendanceSource', () => {
  let tmpDir: string;
  let csvPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'luna-selector-'));
    csvPath = join(tmpDir, 'roster.csv');
    writeFileSync(csvPath,
      'BadgeNumber,FullName,LaborType,Line\n' +
      '001,Alice,direct,L1\n');
  });

  it('returns the preferred source when it is healthy (roster)', async () => {
    const source = await selectAttendanceSource('M1', 'roster', {
      getDataSourceConfig: async () => mkCsvConfig(csvPath),
      getMapping: async () => mkMapping({
        badge_id: 'BadgeNumber', full_name: 'FullName',
        labor_type: 'LaborType', line: 'Line',
      }),
      getSiteIdForModule: async () => 'S1',
    });
    expect(source.kind).toBe('csv');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls through to CSV when preferred API is unreachable', async () => {
    // Config says api, but the endpoint is empty → api healthCheck fails.
    // CSV has no explicit config, so it should also fail, then selector
    // throws. Verifies we don't silently return the wrong source.
    await expect(
      selectAttendanceSource('M1', 'roster', {
        getDataSourceConfig: async () => mkApiConfig(''),
        getMapping: async () => null,
        getSiteIdForModule: async () => 'S1',
      }),
    ).rejects.toThrow(/No attendance source available/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when every source in the chain is unavailable (clear message)', async () => {
    // No config at all: preferred unknown, CSV no path, API no URL.
    await expect(
      selectAttendanceSource('M1', 'roster', {
        getDataSourceConfig: async () => null,
        getMapping: async () => null,
        getSiteIdForModule: async () => 'S1',
      }),
    ).rejects.toThrow(/No attendance source available for module=M1/);
  });

  it('supervisor-sensor is only eligible for badge, not roster', async () => {
    // Even if we somehow tried to use supervisor-sensor for roster, the
    // selector should reject it. Here the config claims supervisor-sensor
    // is preferred for roster — the selector should skip it entirely.
    const cfg: AttendanceDataSourceConfig = {
      id: 'ds3', moduleId: 'M1', dataType: 'roster',
      preferredKind: 'supervisor-sensor', config: {}, enabled: true,
      createdAt: now, updatedAt: now,
    };
    await expect(
      selectAttendanceSource('M1', 'roster', {
        getDataSourceConfig: async () => cfg,
        getMapping: async () => null,
        getSiteIdForModule: async () => 'S1',
      }),
    ).rejects.toThrow(/No attendance source/);
  });

  it('falls back to supervisor-sensor for BADGE when CSV badge config is missing but roster CSV exists', async () => {
    // Roster has a CSV config, badge has NO config → supervisor-sensor
    // is the final fallback in the badge chain.
    const getDataSourceConfig = async (
      _moduleId: string,
      dataType: 'roster' | 'badge',
    ): Promise<AttendanceDataSourceConfig | null> => {
      if (dataType === 'roster') {
        return {
          ...mkCsvConfig(csvPath),
          dataType: 'roster',
        };
      }
      return null;
    };

    const source = await selectAttendanceSource('M1', 'badge', {
      getDataSourceConfig,
      getMapping: async () => mkMapping({
        badge_id: 'BadgeNumber', full_name: 'FullName',
        labor_type: 'LaborType', line: 'Line',
      }),
      getSiteIdForModule: async () => 'S1',
    });
    expect(source.kind).toBe('supervisor-sensor');
    const badges = await source.getBadgeRecords('2026-04-23');
    expect(badges).toEqual([]);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
