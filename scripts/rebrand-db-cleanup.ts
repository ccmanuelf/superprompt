#!/usr/bin/env tsx
/**
 * Rebrand DB cleanup (rc.86)
 *
 * The file-system migration (src/migrations/rebrand-data-files.ts) renames
 * clauded.db → luna.db but does NOT touch the rows inside, because the
 * content is operator-owned: chat history, memories, cached skill prompts,
 * user tool code. A live instance that existed under the old brand still
 * carries "clauded" strings inside its stored data.
 *
 * Running the bot unchanged surfaces the problem in two ways:
 *   1. Memory retrieval can pull facts like "you can call me clauded"
 *      into the system prompt → the model will echo the wrong identity.
 *   2. Pack-loaded skills whose source files changed (e.g. `luna` in the
 *      prd-writer pack) don't re-import on boot — the DB row wins,
 *      keeping the old "clauded" text in injected prompts.
 *
 * This script does a targeted, dry-run-by-default rewrite of these rows,
 * replacing the product brand with the new one. It is intentionally
 * one-shot and NOT wired into startup — the operator decides whether
 * to run it.
 *
 *   Dry run:   tsx scripts/rebrand-db-cleanup.ts
 *   Commit:    tsx scripts/rebrand-db-cleanup.ts --apply
 *
 * Skills loaded from packs are also re-imported from their source files
 * when the `--apply` mode runs and the source file on disk differs from
 * the DB row.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initKnex, getKnex } from '../src/db-knex.js';

type RewriteMode = 'display' | 'slug';
type Replacement = {
  table: string;
  idColumn: string;
  textColumns: Array<{ name: string; mode: RewriteMode }>;
};

/**
 * Per-column rewrite mode:
 *   - 'display' → title-case rewrite (`clauded` → `Luna`). Use for prose
 *     the model or user reads: dialogue, summaries, skill descriptions,
 *     system prompts. Preserves the display brand.
 *   - 'slug' → case-preserving lowercase rewrite (`clauded` → `luna`).
 *     Use for columns that carry code / identifiers: tool config with
 *     embedded string literals like `'clauded-bot'`, hostname checks.
 */
const TABLES: Replacement[] = [
  { table: 'memories',        idColumn: 'id', textColumns: [{ name: 'content', mode: 'display' }] },
  { table: 'chat_log',        idColumn: 'id', textColumns: [{ name: 'content', mode: 'display' }] },
  { table: 'episodes',        idColumn: 'id', textColumns: [{ name: 'summary', mode: 'display' }] },
  { table: 'skills',          idColumn: 'id', textColumns: [
    { name: 'system_prompt', mode: 'display' }, { name: 'name', mode: 'display' }, { name: 'description', mode: 'display' },
  ] },
  { table: 'user_tools',      idColumn: 'id', textColumns: [
    { name: 'config', mode: 'slug' },            // code — keep lowercase
    { name: 'description', mode: 'display' },    // prose — title case
    { name: 'name', mode: 'slug' },              // identifier
  ] },
  { table: 'kanban_cards',    idColumn: 'id', textColumns: [
    { name: 'title', mode: 'display' }, { name: 'description', mode: 'display' },
  ] },
  { table: 'skill_proposals', idColumn: 'id', textColumns: [
    { name: 'proposed_name', mode: 'display' },
    { name: 'proposed_prompt', mode: 'display' },
    { name: 'proposed_description', mode: 'display' },
  ] },
];

/**
 * Case-preserving rewrite into the new brand. Run the substitutions
 * ordered from most specific to least specific so a prior pass's output
 * doesn't get re-matched by a later pass. The `slug` mode preserves the
 * original case; the `display` mode normalises all lowercase
 * occurrences to the title-case display brand "Luna", which is the
 * user-visible form.
 */
function rewrite(text: string, mode: RewriteMode): string {
  return text
    .replace(/CLAUDED/g, mode === 'display' ? 'LUNA' : 'LUNA')
    .replace(/Clauded/g, 'Luna')
    .replace(/clauded/g, mode === 'display' ? 'Luna' : 'luna');
}

function hasBrand(text: string): boolean {
  return /CLAUDED|Clauded|clauded/.test(text);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  // Initialize the real Knex instance using the app's DB config.
  const { readEnvFile } = await import('../src/env.js');
  const env = readEnvFile();
  const { readDbConfig, buildKnexConfig } = await import('../src/db-knex.js');
  const dbConfig = readDbConfig(env);
  const knex = (await import('knex')).default(buildKnexConfig(dbConfig));

  console.log(`\n=== Rebrand DB cleanup (${apply ? 'APPLY' : 'DRY RUN'}) ===\n`);
  console.log(`Driver: ${dbConfig.driver}`);
  if (dbConfig.driver === 'sqlite') {
    console.log(`Path:   ${dbConfig.sqliteFilename}`);
  }
  console.log('');

  let totalRowsTouched = 0;

  for (const t of TABLES) {
    const columnNames = t.textColumns.map((c) => c.name);
    const whereClauses = columnNames.map((c) => `${c} LIKE ?`).join(' OR ');
    const params = columnNames.map(() => '%clauded%');
    const rows: Record<string, unknown>[] = await knex.raw(
      `SELECT ${t.idColumn}, ${columnNames.join(', ')} FROM ${t.table} WHERE ${whereClauses}`,
      params,
    );
    // Different drivers wrap results differently; normalise.
    const extracted = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    if (extracted.length === 0) continue;

    console.log(`--- ${t.table} (${extracted.length} row(s) match) ---`);
    for (const row of extracted as Record<string, unknown>[]) {
      const updates: Record<string, string> = {};
      for (const col of t.textColumns) {
        const v = row[col.name];
        if (typeof v === 'string' && hasBrand(v)) {
          updates[col.name] = rewrite(v, col.mode);
        }
      }
      if (Object.keys(updates).length === 0) continue;

      const id = row[t.idColumn];
      console.log(`  id=${id}`);
      for (const col of Object.keys(updates)) {
        const before = String(row[col]);
        const after = updates[col];
        console.log(`    ${col}: ${before.length > 80 ? before.slice(0, 80) + '…' : before}`);
        console.log(`         → ${after.length > 80 ? after.slice(0, 80) + '…' : after}`);
      }

      if (apply) {
        await knex(t.table).where({ [t.idColumn]: id }).update(updates);
        totalRowsTouched++;
      }
    }
    console.log('');
  }

  if (apply) {
    console.log(`✅ Applied. Rows updated: ${totalRowsTouched}`);
  } else {
    console.log(`ℹ️  Dry run. Re-run with --apply to commit.`);
  }

  await knex.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
