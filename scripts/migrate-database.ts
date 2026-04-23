#!/usr/bin/env tsx
/**
 * Database Migration Script — SQLite → MariaDB/PostgreSQL
 *
 * Exports all data from the SQLite database and imports into the target.
 * Uses Knex for both connections, so the schema is cross-dialect.
 *
 * Usage:
 *   # Migrate to MariaDB
 *   DB_DRIVER=mariadb DB_HOST=localhost DB_USER=luna DB_PASSWORD=secret DB_NAME=luna \
 *     npx tsx scripts/migrate-database.ts
 *
 *   # Migrate to PostgreSQL
 *   DB_DRIVER=postgres DB_HOST=localhost DB_USER=luna DB_PASSWORD=secret DB_NAME=luna \
 *     npx tsx scripts/migrate-database.ts
 *
 *   # Dry run (show what would be migrated)
 *   DB_DRIVER=mariadb ... npx tsx scripts/migrate-database.ts --dry-run
 *
 * The script:
 * 1. Connects to the SQLite source (from STORE_DIR)
 * 2. Connects to the target (MariaDB/PostgreSQL from DB_* env vars)
 * 3. Creates all tables in the target via Knex schema
 * 4. Copies data table by table
 * 5. Verifies row counts match
 */

import Knex from 'knex';
import type { Knex as KnexType } from 'knex';
import { resolve } from 'node:path';

// ── Configuration ──────────────────────────────────────────

const STORE_DIR = process.env.STORE_DIR || resolve(process.cwd(), 'store');
const DB_DRIVER = process.env.DB_DRIVER || 'mariadb';
const DRY_RUN = process.argv.includes('--dry-run');

if (DB_DRIVER === 'sqlite') {
  console.error('Error: DB_DRIVER=sqlite — nothing to migrate. Set DB_DRIVER to mariadb or postgres.');
  process.exit(1);
}

// ── Source (SQLite) ────────────────────────────────────────

const sqlitePath = resolve(STORE_DIR, 'luna.db');
console.log(`Source: SQLite at ${sqlitePath}`);

const source = Knex.default({
  client: 'better-sqlite3',
  connection: { filename: sqlitePath },
  useNullAsDefault: true,
});

// ── Target ─────────────────────────────────────────────────

const targetConfig: KnexType.Config = DB_DRIVER === 'postgres' ? {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'luna',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'luna',
  },
  pool: { min: 2, max: 10 },
} : {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'luna',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'luna',
    charset: 'utf8mb4',
  } as KnexType.StaticConnectionConfig,
  pool: { min: 2, max: 10 },
};

console.log(`Target: ${DB_DRIVER} at ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || (DB_DRIVER === 'postgres' ? '5432' : '3306')}`);

const target = Knex.default(targetConfig);

// ── Tables to migrate (in dependency order) ────────────────

const TABLES = [
  // Core
  'sessions',
  'memories',
  'scheduled_tasks',
  'skills',
  'chat_skills',
  'skill_revisions',
  'user_tools',
  'tool_revisions',
  'episodes',
  'episode_follow_ups',
  'digest_preferences',
  // Web tokens
  'web_tokens',
  'web_token_audit',
  // Kanban
  'kanban_cards',
  // Learning
  'learning_plans',
  'learning_topics',
  'learning_sessions',
  'learning_daily_time',
  // Manufacturing
  'sim_scenarios',
  'sim_results',
  'capacity_plans',
  'capacity_results',
  'seq_schedules',
  'vsm_maps',
  'toc_configs',
  'toc_throughput_history',
  'conwip_configs',
  'doe_experiments',
  'fsm_configs',
  // Manufacturing tools
  'balance_projects',
  'balance_tasks',
  'balance_results',
  'sigma_projects',
  'sigma_measurements',
  'sigma_results',
  'fmea_documents',
  'fmea_failure_modes',
  'fmea_action_items',
  'rca_documents',
  'rca_nodes',
  'control_plans',
  'voc_items',
  'ctq_items',
  'inventory_projects',
  'inventory_items',
  'inventory_results',
  // Infrastructure
  'citations',
  'guardrails',
  'pack_subscriptions',
  'pack_weights',
  'tool_trust',
  'skill_triggers',
  'skill_proposals',
];

// Skip FTS5 and vec0 virtual tables — not applicable to MariaDB/PostgreSQL
const SKIP_TABLES = [
  'memories_fts', 'episodes_fts',
  'memories_vec', 'episodes_vec',
  'memories_fts_data', 'memories_fts_idx', 'memories_fts_content', 'memories_fts_docsize', 'memories_fts_config',
  'episodes_fts_data', 'episodes_fts_idx', 'episodes_fts_content', 'episodes_fts_docsize', 'episodes_fts_config',
];

// ── Migration ──────────────────────────────────────────────

