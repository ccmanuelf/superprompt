import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

// Mock getKnex/getDbDriver for the dialect helper, same pattern as db-dialect.test.ts
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

import { createFullTextSearch, fullTextSearch } from '../src/db-dialect.js';
import { sanitizeFtsQuery } from '../src/memory.js';

// Live prod bug (2026-07-07 21:36): a user message containing the uppercase
// word "AND" produced the MATCH query `'concern* related* ... AND* how* ...'`
// which FTS5 rejects with "fts5: syntax error near '*'" — for BOTH the
// memories_fts and episodes_fts searches (they share this same query-building
// code path via buildMemoryContext). This suite empirically verifies the fix
// against a real better-sqlite3 FTS5 table.
describe('sanitizeFtsQuery — FTS5 operator/punctuation safety (live bug 2026-07-07)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await testKnex.schema.createTable('docs', (t) => {
      t.increments('id').primary();
      t.string('chat_id').notNullable();
      t.text('content').notNullable();
    });
    await createFullTextSearch(testKnex, 'docs', 'content', 'docs_fts');
  });

  afterEach(async () => {
    if (testKnex) await testKnex.destroy();
  });

  async function search(query: string) {
    return fullTextSearch(testKnex, 'docs', 'content', 'docs_fts', 'chat1', query, 5);
  }

  it('does not throw on a lone operator-keyword token: AND', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'this is a concern about AND handling' });
    await expect(search(sanitizeFtsQuery('AND'))).resolves.not.toThrow();
  });

  it('filters 2-letter operator words like OR before they ever reach FTS5 (pre-existing length filter, still safe)', () => {
    // "OR" is 2 chars — the existing length>2 filter drops it before quoting.
    // It can never reach FTS5 unquoted; buildMemoryContext's `if (sanitized)`
    // guard also skips the search entirely when the result is empty.
    expect(sanitizeFtsQuery('OR')).toBe('');
  });

  it('never emits a bare (unquoted) operator token for any surviving word', () => {
    // Invariant: every space-separated term in the output is a fully quoted
    // prefix term. No operator keyword (AND/OR/NOT/NEAR) can leak through
    // unquoted regardless of which words survive the length filter.
    const query = sanitizeFtsQuery('AND OR NOT NEAR concern related');
    const terms = query.split(' ').filter(Boolean);
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(term).toMatch(/^"[^"]*"\*$/);
    }
  });

  it('does not throw on: NOT', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'this is NOT correct' });
    await expect(search(sanitizeFtsQuery('NOT'))).resolves.not.toThrow();
  });

  it('does not throw on: NEAR', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'stay NEAR the exit' });
    await expect(search(sanitizeFtsQuery('NEAR'))).resolves.not.toThrow();
  });

  it('does not throw on a contraction: don\'t', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: "please don't forget" });
    await expect(search(sanitizeFtsQuery("don't"))).resolves.not.toThrow();
  });

  it('does not throw on parenthesized plural: part(s)', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'order the part(s) today' });
    await expect(search(sanitizeFtsQuery('part(s)'))).resolves.not.toThrow();
  });

  it('does not throw on an embedded quoted word: "quoted"', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'he said this is quoted material' });
    await expect(search(sanitizeFtsQuery('"quoted"'))).resolves.not.toThrow();
  });

  it('matches a document containing the plain word despite operator-keyword quoting', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'this is a concern worth tracking' });
    const results = await search(sanitizeFtsQuery('concern'));
    expect(results.length).toBe(1);
  });

  it('reproduces the live message verbatim without throwing and still finds the stored episodic memory', async () => {
    const liveMessage =
      "I'm still concerned this issue could reoccur in the future AND how to prevent it from happening again.";

    // saveConversationTurn stores episodic memories as `User: <msg> → Assistant: <reply>`,
    // so the next turn's own words are what the search needs to re-find (realistic doc).
    await testKnex('docs').insert({
      chat_id: 'chat1',
      content: `User: ${liveMessage} → Assistant: Noted, I will flag it if it happens again.`,
    });
    const query = sanitizeFtsQuery(liveMessage);

    // The bug: this used to throw `fts5: syntax error near "*"`.
    const results = await search(query);
    expect(results.length).toBeGreaterThan(0);
  });

  it('still supports ordinary prefix matching (no operator words)', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'lean manufacturing principles' });
    const results = await search(sanitizeFtsQuery('lean manufacturing'));
    expect(results.length).toBe(1);
  });
});

