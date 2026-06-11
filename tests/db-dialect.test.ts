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

import { columnExists, createFullTextSearch, createIndexIfMissing, createVectorTable, fullTextSearch, insertVecRow } from '../src/db-dialect.js';

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

  describe('identifier guard (rc.113)', () => {
    it('rejects unsafe table names in createFullTextSearch', async () => {
      await expect(
        createFullTextSearch(testKnex, 'articles; DROP TABLE users', 'content', 'x_fts'),
      ).rejects.toThrow(/Unsafe SQL identifier/);
    });

    it('rejects unsafe column names in fullTextSearch', async () => {
      await expect(
        fullTextSearch(testKnex, 'articles', 'content) --', 'articles_fts', 'user1', 'q', 3),
      ).rejects.toThrow(/Unsafe SQL identifier/);
    });

    it('rejects unsafe table names in createVectorTable', async () => {
      await expect(
        createVectorTable(testKnex, 'vec"t', 'id', 4),
      ).rejects.toThrow(/Unsafe SQL identifier/);
    });
  });

  describe('FTS query length cap (rc.113)', () => {
    it('truncates oversized queries instead of erroring', async () => {
      await testKnex.schema.createTable('articles3', (t) => {
        t.increments('id').primary();
        t.string('chat_id').notNullable();
        t.text('content').notNullable();
      });
      await createFullTextSearch(testKnex, 'articles3', 'content', 'articles3_fts');
      await testKnex('articles3').insert({ chat_id: 'user1', content: 'kaizen continuous improvement' });

      // 200-char cap: a long query whose first term matches still searches
      const longQuery = 'kaizen* ' + 'padding* '.repeat(60);
      const results = await fullTextSearch(testKnex, 'articles3', 'content', 'articles3_fts', 'user1', longQuery, 3);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('createIndexIfMissing (rc.113)', () => {
    it('creates an index and is idempotent', async () => {
      await testKnex.schema.createTable('idx_target', (t) => {
        t.increments('id').primary();
        t.string('ref_id').notNullable();
      });

      await createIndexIfMissing(testKnex, 'idx_target', ['ref_id'], 'idx_idx_target_ref_id');
      // Second call must not throw (IF NOT EXISTS)
      await createIndexIfMissing(testKnex, 'idx_target', ['ref_id'], 'idx_idx_target_ref_id');

      const rows = await testKnex.raw(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_idx_target_ref_id'`,
      ) as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });

    it('rejects unsafe index names', async () => {
      await expect(
        createIndexIfMissing(testKnex, 'idx_target', ['ref_id'], 'bad name'),
      ).rejects.toThrow(/Unsafe SQL identifier/);
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
