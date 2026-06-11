/**
 * Database dialect helpers — handles SQLite/MariaDB/PostgreSQL differences.
 *
 * Used for features that Knex's schema builder doesn't abstract:
 * - Full-text search (FTS5 / FULLTEXT / tsvector)
 * - Vector search (sqlite-vec / application-level / pgvector)
 * - Column migration checks (PRAGMA / information_schema)
 * - Triggers
 *
 * Design: each helper accepts a Knex instance and produces dialect-appropriate SQL.
 * The caller doesn't need to know which backend is active.
 */

import type { Knex } from 'knex';
import { getDbDriver, type DbDriver } from './db-knex.js';
import { logger } from './logger.js';

/**
 * Maximum length for user-supplied full-text queries. FTS5/BOOLEAN MODE
 * operators on very long strings can trigger expensive query plans; memory
 * search never benefits from more than a sentence or two of query text.
 */
const MAX_FTS_QUERY_LENGTH = 200;

/**
 * Guard for identifiers (table/column names) interpolated into raw DDL/DML.
 * All callers pass hardcoded internal names today; this guard ensures the
 * helpers stay safe if they're ever reached with derived input.
 */
function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Check if a column exists in a table (cross-dialect).
 * Replaces PRAGMA table_info().
 */
export async function columnExists(db: Knex, table: string, column: string): Promise<boolean> {
  return db.schema.hasColumn(table, column);
}

/**
 * Add a column if it doesn't already exist (cross-dialect migration).
 * Replaces the PRAGMA + ALTER TABLE pattern used throughout the codebase.
 */
export async function addColumnIfMissing(
  db: Knex,
  table: string,
  column: string,
  definition: (col: Knex.ColumnBuilder) => void,
): Promise<boolean> {
  const exists = await db.schema.hasColumn(table, column);
  if (exists) return false;

  await db.schema.alterTable(table, (t) => {
    const col = t.specificType(column, 'TEXT'); // Default, overridden by definition
    definition(col);
  });

  logger.info(`Migration: added ${column} column to ${table}`);
  return true;
}

/**
 * Create an index if it doesn't already exist (cross-dialect migration).
 * SQLite/PostgreSQL support IF NOT EXISTS natively; MariaDB needs an
 * information_schema check first.
 */
