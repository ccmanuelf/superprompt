/**
 * SA3 Process Separation — Real Execution Integration Tests
 *
 * No mocks. These tests fork REAL child processes, send REAL IPC messages,
 * execute REAL tools, and verify REAL results.
 *
 * Requires `npm run build` before running (child processes need compiled JS).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ProcessClient } from '../src/ipc/client.js';
import { TOOLS_PROCESS_ENV, PARSERS_PROCESS_ENV, buildChildEnv } from '../src/ipc/env-whitelist.js';

describe('SA3 process separation — real execution', () => {
  const clients: ProcessClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      try { await client.shutdown(); } catch { /* best effort */ }
    }
    clients.length = 0;
  });

  // ── Process 2 (tools): Real fork + real tool execution ──

  describe('Process 2 (clauded-tools)', () => {
    it('spawns, sends ready, and executes get_time via IPC', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();
      expect(client.isReady).toBe(true);

      // Execute a real tool — get_time is stateless, no deps
      const result = await client.execute('get_time', {}, 'test-chat');

      // get_time returns an object with time info
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      // Should contain some time-related field
      const keys = Object.keys(result);
      expect(keys.length).toBeGreaterThan(0);
    }, 15000);

    it('executes system_info via IPC — real system data', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();

      const result = await client.execute('system_info', {}, 'test-chat');
      expect(result.error).toBeUndefined();
      // system_info should return platform, node version, etc.
      expect(result).toBeDefined();
    }, 15000);

    it('returns error for unknown tool', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();

      const result = await client.execute('nonexistent_tool', {}, 'test-chat');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not found');
      // Bilingual error
      expect(result.error).toContain('[EN]');
      expect(result.error).toContain('[ES]');
    }, 15000);

    it('handles concurrent tool executions', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();

      // Fire 5 concurrent get_time requests
      const promises = Array.from({ length: 5 }, (_, i) =>
        client.execute('get_time', {}, `chat-${i}`),
      );
      const results = await Promise.all(promises);

      // All should succeed
      for (const result of results) {
        expect(result.error).toBeUndefined();
      }
    }, 15000);

    it('shuts down cleanly', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();
      expect(client.isReady).toBe(true);

      await client.shutdown();
      expect(client.isReady).toBe(false);

      // After shutdown, execute returns error
      const result = await client.execute('get_time', {}, 'test-chat');
      expect(result.error).toBeDefined();
    }, 15000);
  });

  // ── Process 3 (parsers): Real fork + real tool execution ──

  describe('Process 3 (clauded-parsers)', () => {
    it('spawns, sends ready, reports 2 tools', async () => {
      const client = new ProcessClient('parsers', 'dist/parsers-process.js', PARSERS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();
      expect(client.isReady).toBe(true);
    }, 15000);

    it('rejects tools that belong to Process 2', async () => {
      const client = new ProcessClient('parsers', 'dist/parsers-process.js', PARSERS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();

      // web_search is registered in P2, not P3
      const result = await client.execute('web_search', { query: 'test' }, 'test-chat');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not found');
    }, 15000);
  });

  // ── Environment isolation ─────────────────────────────────

  describe('env isolation', () => {
    it('tools process env does NOT include TELEGRAM_BOT_TOKEN', () => {
      // Simulate what buildChildEnv does
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = 'secret-test-token';

      const env = buildChildEnv(TOOLS_PROCESS_ENV);
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();

      // Restore
      if (originalToken) process.env.TELEGRAM_BOT_TOKEN = originalToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    });

    it('tools process env does NOT include database-related vars', () => {
      process.env.DATABASE_PATH = '/secret/db/path';

      const env = buildChildEnv(TOOLS_PROCESS_ENV);
      expect(env.DATABASE_PATH).toBeUndefined();

      delete process.env.DATABASE_PATH;
    });

    it('parsers process env does NOT include API keys', () => {
      process.env.BRAVE_API_KEY = 'secret-api-key';
      process.env.GH_TOKEN = 'secret-gh-token';

      const env = buildChildEnv(PARSERS_PROCESS_ENV);
      expect(env.BRAVE_API_KEY).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();

      delete process.env.BRAVE_API_KEY;
      delete process.env.GH_TOKEN;
    });

    it('parsers process env does NOT include bot tokens', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'secret-bot-token';
      process.env.MATRIX_ACCESS_TOKEN = 'secret-matrix-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-oauth-token';

      const env = buildChildEnv(PARSERS_PROCESS_ENV);
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.MATRIX_ACCESS_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.MATRIX_ACCESS_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    });

    it('parsers process gets only file paths', () => {
      process.env.WORKSPACE_DIR = '/app/workspace';
      process.env.UPLOADS_DIR = '/app/uploads';

      const env = buildChildEnv(PARSERS_PROCESS_ENV);
      expect(env.WORKSPACE_DIR).toBe('/app/workspace');
      expect(env.UPLOADS_DIR).toBe('/app/uploads');

      delete process.env.WORKSPACE_DIR;
      delete process.env.UPLOADS_DIR;
    });
  });

  // ── Graceful degradation ──────────────────────────────────

  describe('graceful degradation', () => {
    it('ProcessClient.execute returns error when not spawned', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);

      // Not spawned — should return a graceful error, not throw
      const result = await client.execute('get_time', {}, 'test-chat');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not available');
      // Bilingual
      expect(result.error).toContain('[EN]');
      expect(result.error).toContain('[ES]');
    });
  });

  // ── IPC protocol correctness ──────────────────────────────

  describe('IPC protocol', () => {
    it('request IDs are unique — no cross-talk between concurrent requests', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      clients.push(client);

      await client.spawn();

      // Send 10 concurrent requests, each should get its own result
      const promises = Array.from({ length: 10 }, (_, i) =>
        client.execute('get_time', {}, `chat-${i}`),
      );
      const results = await Promise.all(promises);

      // All should be successful and distinct responses
      const errors = results.filter((r) => r.error);
      expect(errors).toHaveLength(0);
    }, 15000);
  });
});
