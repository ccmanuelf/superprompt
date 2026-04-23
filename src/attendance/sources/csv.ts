/**
 * CSV data source (rc.88).
 *
 * Reads a configured file path through parser.ts + validation.ts and
 * emits normalised RosterEntry / BadgeRecord arrays. Stateless by design
 * — the file path and the column-mapping id are passed in via the
 * AttendanceDataSourceConfig loaded from the DB. Re-running against
 * the same file is idempotent.
 *
 * Note: this class does NOT persist anything. The ingestion orchestrator
 * in ingestion.ts owns DB writes + report generation. Keeping the source
 * layer pure-read makes it trivial to unit-test without a DB.
 */
import { existsSync, statSync } from 'node:fs';
import type {
  AttendanceDataSource,
  RosterEntry,
  BadgeRecord,
  DateOnly,
  ColumnMapping,
  CsvSourceConfig,
} from '../types.js';
import { parseFile } from '../parser.js';
import {
  validateRoster,
  validateBadgeRecords,
} from '../validation.js';

export interface CsvSourceDeps {
  /** Supplied by the selector: resolves the mapping for a (module, data_type). */
  getMapping: (moduleId: string, dataType: 'roster' | 'badge') => Promise<ColumnMapping | null>;
  /** Supplied by the selector: known absence codes for validation warnings. */
  getAbsenceCodes?: (siteId: string) => Promise<Set<string>>;
  /** Known badge ids (roster cache) — used for cross-referencing badge records. */
  getKnownBadgeIds?: (siteId: string) => Promise<Set<string>>;
  /** Resolves the site id for a module. */
  getSiteIdForModule: (moduleId: string) => Promise<string>;
}

export class CsvAttendanceSource implements AttendanceDataSource {
  public readonly kind = 'csv' as const;

  constructor(
    public readonly moduleId: string,
    private readonly dataType: 'roster' | 'badge',
    private readonly config: CsvSourceConfig,
    private readonly deps: CsvSourceDeps,
  ) {}

  async healthCheck(): Promise<{ available: boolean; reason?: string }> {
    if (!this.config.filePath) {
      return { available: false, reason: 'CSV source has no filePath configured' };
    }
    if (!existsSync(this.config.filePath)) {
      return { available: false, reason: `CSV file not found at ${this.config.filePath}` };
    }
    try {
      const s = statSync(this.config.filePath);
      if (s.size === 0) return { available: false, reason: 'CSV file is empty' };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
    const mapping = await this.deps.getMapping(this.moduleId, this.dataType);
    if (!mapping || Object.keys(mapping.fields).length === 0) {
      return { available: false, reason: 'no column mapping configured for this module' };
    }
    return { available: true };
  }

  async getRoster(_date: DateOnly): Promise<RosterEntry[]> {
    if (this.dataType !== 'roster') {
      throw new Error(`CsvAttendanceSource configured for ${this.dataType}, cannot serve roster`);
    }
    const mapping = await this.requireMapping();
    const rows = parseFile(this.config.filePath, {
      mapping: mapping.fields,
      delimiter: this.config.delimiter,
      encoding: this.config.encoding,
    });
    const res = validateRoster(rows, { moduleId: this.moduleId });
    // Warnings/skipped rows are NOT returned here — they belong to the
    // IngestionReport that the orchestrator builds. Sources only yield
    // accepted data.
    return res.accepted;
  }

  async getBadgeRecords(date: DateOnly): Promise<BadgeRecord[]> {
    if (this.dataType !== 'badge') {
      throw new Error(`CsvAttendanceSource configured for ${this.dataType}, cannot serve badge records`);
    }
    const mapping = await this.requireMapping();
    const rows = parseFile(this.config.filePath, {
      mapping: mapping.fields,
      delimiter: this.config.delimiter,
      encoding: this.config.encoding,
    });
    const siteId = await this.deps.getSiteIdForModule(this.moduleId);
    const knownBadgeIds = this.deps.getKnownBadgeIds ? await this.deps.getKnownBadgeIds(siteId) : undefined;
    const res = validateBadgeRecords(rows, {
      moduleId: this.moduleId,
      siteId,
      expectedDate: date,
      knownBadgeIds,
    });
    return res.accepted;
  }

  private async requireMapping(): Promise<ColumnMapping> {
    const m = await this.deps.getMapping(this.moduleId, this.dataType);
    if (!m) {
      throw new Error(
        `CsvAttendanceSource: no column mapping for module=${this.moduleId} type=${this.dataType}. ` +
        `Configure one via the admin UI before ingesting.`,
      );
    }
    return m;
  }
}