async function migrate(): Promise<void> {
  console.log(`\nMode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE MIGRATION'}\n`);

  // Verify source connection
  try {
    const tables = await source.raw("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = (tables as Array<{ name: string }>).map(t => t.name).filter(n => !n.startsWith('sqlite_'));
    console.log(`Source tables: ${tableNames.length}`);
  } catch (err) {
    console.error(`Cannot connect to source SQLite: ${(err as Error).message}`);
    process.exit(1);
  }

  // Verify target connection
  try {
    await target.raw('SELECT 1');
    console.log(`Target connection: OK\n`);
  } catch (err) {
    console.error(`Cannot connect to target ${DB_DRIVER}: ${(err as Error).message}`);
    process.exit(1);
  }

  const results: Array<{ table: string; source: number; target: number; status: string }> = [];

  for (const table of TABLES) {
    // Check if table exists in source
    const exists = await source.schema.hasTable(table);
    if (!exists) {
      results.push({ table, source: 0, target: 0, status: 'SKIP (not in source)' });
      continue;
    }

    // Count source rows
    const countResult = await source(table).count('* as count').first();
    const sourceCount = Number((countResult as { count: number })?.count ?? 0);

    if (DRY_RUN) {
      results.push({ table, source: sourceCount, target: 0, status: `WOULD COPY ${sourceCount} rows` });
      continue;
    }

    // Create table in target if not exists (using the same schema)
    if (!(await target.schema.hasTable(table))) {
      // Clone schema from source by reading column info
      const columns = await source.raw(`PRAGMA table_info(${table})`) as Array<{
        cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }>;

      await target.schema.createTable(table, (t) => {
        for (const col of columns) {
          const type = col.type.toUpperCase();
          let builder;
          if (col.pk && type === 'INTEGER') {
            builder = t.increments(col.name).primary();
          } else if (col.pk) {
            builder = t.string(col.name).primary();
          } else if (type.includes('TEXT') || type.includes('VARCHAR')) {
            builder = t.text(col.name);
          } else if (type.includes('INTEGER') || type.includes('INT')) {
            builder = t.bigInteger(col.name);
          } else if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) {
            builder = t.float(col.name);
          } else if (type.includes('BLOB')) {
            builder = t.binary(col.name);
          } else {
            builder = t.text(col.name); // Default to text
          }

          if (!col.pk) {
            if (col.notnull && col.dflt_value !== null) {
              builder.notNullable().defaultTo(col.dflt_value.replace(/^'|'$/g, ''));
            } else if (col.notnull) {
              builder.notNullable();
            } else {
              builder.nullable();
            }
          }
        }
      });
      console.log(`  Created table: ${table}`);
    }

    // Copy data in batches
    if (sourceCount > 0) {
      const BATCH_SIZE = 500;
      let copied = 0;

      // Clear target table first (idempotent re-run)
      await target(table).del();

      for (let offset = 0; offset < sourceCount; offset += BATCH_SIZE) {
        const rows = await source(table).limit(BATCH_SIZE).offset(offset);

        // Filter out embedding BLOBs for tables that have them (not applicable to MariaDB/PG vec)
        const cleanRows = rows.map((row: Record<string, unknown>) => {
          const clean = { ...row };
          // Remove embedding column — vector search handled differently per dialect
          if ('embedding' in clean && clean.embedding instanceof Buffer) {
            delete clean.embedding;
          }
          return clean;
        });

        if (cleanRows.length > 0) {
          await target(table).insert(cleanRows);
          copied += cleanRows.length;
        }
      }

      const targetCount = Number(((await target(table).count('* as count').first()) as { count: number })?.count ?? 0);
      const match = targetCount === sourceCount;
      results.push({ table, source: sourceCount, target: targetCount, status: match ? 'OK' : 'MISMATCH' });
      process.stdout.write(`  ${table}: ${sourceCount} rows → ${targetCount} rows ${match ? '✓' : '✗'}\n`);
    } else {
      results.push({ table, source: 0, target: 0, status: 'EMPTY' });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`${'Table'.padEnd(35)} ${'Source'.padStart(8)} ${'Target'.padStart(8)} Status`);
  console.log('-'.repeat(60));
  for (const r of results) {
    console.log(`${r.table.padEnd(35)} ${String(r.source).padStart(8)} ${String(r.target).padStart(8)} ${r.status}`);
  }
  console.log('-'.repeat(60));

  const errors = results.filter(r => r.status === 'MISMATCH');
  if (errors.length > 0) {
    console.log(`\n⚠️  ${errors.length} table(s) have mismatched row counts!`);
    process.exit(1);
  } else if (DRY_RUN) {
    console.log('\nDry run complete. Run without --dry-run to execute.');
  } else {
    console.log('\n✅ Migration complete. All row counts match.');
  }
}

// ── Run ────────────────────────────────────────────────────

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await source.destroy();
    await target.destroy();
  });
