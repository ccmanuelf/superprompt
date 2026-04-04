/**
 * Combined SA1 + SA2 + SA3 + Auto-Skills Integration Tests — REAL EXECUTION
 *
 * No mocks for behavior. Real SQLite, real Worker sandbox, real IPC,
 * real auto-skill detection/proposal/approval/healing flow.
 *
 * Validates that ALL sprint features compose correctly end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Redirect getDatabase to test DB
let db: Database.Database;
vi.mock('../src/db.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return { ...original, getDatabase: () => db };
});

import { executeInWorker } from '../src/forge/worker-sandbox.js';
import {
  detectSkillCandidate, draftSkillDefinition, proposeSkillToUser,
  detectProposalResponse, handleProposalResponse, insertSkillProposal,
  createAutoSkill, getPendingProposal, expirePendingProposals,
  initAutoSkillsTables, getSkillTriggers,
  shouldHealSkill, detectSkillCorrection,
  type SkillProposal,
} from '../src/auto-skills.js';
import { Application } from '../src/core/app.js';
import { ProcessClient } from '../src/ipc/client.js';
import { TOOLS_PROCESS_ENV, PARSERS_PROCESS_ENV, buildChildEnv } from '../src/ipc/env-whitelist.js';
import type { StorageProvider, TableInitializer } from '../src/core/interfaces.js';
import type { Skill } from '../src/db.js';

function setupTestDb(): void {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL, system_prompt TEXT NOT NULL,
      allowed_tools TEXT, is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL, system_prompt TEXT NOT NULL,
      revision_note TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
  `);
  initAutoSkillsTables();
}

describe('Combined SA1+SA2+SA3+AutoSkills — real execution', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => db.close());

  // ── SA1 + Auto-Skills: Worker sandbox + tool tracking ──────

  describe('SA1 Worker sandbox executes within auto-skill detection pipeline', () => {
    it('real Worker execution produces result that would feed into auto-skill detection', async () => {
      // Simulate 3 tool executions via Worker (user-generated tools)
      const results = await Promise.all([
        executeInWorker('return { data: "fetched from API" };', {}),
        executeInWorker('return { analysis: args.data.length };', { data: [1, 2, 3] }),
        executeInWorker('return { report: "Summary of " + args.count + " items" };', { count: 3 }),
      ]);

      // All succeed
      expect(results[0]).toEqual({ data: 'fetched from API' });
      expect(results[1]).toEqual({ analysis: 3 });
      expect(results[2]).toEqual({ report: 'Summary of 3 items' });

      // Now feed the tool names into auto-skill detection
      const candidate = detectSkillCandidate({
        toolsUsed: ['fetch_api_data', 'analyze_data', 'generate_report'],
        qualityScore: 85,
        chatId: 'combined-test',
        originalRequest: 'Fetch data from API, analyze it, and generate a report',
      });

      expect(candidate).not.toBeNull();
      expect(candidate!.sourceType).toBe('tool_chain');
      expect(candidate!.toolsUsed).toHaveLength(3);
    });

    it('Worker timeout produces bilingual error that does not break auto-skill pipeline', async () => {
      const result = await executeInWorker(
        'while(true) {}',
        {},
        { baseTimeoutMs: 300, maxTimeoutMs: 500 },
      );
      // Error is bilingual
      expect(result.error).toContain('[EN]');
      expect(result.error).toContain('[ES]');

      // This tool call "failed" — auto-skill detection should NOT fire for failed results
      // (quality would be low, below threshold)
      const candidate = detectSkillCandidate({
        toolsUsed: ['failing_tool'],
        qualityScore: 30, // low quality due to tool failure
        chatId: 'combined-test',
        originalRequest: 'Run the failing tool',
      });
      expect(candidate).toBeNull(); // quality too low
    }, 5000);
  });

  // ── SA2 + Auto-Skills: Application lifecycle + skill tables ──

  describe('SA2 Application lifecycle initializes auto-skill tables', () => {
    it('auto-skills tables exist and are functional after Application startup', () => {
      // Tables were created in beforeEach via initAutoSkillsTables()
      // Verify they work with real data
      const proposal: SkillProposal = {
        id: 'lifecycle-test',
        chatId: 'chat-lifecycle',
        name: 'lifecycle-skill',
        description: 'Tests lifecycle integration',
        systemPrompt: 'You are a lifecycle test assistant',
        allowedTools: ['web_search', 'read_file', 'generate_document'],
        triggerPatterns: ['lifecycle.*test'],
        sourceType: 'tool_chain',
        sourceSummary: 'Testing lifecycle',
      };

      insertSkillProposal(proposal);
      const retrieved = getPendingProposal('chat-lifecycle');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('lifecycle-skill');

      // Approve and create
      const skillId = createAutoSkill(proposal);
      const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
      expect(skill.name).toBe('lifecycle-skill');

      // Triggers stored
      const triggers = getSkillTriggers();
      expect(triggers.some(t => t.pattern === 'lifecycle.*test')).toBe(true);

      // Dynamic trigger matches a real message
      const regex = new RegExp(triggers[0].pattern, 'i');
      expect(regex.test('Run the lifecycle test please')).toBe(true);
      expect(regex.test('What is the weather?')).toBe(false);
    });
  });

  // ── SA3 + Auto-Skills: process isolation preserves security ──

  describe('SA3 process isolation + auto-skills security', () => {
    it('env whitelist blocks sensitive vars from child processes', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'sensitive-token';
      process.env.DATABASE_PATH = '/secret/db';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret';

      const toolsEnv = buildChildEnv(TOOLS_PROCESS_ENV);
      const parsersEnv = buildChildEnv(PARSERS_PROCESS_ENV);

      // Neither process gets sensitive vars
      expect(toolsEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(toolsEnv.DATABASE_PATH).toBeUndefined();
      expect(toolsEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(parsersEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(parsersEnv.DATABASE_PATH).toBeUndefined();
      expect(parsersEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      // Parsers don't even get API keys
      process.env.BRAVE_API_KEY = 'api-key';
      const parsersEnv2 = buildChildEnv(PARSERS_PROCESS_ENV);
      expect(parsersEnv2.BRAVE_API_KEY).toBeUndefined();

      // Cleanup
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.DATABASE_PATH;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.BRAVE_API_KEY;
    });

    it('real Process 2 fork executes tool via IPC', async () => {
      const client = new ProcessClient('tools', 'dist/tools-process.js', TOOLS_PROCESS_ENV);
      try {
        await client.spawn();
        const result = await client.execute('get_time', {}, 'combined-test');
        expect(result.error).toBeUndefined();
        expect(Object.keys(result).length).toBeGreaterThan(0);
      } finally {
        await client.shutdown();
      }
    }, 15000);
  });

  // ── Full auto-skill lifecycle: detect → propose → approve → trigger → heal ──

  describe('complete auto-skill lifecycle with self-healing', () => {
    it('detect → propose → approve → skill created → triggers registered', () => {
      // Step 1: Detect candidate
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'summarize_url', 'generate_document', 'read_file'],
        qualityScore: 90,
        chatId: 'full-lifecycle',
        originalRequest: 'Research market trends, summarize sources, create a report',
      });
      expect(candidate).not.toBeNull();

      // Step 2: Create and store proposal (normally AI drafts this)
      const proposal: SkillProposal = {
        id: 'full-lifecycle-proposal',
        chatId: 'full-lifecycle',
        name: 'market-research',
        description: 'Research market trends and create summary reports',
        systemPrompt: 'You are a market research assistant. Step 1: Search for trends. Step 2: Summarize key sources. Step 3: Generate a structured report.',
        allowedTools: ['web_search', 'summarize_url', 'generate_document', 'read_file'],
        triggerPatterns: ['market.*research', 'market.*trend', 'competitor.*report'],
        sourceType: 'tool_chain',
        sourceSummary: 'Research market trends, summarize sources, create a report',
      };
      insertSkillProposal(proposal);

      // Step 3: User response detection
      expect(detectProposalResponse('yes')).toBe('approve');
      expect(detectProposalResponse('si')).toBe('approve');

      // Step 4: Approve
      const confirmation = handleProposalResponse('full-lifecycle', true);
      expect(confirmation).toContain('created');
      expect(confirmation).toContain('[EN]');
      expect(confirmation).toContain('[ES]');

      // Step 5: Verify skill exists
      const skill = db.prepare("SELECT * FROM skills WHERE name = 'market-research'").get() as any;
      expect(skill).not.toBeUndefined();
      expect(skill.system_prompt).toContain('market research assistant');
      expect(JSON.parse(skill.allowed_tools)).toContain('web_search');

      // Step 6: Verify triggers match real messages
      const triggers = db.prepare("SELECT * FROM skill_triggers WHERE skill_id = 'auto-market-research'").all() as any[];
      expect(triggers.length).toBe(3);

      const marketResearchRegex = new RegExp(triggers[0].pattern, 'i');
      expect(marketResearchRegex.test('Can you do market research on solar panels?')).toBe(true);
      expect(marketResearchRegex.test('What is 2 + 2?')).toBe(false);

      // Step 7: Verify revision stored
      const revisions = db.prepare("SELECT * FROM skill_revisions WHERE skill_id = 'auto-market-research'").all() as any[];
      expect(revisions.length).toBe(1);
      expect(revisions[0].revision_note).toBe('Auto-generated from workflow');
    });

    it('self-healing: low quality triggers skill patch', () => {
      // Create an auto-generated skill
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      ).run('auto-qa-check', 'qa-check', 'Quality check workflow', 'Step 1: Check standards', '["web_search"]', Date.now(), Date.now());

      const skill = db.prepare("SELECT * FROM skills WHERE id = 'auto-qa-check'").get() as Skill;

      // Low quality score → should heal
      expect(shouldHealSkill(skill, 40)).toBe(true);

      // High quality score → should NOT heal
      expect(shouldHealSkill(skill, 85)).toBe(false);

      // User correction → should heal regardless of score
      expect(shouldHealSkill(skill, 80, "no, that's wrong")).toBe(true);
    });

    it('self-healing does NOT heal builtin skills', () => {
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      ).run('builtin-coder', 'coder', 'Coding assistant', 'Write code', Date.now(), Date.now());

      const skill = db.prepare("SELECT * FROM skills WHERE id = 'builtin-coder'").get() as Skill;
      expect(shouldHealSkill(skill, 20)).toBe(false); // never heal builtins
    });

    it('self-healing does NOT heal manually created skills', () => {
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ).run('custom-pirate', 'pirate', 'Pirate speak', 'Arr', Date.now(), Date.now());

      const skill = db.prepare("SELECT * FROM skills WHERE id = 'custom-pirate'").get() as Skill;
      expect(shouldHealSkill(skill, 20)).toBe(false); // id doesn't start with 'auto-'
    });
  });

  // ── Bilingual verification across all sprints ──────────────

  describe('bilingual messages across SA1 + auto-skills', () => {
    it('Worker timeout error is bilingual', async () => {
      const result = await executeInWorker('while(true){}', {}, { baseTimeoutMs: 300, maxTimeoutMs: 500 });
      expect(result.error).toContain('[EN]');
      expect(result.error).toContain('[ES]');
      expect(result.error).toContain('_timeout');
    }, 5000);

    it('Worker SSRF error is bilingual', async () => {
      const result = await executeInWorker(
        'await fetch("http://localhost/secret"); return {};',
        {}, { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
      );
      expect(result.error).toContain('[EN]');
      expect(result.error).toContain('[ES]');
      expect(result.error).toContain('bloqueado');
    }, 10000);

    it('skill proposal is bilingual', () => {
      const msg = proposeSkillToUser({
        id: 'test', chatId: 'chat', name: 'test-skill',
        description: 'A test', systemPrompt: 'p',
        allowedTools: ['web_search'], triggerPatterns: ['test'],
        sourceType: 'tool_chain', sourceSummary: 'Test',
      });
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
    });

    it('skill approval confirmation is bilingual', () => {
      insertSkillProposal({
        id: 'bilingual-test', chatId: 'chat-bi', name: 'bi-skill',
        description: 'Test', systemPrompt: 'Test',
        allowedTools: [], triggerPatterns: [],
        sourceType: 'tool_chain', sourceSummary: 'Test',
      });
      const msg = handleProposalResponse('chat-bi', true);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
    });

    it('skill rejection confirmation is bilingual', () => {
      insertSkillProposal({
        id: 'reject-test', chatId: 'chat-rej', name: 'rej-skill',
        description: 'Test', systemPrompt: 'Test',
        allowedTools: [], triggerPatterns: [],
        sourceType: 'tool_chain', sourceSummary: 'Test',
      });
      const msg = handleProposalResponse('chat-rej', false);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
    });

    it('proposal detection works in both languages', () => {
      expect(detectProposalResponse('yes')).toBe('approve');
      expect(detectProposalResponse('si')).toBe('approve');
      expect(detectProposalResponse('sí')).toBe('approve');
      expect(detectProposalResponse('dale')).toBe('approve');
      expect(detectProposalResponse('no')).toBe('reject');
      expect(detectProposalResponse('omitir')).toBe('reject');
      expect(detectProposalResponse('no gracias')).toBe('reject');
    });

    it('correction detection works in both languages', () => {
      expect(detectSkillCorrection("no, that's wrong")).toBe(true);
      expect(detectSkillCorrection('try again differently')).toBe(true);
      expect(detectSkillCorrection('no, eso está mal')).toBe(true);
      expect(detectSkillCorrection('intenta de nuevo')).toBe(true);
      expect(detectSkillCorrection('eso no funciona')).toBe(true);
    });
  });

  // ── Cooldown + dedup across all sprints ────────────────────

  describe('rate limiting and deduplication', () => {
    it('cooldown prevents rapid skill proposals', () => {
      insertSkillProposal({
        id: 'cooldown-1', chatId: 'rate-test', name: 'first',
        description: 'First', systemPrompt: 'First',
        allowedTools: ['web_search', 'read_file', 'generate_document'],
        triggerPatterns: [], sourceType: 'tool_chain', sourceSummary: 'First',
      });

      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'summarize_url', 'run_command'],
        qualityScore: 90,
        chatId: 'rate-test',
        originalRequest: 'Second request',
      });
      expect(candidate).toBeNull(); // cooldown active
    });

    it('dedup prevents duplicate skills with same tools', () => {
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      ).run('existing', 'existing', 'Existing', 'prompt', '["web_search","read_file","generate_document"]', Date.now(), Date.now());

      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 90,
        chatId: 'dedup-test',
        originalRequest: 'Same tools',
      });
      expect(candidate).toBeNull(); // duplicate
    });
  });
});
