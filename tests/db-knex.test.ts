import { describe, it, expect, afterEach } from 'vitest';
import { createTestKnex, buildKnexConfig, readDbConfig, type DbConfig } from '../src/db-knex.js';
import type { Knex } from 'knex';

describe('db-knex', () => {
  let db: Knex;

  afterEach(async () => {
    if (db) await db.destroy();
  });

  describe('readDbConfig', () => {
    it('defaults to sqlite', () => {
      const config = readDbConfig({});
      expect(config.driver).toBe('sqlite');
    });

    it('reads mariadb config', () => {
      const config = readDbConfig({
        DB_DRIVER: 'mariadb',
        DB_HOST: 'db.example.com',
        DB_PORT: '3307',
        DB_USER: 'myuser',
        DB_PASSWORD: 'mypass',
        DB_NAME: 'mydb',
      });
      expect(config.driver).toBe('mariadb');
      expect(config.host).toBe('db.example.com');
      expect(config.port).toBe(3307);
      expect(config.user).toBe('myuser');
      expect(config.database).toBe('mydb');
    });

    it('reads postgres config with default port 5432', () => {
      const config = readDbConfig({ DB_DRIVER: 'postgres' });
      expect(config.driver).toBe('postgres');
      expect(config.port).toBe(5432);
    });

    it('reads mariadb config with default port 3306', () => {
      const config = readDbConfig({ DB_DRIVER: 'mariadb' });
      expect(config.port).toBe(3306);
    });
  });

  describe('buildKnexConfig', () => {
    it('builds sqlite config', () => {
      const config: DbConfig = { driver: 'sqlite', sqliteFilename: '/tmp/test.db' };
      const knexConfig = buildKnexConfig(config);
      expect(knexConfig.client).toBe('better-sqlite3');
    });

    it('builds mariadb config', () => {
      const config: DbConfig = { driver: 'mariadb', host: 'localhost', port: 3306, user: 'root', password: '', database: 'test' };
      const knexConfig = buildKnexConfig(config);
      expect(knexConfig.client).toBe('mysql2');
    });

    it('builds postgres config', () => {
      const config: DbConfig = { driver: 'postgres', host: 'localhost', port: 5432, user: 'root', password: '', database: 'test' };
      const knexConfig = buildKnexConfig(config);
      expect(knexConfig.client).toBe('pg');
    });

    it('throws on unsupported driver', () => {
      const config: DbConfig = { driver: 'oracle' as DbConfig['driver'] };
      expect(() => buildKnexConfig(config)).toThrow(/Unsupported DB_DRIVER/);
    });
  });

  describe('createTestKnex', () => {
    it('creates in-memory SQLite instance', async () => {
      db = createTestKnex();
      // Verify it works by creating a table and inserting
      await db.schema.createTable('test_table', (t) => {
        t.string('id').primary();
        t.string('name');
        t.integer('value');
      });

      await db('test_table').insert({ id: '1', name: 'hello', value: 42 });
      const rows = await db('test_table').where({ id: '1' });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('hello');
      expect(rows[0].value).toBe(42);
    });

    it('supports upsert via onConflict (cross-dialect)', async () => {
      db = createTestKnex();
      await db.schema.createTable('upsert_test', (t) => {
        t.string('id').primary();
        t.string('data');
      });

      // Insert
      await db('upsert_test').insert({ id: 'a', data: 'first' });

      // Upsert (Knex cross-dialect)
      await db('upsert_test')
        .insert({ id: 'a', data: 'updated' })
        .onConflict('id')
        .merge();

      const row = await db('upsert_test').where({ id: 'a' }).first();
      expect(row.data).toBe('updated');
    });

    it('supports transactions', async () => {
      db = createTestKnex();
      await db.schema.createTable('tx_test', (t) => {
        t.string('id').primary();
        t.integer('count');
      });

      await db('tx_test').insert({ id: 'counter', count: 0 });

      await db.transaction(async (trx) => {
        await trx('tx_test').where({ id: 'counter' }).update({ count: 1 });
        await trx('tx_test').where({ id: 'counter' }).update({ count: 2 });
      });

      const row = await db('tx_test').where({ id: 'counter' }).first();
      expect(row.count).toBe(2);
    });

    it('supports case-insensitive search via LOWER()', async () => {
      db = createTestKnex();
      await db.schema.createTable('ci_test', (t) => {
        t.string('id').primary();
        t.string('name');
      });

      await db('ci_test').insert({ id: '1', name: 'Hello World' });

      // Cross-dialect case-insensitive search using LOWER()
      const rows = await db('ci_test').whereRaw('LOWER(name) = LOWER(?)', ['hello world']);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Hello World');
    });
  });
});
