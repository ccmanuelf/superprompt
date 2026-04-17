import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

// Mock getKnex and getDbDriver for dialect helpers
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getKnex: () => testKnex,
    getDbDriver: () => 'sqlite',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { columnExists, createFullTextSearch, createVectorTable, fullTextSearch, insertVecRow } from '../src/db-dialect.js';

describe('db-dialect (SQLite)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
  });

  afterEach(async () => {
    if (testKnex) await testKnex.destroy();
  });

  describe('columnExists', () => {
    it('returns true for existing column', async () => {
      await testKnex.schema.createTable('test_col', (t) => {
        t.string('id').primary();
        t.string('name');
      });
      expect(await columnExists(testKnex, 'test_col', 'name')).toBe(true);
    });

    it('returns false for non-existing column', async () => {
      await testKnex.schema.createTable('test_col2', (t) => {
        t.string('id').primary();
      });
      expect(await columnExists(testKnex, 'test_col2', 'missing')).toBe(false);
    });
  });

  describe('createFullTextSearch + fullTextSearch (SQLite FTS5)', () => {
    it('creates FTS5 table and searches', async () => {
      // Create source table
      await testKnex.schema.createTable('articles', (t) => {
        t.increments('id').primary();
        t.string('chat_id').notNullable();
        t.text('content').notNullable();
      });

      // Create FTS
      await createFullTextSearch(testKnex, 'articles', 'content', 'articles_fts');

      // Insert data — triggers should sync to FTS
      await testKnex('articles').insert({ chat_id: 'user1', content: 'lean manufacturing principles and kaizen' });
      await testKnex('articles').insert({ chat_id: 'user1', content: 'six sigma DMAIC methodology' });
      await testKnex('articles').insert({ chat_id: 'user2', content: 'lean startup methodology' });

      // Search — should find only user1's matching article
      const results = await fullTextSearch(testKnex, 'articles', 'content', 'articles_fts', 'user1', 'lean*', 3);
      expect(results).toHaveLength(1);
      expect((results[0] as { content: string }).content).toContain('lean manufacturing');
    });

    it('returns empty for no matches', async () => {
      await testKnex.schema.createTable('articles2', (t) => {
        t.increments('id').primary();
        t.string('chat_id').notNullable();
        t.text('content').notNullable();
      });
      await createFullTextSearch(testKnex, 'articles2', 'content', 'articles2_fts');
      await testKnex('articles2').insert({ chat_id: 'user1', content: 'hello world' });

      const results = await fullTextSearch(testKnex, 'articles2', 'content', 'articles2_fts', 'user1', 'nonexistent*', 3);
      expect(results).toHaveLength(0);
    });
  });

  describe('insertVecRow (SQLite vec0)', () => {
    // Regression for rc.65+: better-sqlite3 v12 binds integer-valued JS Numbers
    // as SQLITE_FLOAT, which vec0 rejects with "Only integers are allows for
    // primary key values". insertVecRow must keep the PK as an integer.
    it('inserts into vec0 with integer PK', async () => {
      const sqliteVec = await import('sqlite-vec');
      const conn = await testKnex.client.acquireConnection();
      sqliteVec.load(conn);
      testKnex.client.releaseConnection(conn);

      await createVectorTable(testKnex, 'test_vec', 'row_id', 4);
      const embedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);

      await insertVecRow(testKnex, 'test_vec', 'row_id', 7, embedding);
      await insertVecRow(testKnex, 'test_vec', 'row_id', 42, embedding);

      const rows = await testKnex.raw('SELECT row_id FROM test_vec ORDER BY row_id') as Array<{ row_id: number }>;
      expect(rows.map((r) => Number(r.row_id))).toEqual([7, 42]);
    });
  });
});
