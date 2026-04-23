/**
 * Source selector (rc.88).
 *
 * Per (module, data_type) pair, loads the configured preference from
 * `attendance_data_sources` and returns a live AttendanceDataSource
 * instance. If the preferred source's healthCheck fails, walks an
 * ordered fallback chain.
 *
 * Fallback policy for roster:
 *   api → csv → (no fallback; throw — we need SOMETHING here)
 *
 * Fallback policy for badge:
 *   api → csv → supervisor-sensor
 *
 * The supervisor-sensor only appears in the badge chain because it has
 * nothing useful to say about roster data (see its module comment). If
 * the configured preferred source is already valid, no chain is walked —
 * we don't do a health probe on a healthy primary.
 *
 * Every selection is logged so operations can tell which source a given
 * day's data actually came from.
 */
import type {
  AttendanceDataSource,
  AttendanceDataSourceConfig,
  ColumnMapping,
  CsvSourceConfig,
  ApiSourceConfig,
} from '../types.js';
import { CsvAttendanceSource, type CsvSourceDeps } from './csv.js';
import { ApiAttendanceSource } from './api.js';
import { SupervisorSensorSource } from './supervisor-sensor.js';
import { logger } from '../../logger.js';

export interface SelectorDeps extends CsvSourceDeps {
  /** Loads the data source config for a (module, data_type) pair. */
  getDataSourceConfig: (
    moduleId: string,
    dataType: 'roster' | 'badge',
  ) => Promise<AttendanceDataSourceConfig | null>;
  /** Loads the column mapping row — passed into CsvAttendanceSource. */
  getMapping: (
    moduleId: string,
    dataType: 'roster' | 'badge',
  ) => Promise<ColumnMapping | null>;
}

const BADGE_CHAIN: Array<'api' | 'csv' | 'supervisor-sensor'> = ['api', 'csv', 'supervisor-sensor'];
const ROSTER_CHAIN: Array<'api' | 'csv'> = ['api', 'csv'];

export async function selectAttendanceSource(
  moduleId: string,
  dataType: 'roster' | 'badge',
  deps: SelectorDeps,
): Promise<AttendanceDataSource> {
  const config = await deps.getDataSourceConfig(moduleId, dataType);
  const chain = dataType === 'badge' ? BADGE_CHAIN : ROSTER_CHAIN;

  // Build the ordered try-list: preferred kind first, then the remaining
  // chain in declared order. De-duplicate so we don't try the same kind
  // twice when the operator's preference already matches the chain head.
  const preferred = config?.preferredKind ?? chain[0];
  const tryOrder = [preferred, ...chain.filter((k) => k !== preferred)];

  const attempts: Array<{ kind: string; reason: string }> = [];

  for (const kind of tryOrder) {
    const source = await instantiateSource(moduleId, dataType, kind, config, deps);
    if (!source) {
      attempts.push({ kind, reason: 'no source implementation for kind' });
      continue;
    }
    const health = await source.healthCheck();
    if (health.available) {
      logger.info(
        { moduleId, dataType, selected: kind, attempts },
        'Attendance source selected',
      );
      return source;
    }
    attempts.push({ kind, reason: health.reason ?? 'unavailable' });
  }

  throw new Error(
    `No attendance source available for module=${moduleId} type=${dataType}. ` +
    `Attempts: ${attempts.map((a) => `${a.kind}=${a.reason}`).join('; ')}`,
  );
}

async function instantiateSource(
  moduleId: string,
  dataType: 'roster' | 'badge',
  kind: 'csv' | 'api' | 'supervisor-sensor',
  config: AttendanceDataSourceConfig | null,
  deps: SelectorDeps,
): Promise<AttendanceDataSource | null> {
  switch (kind) {
    case 'csv': {
      // Operator may have configured a different kind as preferred; the
      // CSV entry in the fallback chain should still work IF a CSV config
      // happens to exist. We pull from the same config blob when the
      // active preferred is CSV, otherwise stitch a minimal config from
      // environment defaults is NOT done — CSV requires an explicit file.
      const csvConfig = (config?.preferredKind === 'csv' && config.config)
        ? (config.config as CsvSourceConfig)
        : null;
      if (!csvConfig || !csvConfig.filePath) return null;
      return new CsvAttendanceSource(moduleId, dataType, csvConfig, deps);
    }
    case 'api': {
      const apiConfig = (config?.preferredKind === 'api' && config.config)
        ? (config.config as ApiSourceConfig)
        : null;
      if (!apiConfig || !apiConfig.endpointUrl) return null;
      return new ApiAttendanceSource(moduleId, dataType, apiConfig);
    }
    case 'supervisor-sensor': {
      if (dataType !== 'badge') return null;
      // Need a working roster source to ride on top of.
      try {
        const rosterSource = await selectAttendanceSource(moduleId, 'roster', deps);
        return new SupervisorSensorSource(moduleId, rosterSource);
      } catch {
        return null;
      }
    }
  }
}
