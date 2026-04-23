/**
 * Knex database configuration — multi-backend support.
 *
 * Reads DB_DRIVER from config to select the database backend:
 * - 'sqlite' (default): better-sqlite3, file-based, for development/testing
 * - 'mariadb': mysql2 driver, connection pooling, for production
 * - 'postgres': pg driver, connection pooling, for production
 *
 * Usage:
 *   import { getKnex } from './db-knex.js';
 *   const db = getKnex();
 *   const rows = await db('users').where({ id: 1 });
 */

import Knex from 'knex';
import type { Knex as KnexType } from 'knex';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { logger } from './logger.js';

// sqlite-vec extension — loaded into SQLite connections for vector search
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteVecModule: { load: (db: any) => void } | null = null;
try {
  const mod = await import('sqlite-vec');
  sqliteVecModule = mod;
} catch {
  // sqlite-vec not available (MariaDB/PostgreSQL don't need it)
}

// ── Configuration ──────────────────────────────────────────

export type DbDriver = 'sqlite' | 'mariadb' | 'postgres';

export interface DbConfig {
  driver: DbDriver;
  // SQLite
  sqliteFilename?: string;
  // MariaDB / PostgreSQL
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  // Connection pool
  poolMin?: number;
  poolMax?: number;
}

/**
 * Read database configuration from environment.
 * Supports reading from readEnvFile() output or process.env.
 */
export function readDbConfig(env: Record<string, string> = {}): DbConfig {
  const driver = (env.DB_DRIVER || 'sqlite') as DbDriver;
  const storeDir = env.STORE_DIR || resolve(process.cwd(), 'store');

  return {
    driver,
    // SQLite
    sqliteFilename: env.DB_SQLITE_PATH || resolve(storeDir, 'luna.db'),
    // MariaDB / PostgreSQL
    host: env.DB_HOST || 'localhost',
    port: parseInt(env.DB_PORT || (driver === 'postgres' ? '5432' : '3306')),
    user: env.DB_USER || 'luna',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'luna',
    // Pool
    poolMin: parseInt(env.DB_POOL_MIN || '2'),
    poolMax: parseInt(env.DB_POOL_MAX || '10'),
  };
}

// ── Knex Instance ──────────────────────────────────────────

let knexInstance: KnexType | null = null;

/**
 * Build a Knex configuration object from our DbConfig.
 */
export function buildKnexConfig(config: DbConfig): KnexType.Config {
  switch (config.driver) {
    case 'sqlite':
      return {
        client: 'better-sqlite3',
        connection: {
          filename: config.sqliteFilename!,
        },
        useNullAsDefault: true,
        pool: {
          // SQLite: single connection, no pool
          min: 1,
          max: 1,
          // Enable WAL mode, foreign keys, and sqlite-vec on connection create
          afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
            conn.pragma('journal_mode = WAL');
            conn.pragma('foreign_keys = ON');
            if (sqliteVecModule) {
              try {
                sqliteVecModule.load(conn);
              } catch {
                // sqlite-vec load failed — vector search will be unavailable
              }
            }
            done(null, conn);
          },
        },
      };

    case 'mariadb':
      return {
        client: 'mysql2',
        connection: {
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
          charset: 'utf8mb4',
        } as KnexType.StaticConnectionConfig,
        pool: {
          min: config.poolMin ?? 2,
          max: config.poolMax ?? 10,
        },
      };

    case 'postgres':
      return {
        client: 'pg',
        connection: {
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
        },
        pool: {
          min: config.poolMin ?? 2,
          max: config.poolMax ?? 10,
        },
        // PostgreSQL: use snake_case by default
        searchPath: ['public'],
      };

    default:
      throw new Error(`Unsupported DB_DRIVER: ${config.driver}. Use 'sqlite', 'mariadb', or 'postgres'.`);
  }
}

/**
 * Initialize and return the Knex instance (singleton).
 * Call once at application startup.
 */
export function initKnex(config?: DbConfig): KnexType {
  if (knexInstance) return knexInstance;

  const dbConfig = config || readDbConfig();
  const knexConfig = buildKnexConfig(dbConfig);

  knexInstance = Knex.default(knexConfig);

  logger.info(
    { driver: dbConfig.driver, host: dbConfig.driver === 'sqlite' ? dbConfig.sqliteFilename : dbConfig.host },
    'Knex database initialized',
  );

  return knexInstance;
}

/**
 * Get the Knex instance. Throws if not initialized.
 */
export function getKnex(): KnexType {
  if (!knexInstance) {
    throw new Error('Knex not initialized. Call initKnex() first.');
  }
  return knexInstance;
}

/**
 * Create a Knex instance for testing (in-memory SQLite).
 * Does NOT set the singleton — each test gets its own instance.
 */
export function createTestKnex(): KnexType {
  return Knex.default({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.pragma('journal_mode = WAL');
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      },
    },
  });
}

/**
 * Destroy the Knex instance (for graceful shutdown).
 */
export async function destroyKnex(): Promise<void> {
  if (knexInstance) {
    await knexInstance.destroy();
    knexInstance = null;
  }
}

/**
 * Check if a column exists in a table (cross-dialect).
 * Replaces SQLite's PRAGMA table_info().
 */
export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const db = getKnex();
  const hasColumn = await db.schema.hasColumn(tableName, columnName);
  return hasColumn;
}

/**
 * Get the current database driver.
 */
export function getDbDriver(): DbDriver {
  if (!knexInstance) return 'sqlite';
  const client = (knexInstance as unknown as { client: { config: { client: string } } }).client?.config?.client;
  if (client === 'mysql2') return 'mariadb';
  if (client === 'pg') return 'postgres';
  return 'sqlite';
}