export async function createIndexIfMissing(
  db: Knex,
  table: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  assertSafeIdentifier(table);
  assertSafeIdentifier(indexName);
  columns.forEach(assertSafeIdentifier);
  const columnList = columns.join(', ');

  if (getDbDriver() === 'mariadb') {
    const [rows] = await db.raw(
      `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, indexName],
    ) as [Array<{ cnt: number }>];
    if (!rows[0]?.cnt) {
      await db.raw(`CREATE INDEX ${indexName} ON ${table} (${columnList})`);
    }
    return;
  }
  await db.raw(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${columnList})`);
}

/**
 * Create a full-text search setup for a table (dialect-specific).
 *
 * - SQLite: FTS5 virtual table + sync triggers
 * - MariaDB: FULLTEXT INDEX on the column (built into table)
 * - PostgreSQL: GIN index on tsvector column
 */
export async function createFullTextSearch(
  db: Knex,
  sourceTable: string,
  sourceColumn: string,
  ftsTableName: string,
): Promise<void> {
  assertSafeIdentifier(sourceTable);
  assertSafeIdentifier(sourceColumn);
  assertSafeIdentifier(ftsTableName);
  const driver = getDbDriver();

  switch (driver) {
    case 'sqlite': {
      // FTS5 virtual table
      await db.raw(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(
          ${sourceColumn},
          content_rowid=id
        )
      `);

      // Sync triggers
      await db.raw(`
        CREATE TRIGGER IF NOT EXISTS ${sourceTable}_ai AFTER INSERT ON ${sourceTable} BEGIN
          INSERT INTO ${ftsTableName}(rowid, ${sourceColumn}) VALUES (new.id, new.${sourceColumn});
        END
      `);
      await db.raw(`
        CREATE TRIGGER IF NOT EXISTS ${sourceTable}_au AFTER UPDATE OF ${sourceColumn} ON ${sourceTable} BEGIN
          UPDATE ${ftsTableName} SET ${sourceColumn} = new.${sourceColumn} WHERE rowid = old.id;
        END
      `);
      await db.raw(`
        CREATE TRIGGER IF NOT EXISTS ${sourceTable}_ad AFTER DELETE ON ${sourceTable} BEGIN
          DELETE FROM ${ftsTableName} WHERE rowid = old.id;
        END
      `);
      break;
    }

    case 'mariadb': {
      // MariaDB: check if FULLTEXT index exists, add if not
      const indexName = `ft_${sourceTable}_${sourceColumn}`;
      const [rows] = await db.raw(
        `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [sourceTable, indexName],
      ) as [Array<{ cnt: number }>];
      if (!rows[0]?.cnt) {
        await db.raw(`ALTER TABLE ${sourceTable} ADD FULLTEXT INDEX ${indexName} (${sourceColumn})`);
      }
      break;
    }

    case 'postgres': {
      // PostgreSQL: add tsvector column + GIN index
      const tsvCol = `${sourceColumn}_tsv`;
      const hasCol = await db.schema.hasColumn(sourceTable, tsvCol);
      if (!hasCol) {
        await db.raw(`ALTER TABLE ${sourceTable} ADD COLUMN ${tsvCol} tsvector`);
        await db.raw(`CREATE INDEX IF NOT EXISTS idx_${sourceTable}_${tsvCol} ON ${sourceTable} USING gin(${tsvCol})`);
        // Auto-update trigger
        await db.raw(`
          CREATE OR REPLACE FUNCTION ${sourceTable}_tsv_update() RETURNS trigger AS $$
          BEGIN
            NEW.${tsvCol} := to_tsvector('simple', COALESCE(NEW.${sourceColumn}, ''));
            RETURN NEW;
          END
          $$ LANGUAGE plpgsql
        `);
        await db.raw(`
          DROP TRIGGER IF EXISTS ${sourceTable}_tsv_trigger ON ${sourceTable};
          CREATE TRIGGER ${sourceTable}_tsv_trigger BEFORE INSERT OR UPDATE OF ${sourceColumn}
          ON ${sourceTable} FOR EACH ROW EXECUTE FUNCTION ${sourceTable}_tsv_update()
        `);
        // Backfill existing rows
        await db.raw(`UPDATE ${sourceTable} SET ${tsvCol} = to_tsvector('simple', COALESCE(${sourceColumn}, ''))`);
      }
      break;
    }
  }
}

/**
 * Perform a full-text search (dialect-specific).
 *
 * - SQLite: FTS5 MATCH with JOIN
 * - MariaDB: MATCH ... AGAINST ... IN BOOLEAN MODE
 * - PostgreSQL: to_tsvector @@ plainto_tsquery
 *
 * Returns raw rows — caller maps to domain types.
 */
export async function fullTextSearch(
  db: Knex,
  sourceTable: string,
  sourceColumn: string,
  ftsTableName: string,
  chatId: string,
  query: string,
  limit: number = 5,
): Promise<unknown[]> {
  assertSafeIdentifier(sourceTable);
  assertSafeIdentifier(sourceColumn);
  assertSafeIdentifier(ftsTableName);
  if (query.length > MAX_FTS_QUERY_LENGTH) {
    logger.debug({ length: query.length }, 'FTS query truncated to length cap');
    query = query.slice(0, MAX_FTS_QUERY_LENGTH);
  }
  const driver = getDbDriver();

  switch (driver) {
    case 'sqlite': {
      return db.raw(
        `SELECT m.* FROM ${sourceTable} m
         JOIN ${ftsTableName} fts ON fts.rowid = m.id
         WHERE fts.${sourceColumn} MATCH ? AND m.chat_id = ?
         ORDER BY fts.rank
         LIMIT ?`,
        [query, chatId, limit],
      ).then((r: unknown) => r as unknown[]);
    }

    case 'mariadb': {
      return db(sourceTable)
        .whereRaw(`MATCH(${sourceColumn}) AGAINST(? IN BOOLEAN MODE)`, [query])
        .where({ chat_id: chatId })
        .limit(limit);
    }

    case 'postgres': {
      const tsvCol = `${sourceColumn}_tsv`;
      return db(sourceTable)
        .whereRaw(`${tsvCol} @@ plainto_tsquery('simple', ?)`, [query])
        .where({ chat_id: chatId })
        .limit(limit);
    }
  }
}

/**
 * Create vector search table (dialect-specific).
 *
 * - SQLite: vec0 virtual table (sqlite-vec extension)
 * - MariaDB: BLOB column for embedding (application-level cosine similarity)
 * - PostgreSQL: pgvector column with IVFFlat index
 */
export async function createVectorTable(
  db: Knex,
  tableName: string,
  idColumn: string,
  dimensions: number = 768,
): Promise<void> {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(idColumn);
  const driver = getDbDriver();

  switch (driver) {
    case 'sqlite': {
      try {
        await db.raw(`
          CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
            ${idColumn} INTEGER PRIMARY KEY,
            embedding float[${dimensions}]
          )
        `);
      } catch (err) {
        logger.warn({ err }, `Could not create ${tableName} (sqlite-vec may not be loaded)`);
      }
      break;
    }

    case 'mariadb': {
      // MariaDB: store embedding as BLOB, compute similarity in application
      if (!(await db.schema.hasTable(tableName))) {
        await db.schema.createTable(tableName, (t) => {
          t.integer(idColumn).primary();
          t.binary('embedding').notNullable();
          t.index([idColumn]);
        });
      }
      break;
    }

    case 'postgres': {
      // PostgreSQL: use pgvector extension
      try {
        await db.raw('CREATE EXTENSION IF NOT EXISTS vector');
      } catch {
        logger.warn('pgvector extension not available — vector search disabled');
        return;
      }
      if (!(await db.schema.hasTable(tableName))) {
        await db.schema.createTable(tableName, (t) => {
          t.integer(idColumn).primary();
        });
        await db.raw(`ALTER TABLE ${tableName} ADD COLUMN embedding vector(${dimensions})`);
        await db.raw(`CREATE INDEX IF NOT EXISTS idx_${tableName}_embedding ON ${tableName} USING ivfflat (embedding vector_cosine_ops)`);
      }
      break;
    }
  }
}

/**
 * Insert a row into a vector table (dialect-aware).
 *
 * On SQLite, sqlite-vec's vec0 virtual table requires the primary key to be
 * bound as SQLITE_INTEGER. better-sqlite3 v12+ binds integer-valued JS Numbers
 * as SQLITE_FLOAT through this path, which vec0 rejects with
 * "Only integers are allows for primary key values". We embed the id as a
 * SQL literal so it lands as an INTEGER token (id is a trusted internal
 * auto-increment value — no injection risk). Knex's .insert() also rejects
 * BigInt bindings, so a raw statement is the cleanest workaround.
 */
export async function insertVecRow(
  db: Knex,
  tableName: string,
  idColumn: string,
  id: number,
  embedding: Buffer,
): Promise<void> {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(idColumn);
  if (getDbDriver() === 'sqlite') {
    const safeId = Math.trunc(Number(id));
    await db.raw(
      `INSERT INTO ${tableName} (${idColumn}, embedding) VALUES (${safeId}, ?)`,
      [embedding],
    );
    return;
  }
  await db(tableName).insert({ [idColumn]: id, embedding });
}

/**
 * Perform a vector similarity search (dialect-specific).
 *
 * - SQLite: vec_distance_cosine via sqlite-vec
 * - MariaDB: application-level cosine similarity (fetch all, compute in JS)
 * - PostgreSQL: pgvector <=> operator
 */
export async function vectorSearch(
  db: Knex,
  vecTable: string,
  idColumn: string,
  sourceTable: string,
  chatId: string,
  embedding: number[],
  limit: number = 5,
): Promise<unknown[]> {
  assertSafeIdentifier(vecTable);
  assertSafeIdentifier(idColumn);
  assertSafeIdentifier(sourceTable);
  const driver = getDbDriver();

  switch (driver) {
    case 'sqlite': {
      // sqlite-vec: use vec_distance_cosine
      const embeddingJson = JSON.stringify(embedding);
      return db.raw(
        `SELECT m.*, v.distance
         FROM ${sourceTable} m
         JOIN ${vecTable} v ON v.${idColumn} = m.id
         WHERE m.chat_id = ?
         AND v.embedding MATCH ?
         ORDER BY v.distance ASC
         LIMIT ?`,
        [chatId, embeddingJson, limit],
      ).then((r: unknown) => r as unknown[]);
    }

    case 'mariadb': {
      // MariaDB: fetch candidates, compute cosine similarity in JS
      // This is less efficient but correct. For production scale, consider
      // a dedicated vector store (Milvus, Qdrant) or MariaDB 11.6+ vector support.
      const rows = await db(sourceTable)
        .join(vecTable, `${sourceTable}.id`, `${vecTable}.${idColumn}`)
        .where({ [`${sourceTable}.chat_id`]: chatId })
        .select(`${sourceTable}.*`, `${vecTable}.embedding as raw_embedding`);

      // Compute cosine similarity in JS
      return rows
        .map((row: Record<string, unknown>) => {
          const stored = JSON.parse(Buffer.from(row.raw_embedding as Buffer).toString()) as number[];
          const sim = cosineSimilarity(embedding, stored);
          return { ...row, distance: 1 - sim, raw_embedding: undefined };
        })
        .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance)
        .slice(0, limit);
    }

    case 'postgres': {
      // pgvector: use <=> cosine distance operator
      const embeddingStr = `[${embedding.join(',')}]`;
      return db.raw(
        `SELECT m.*, (v.embedding <=> ?::vector) as distance
         FROM ${sourceTable} m
         JOIN ${vecTable} v ON v.${idColumn} = m.id
         WHERE m.chat_id = ?
         ORDER BY v.embedding <=> ?::vector ASC
         LIMIT ?`,
        [embeddingStr, chatId, embeddingStr, limit],
      ).then((r: { rows: unknown[] }) => r.rows);
    }
  }
}

// ── Utility ──────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