// Follow-on bug: quoting (above) made ordinary long messages produce a
// sanitized query long enough to hit the PRE-EXISTING MAX_FTS_QUERY_LENGTH
// (200 char) truncation in db-dialect.ts's fullTextSearch. That truncation
// did a raw character slice — for a quoted query, slicing mid-token leaves
// an unbalanced `"`, which FTS5 rejects with "unterminated string" (caught
// by the caller's try/catch, silently degrading recall). Reproduced
// empirically below against a real better-sqlite3 FTS5 table.
describe('sanitizeFtsQuery — length-budget safety for quoted queries', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await testKnex.schema.createTable('docs', (t) => {
      t.increments('id').primary();
      t.string('chat_id').notNullable();
      t.text('content').notNullable();
    });
    await createFullTextSearch(testKnex, 'docs', 'content', 'docs_fts');
  });

  afterEach(async () => {
    if (testKnex) await testKnex.destroy();
  });

  async function search(query: string) {
    return fullTextSearch(testKnex, 'docs', 'content', 'docs_fts', 'chat1', query, 5);
  }

  // 219 raw chars — an ordinary message, no operator keywords, no unusual
  // punctuation. Naively quoted (`"word"*` per word) this becomes 290
  // chars, well past the 200-char cap, and a raw slice at 200 lands mid
  // "downstream" — an odd number of `"` in the truncated string.
  const longMessage =
    'I really wanted to check on the delivery schedule for next week because the warehouse team mentioned a possible delay affecting the downstream production line and we need to confirm everything before the Friday deadline';

  it('sanitizes an ordinary ~219-char message to a query at/under the FTS length cap', () => {
    const query = sanitizeFtsQuery(longMessage);
    expect(query.length).toBeLessThanOrEqual(200);
    // Every surviving term must be a complete, well-formed quoted prefix
    // term — never a partial token left over from a raw mid-token slice.
    for (const term of query.split(' ').filter(Boolean)) {
      expect(term).toMatch(/^"[^"]*"\*$/);
    }
  });

  it('does not throw FTS5 "unterminated string" on the ordinary long message and still finds a relevant doc', async () => {
    // FTS5 MATCH with multiple space-separated terms is an implicit AND, so
    // (as with episodic memories, which store the verbatim prior turn) the
    // doc needs to contain every surviving term — mirrors saveConversationTurn's
    // `User: <msg> → Assistant: <reply>` storage shape.
    await testKnex('docs').insert({
      chat_id: 'chat1',
      content: `User: ${longMessage} → Assistant: Noted, I'll follow up on that.`,
    });
    const query = sanitizeFtsQuery(longMessage);
    const results = await search(query);
    expect(results.length).toBeGreaterThan(0);
  });

  it('boundary: a message landing right at the cap keeps only whole tokens that fit, never a partial one', () => {
    // 20 repeats of a 9-char word ("warehouse") — each becomes a 12-char
    // quoted token. 15 tokens fit in 194 chars (13*15-1); the 16th would
    // push it to 207, so it must be dropped whole, not sliced.
    const boundaryMessage = Array(20).fill('warehouse').join(' ');
    const query = sanitizeFtsQuery(boundaryMessage);
    const terms = query.split(' ').filter(Boolean);

    expect(terms.length).toBe(15);
    expect(query.length).toBe(194);
    for (const term of terms) {
      expect(term).toBe('"warehouse"*');
    }
  });

  it('boundary message does not throw and still matches', async () => {
    await testKnex('docs').insert({ chat_id: 'chat1', content: 'the warehouse is fully stocked' });
    const boundaryMessage = Array(20).fill('warehouse').join(' ');
    const results = await search(sanitizeFtsQuery(boundaryMessage));
    expect(results.length).toBeGreaterThan(0);
  });
});
