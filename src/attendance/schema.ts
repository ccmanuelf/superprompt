/**
 * Attendance schema — TableInitializer for all attendance tables (rc.88).
 *
 * Follows the codebase convention: one async function registered with
 * the Application core at startup; it checks `hasTable()` before creating
 * so reboots are idempotent. Every table uses Knex dialect-agnostic types
 * so the schema works under SQLite (dev/pilot), MariaDB, or PostgreSQL
 * (future production) without change.
 *
 * Foreign keys are declared but deliberately not enforced with `.onDelete`
 * cascades — the lifecycle for attendance data (delete a site?) is not
 * settled, and silent cascades can wipe audit trails. When the product
 * matures, harden this.
 */
import { getKnex } from '../db-knex.js';
import type { TableInitializer } from '../core/interfaces.js';

async function initAttendanceTables(): Promise<void> {
  const db = getKnex();

  // ── Organization hierarchy ────────────────────────────────
  if (!(await db.schema.hasTable('sites'))) {
    await db.schema.createTable('sites', (t) => {
      t.string('id').primary();
      t.string('name').notNullable();          // "Plant B"
      t.string('client_name').notNullable();    // "FRANKLIN PRODUCTS"
      t.string('timezone').notNullable().defaultTo('America/Mexico_City');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }

  if (!(await db.schema.hasTable('shifts'))) {
    await db.schema.createTable('shifts', (t) => {
      t.string('id').primary();
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('name').notNullable();          // "First Shift"
      t.string('clock_start').notNullable();    // "07:00"
      t.string('clock_end').notNullable();      // "17:00"
      t.decimal('billing_hours_mon_thu', 4, 2).notNullable();
      t.decimal('billing_hours_fri', 4, 2).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['site_id']);
    });
  }

  if (!(await db.schema.hasTable('breaks'))) {
    await db.schema.createTable('breaks', (t) => {
      t.string('id').primary();
      t.string('shift_id').notNullable().references('id').inTable('shifts');
      t.string('name').notNullable();          // "Lunch", "Break AM"
      t.integer('duration_minutes').notNullable();
      t.boolean('paid').notNullable();         // false for unpaid lunch
      t.index(['shift_id']);
    });
  }

  if (!(await db.schema.hasTable('attendance_modules'))) {
    // Prefixed with `attendance_` because `modules` is a generic name
    // that could collide with future concepts.
    await db.schema.createTable('attendance_modules', (t) => {
      t.string('id').primary();
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('name').notNullable();          // "ASSY CELL 1,4,5"
      t.string('supervisor_name').notNullable();
      t.string('supervisor_chat_id');          // nullable until supervisor registers
      t.string('shift_id').notNullable().references('id').inTable('shifts');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['site_id']);
      t.index(['supervisor_chat_id']);
    });
  }

  // ── Reference data ────────────────────────────────────────
  if (!(await db.schema.hasTable('absence_codes'))) {
    await db.schema.createTable('absence_codes', (t) => {
      // The codes are site-scoped so different plants can have different
      // authoritative sets — manager answer: configurable.
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('code').notNullable();          // "U", "V", "DI", …
      t.string('description_en').notNullable();
      t.string('description_es').notNullable();
      t.boolean('counts_as_present').notNullable().defaultTo(false);
      t.decimal('billing_hours_factor', 3, 2).notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['site_id', 'code']);
    });
  }

  // ── Role-based access control (HR peers, supervisors, managers) ────
  if (!(await db.schema.hasTable('user_roles'))) {
    await db.schema.createTable('user_roles', (t) => {
      t.string('chat_id').notNullable();
      // 'hr' → may upload attendance CSVs
      // 'supervisor' → may confirm module exceptions (scoped by module)
      // 'manager' → escalation target
      // 'admin' → superuser
      t.string('role').notNullable();
      t.string('module_id');                   // nullable — only set for 'supervisor'
      t.string('granted_by').notNullable();    // chat_id of grantor, or 'system'
      t.bigInteger('granted_at').notNullable();
      t.bigInteger('revoked_at');              // nullable — set on revoke
      t.primary(['chat_id', 'role', 'module_id']);
      t.index(['role', 'revoked_at']);
    });
  }

  // ── Data source configuration ─────────────────────────────
  if (!(await db.schema.hasTable('attendance_data_sources'))) {
    await db.schema.createTable('attendance_data_sources', (t) => {
      t.string('id').primary();
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      // 'roster' | 'badge'
      t.string('data_type').notNullable();
      // 'csv' | 'api' | 'supervisor-sensor'
      t.string('preferred_kind').notNullable();
      // JSON blob, kind-specific — see CsvSourceConfig / ApiSourceConfig
      t.text('config').notNullable().defaultTo('{}');
      t.boolean('enabled').notNullable().defaultTo(true);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['module_id', 'data_type']);
    });
  }

  if (!(await db.schema.hasTable('attendance_column_mappings'))) {
    await db.schema.createTable('attendance_column_mappings', (t) => {
      t.string('id').primary();
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('data_type').notNullable();     // 'roster' | 'badge'
      // JSON: { logical_field: physical_column_name }
      t.text('fields').notNullable();
      // JSON: array of sample rows captured during preview (first 10)
      t.text('sample_preview').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['module_id', 'data_type']);
    });
  }

  // ── Cached employee roster ────────────────────────────────
  if (!(await db.schema.hasTable('attendance_employees'))) {
    await db.schema.createTable('attendance_employees', (t) => {
      // badge_id is globally unique within a site — multiple sites could
      // reuse the same badge number, so the PK is (site, badge).
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('badge_id').notNullable();
      t.string('full_name').notNullable();
      t.string('cost_center').notNullable();
      t.string('labor_type').notNullable();    // 'direct' | 'indirect'
      t.string('line').notNullable();           // "ASSY LINE 01"
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('supervisor_name').notNullable();
      // Full original CSV row, JSON-encoded — for audit and future column remapping
      t.text('raw_row').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['site_id', 'badge_id']);
      t.index(['module_id']);
    });
  }

  // ── Daily badge records (T&A) ─────────────────────────────
  if (!(await db.schema.hasTable('attendance_badge_records'))) {
    await db.schema.createTable('attendance_badge_records', (t) => {
      t.string('id').primary();
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('badge_id').notNullable();
      t.string('date').notNullable();          // YYYY-MM-DD (shift date)
      t.bigInteger('timestamp_in');            // epoch ms, nullable
      t.bigInteger('timestamp_out');            // epoch ms, nullable
      t.text('raw_row').notNullable();         // JSON original
      t.bigInteger('created_at').notNullable();
      t.index(['site_id', 'badge_id', 'date']);
      t.index(['module_id', 'date']);
    });
  }

  // ── Reconciled attendance records (daily output) ──────────
  if (!(await db.schema.hasTable('attendance_records'))) {
    await db.schema.createTable('attendance_records', (t) => {
      t.string('id').primary();
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('badge_id').notNullable();
      t.string('date').notNullable();          // YYYY-MM-DD
      // Resolution chosen for the day: 'present' | 'late' | 'absent' | 'U' | 'V' | …
      t.string('resolution').notNullable();
      t.decimal('billing_hours', 5, 2).notNullable().defaultTo(0);
      t.decimal('performance_hours', 5, 2).notNullable().defaultTo(0);
      // Where the resolution came from: 'badge' | 'supervisor' | 'future-absence' | 'auto-silence' | 'hr'
      t.string('resolved_by_kind').notNullable();
      t.string('resolved_by_chat_id');         // nullable when kind=badge/future-absence
      t.bigInteger('resolved_at').notNullable();
      t.string('state').notNullable().defaultTo('open');  // 'open' | 'closed'
      t.bigInteger('closed_at');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['module_id', 'badge_id', 'date']);
      t.index(['date']);
      t.index(['module_id', 'date']);
    });
  }

  if (!(await db.schema.hasTable('attendance_future_absences'))) {
    await db.schema.createTable('attendance_future_absences', (t) => {
      // Supervisor pre-files known absences (vacation grants, medical leaves)
      // so no exception fires on the day.
      t.string('id').primary();
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('badge_id').notNullable();
      t.string('date_start').notNullable();    // inclusive
      t.string('date_end').notNullable();       // inclusive
      t.string('absence_code').notNullable();   // references absence_codes.code
      t.string('filed_by_chat_id').notNullable();
      t.text('notes');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('cancelled_at');
      t.index(['module_id', 'badge_id']);
      t.index(['date_start', 'date_end']);
    });
  }

  if (!(await db.schema.hasTable('attendance_adjustments'))) {
    await db.schema.createTable('attendance_adjustments', (t) => {
      // Audit trail of mid-day / post-close edits. Every change to an
      // already-resolved attendance_records row writes one row here.
      t.bigIncrements('id').primary();
      t.string('record_id').notNullable().references('id').inTable('attendance_records');
      t.text('before').notNullable();          // JSON of the row before the change
      t.text('after').notNullable();            // JSON of the row after
      t.string('actor_chat_id').notNullable();
      t.string('actor_role').notNullable();    // 'supervisor' | 'hr' | 'manager' | 'admin'
      t.string('reason').notNullable();        // free-text or a reason code
      t.bigInteger('created_at').notNullable();
      t.index(['record_id']);
      t.index(['created_at']);
    });
  }

  // ── Published report snapshots ────────────────────────────
  if (!(await db.schema.hasTable('attendance_report_snapshots'))) {
    await db.schema.createTable('attendance_report_snapshots', (t) => {
      t.string('id').primary();
      t.string('site_id').notNullable().references('id').inTable('sites');
      t.string('date').notNullable();          // YYYY-MM-DD
      // 'morning' = 8:31am snapshot; 'end-of-shift' = 5:00pm final
      t.string('kind').notNullable();
      // Frozen JSON dump of the records as published, so the exact content
      // delivered to HR/management is always recoverable.
      t.text('snapshot_json').notNullable();
      t.text('recipient_chat_ids').notNullable();  // JSON array
      t.bigInteger('published_at').notNullable();
      t.index(['site_id', 'date']);
      t.unique(['site_id', 'date', 'kind']);
    });
  }

  // ── Supervisor invitations (rc.90) ────────────────────────
  if (!(await db.schema.hasTable('attendance_supervisor_invites'))) {
    // Admin issues a one-shot token for a module. Supervisor claims it
    // via Telegram; bot validates, sets module.supervisor_chat_id, and
    // grants the 'supervisor' role scoped to the module. Tokens expire.
    await db.schema.createTable('attendance_supervisor_invites', (t) => {
      t.string('token').primary();     // 24-char hex; short because users type it in Telegram
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('created_by').notNullable();  // admin chat_id that issued the invite
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('redeemed_at');
      t.string('redeemed_by_chat_id');
      t.bigInteger('revoked_at');
      t.index(['module_id']);
    });
  }

  // ── Ingestion reports ─────────────────────────────────────
  if (!(await db.schema.hasTable('attendance_ingestion_reports'))) {
    await db.schema.createTable('attendance_ingestion_reports', (t) => {
      t.string('id').primary();
      t.string('module_id').notNullable().references('id').inTable('attendance_modules');
      t.string('data_type').notNullable();     // 'roster' | 'badge'
      t.string('source_kind').notNullable();   // 'csv' | 'api' | 'supervisor-sensor'
      t.string('file_path');                   // nullable for api/sensor
      t.integer('rows_read').notNullable();
      t.integer('rows_accepted').notNullable();
      t.integer('rows_skipped').notNullable();
      // JSON: array of { rowNumber, reason, rawRow }
      t.text('skipped_reasons').notNullable();
      // JSON: array of { kind, detail }
      t.text('warnings').notNullable();
      t.bigInteger('started_at').notNullable();
      t.bigInteger('completed_at').notNullable();
      t.boolean('succeeded').notNullable();
      t.text('error_message');
      t.index(['module_id', 'data_type', 'completed_at']);
    });
  }
}

export const attendanceTableInit: TableInitializer = {
  name: 'attendance',
  initTables: initAttendanceTables,
};
