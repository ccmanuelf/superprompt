/**
 * Auto-Generated Skills — Real Execution Tests
 *
 * No mocks. Real SQLite database, real detection logic, real proposal flows.
 * Validates the full auto-skill lifecycle: detect → propose → approve → trigger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// We need to set up a real DB before importing auto-skills (it uses getDatabase())
let db: Database.Database;

// Mock getDatabase to use our test DB
import { vi } from 'vitest';
vi.mock('../src/db.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    getDatabase: () => db,
  };
});

import {
  detectSkillCandidate,
  proposeSkillToUser,
  detectProposalResponse,
  handleProposalResponse,
  getPendingProposal,
  expirePendingProposals,
  insertSkillProposal,
  createAutoSkill,
  initAutoSkillsTables,
  getSkillTriggers,
  shouldHealSkill,
  detectSkillCorrection,
  type SkillProposal,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db.js';

function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');

  // Create core tables needed by auto-skills
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      allowed_tools TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      revision_note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
  `);

  return testDb;
}

describe('auto-skills — real execution', () => {
  beforeEach(() => {
    db = createTestDb();
    initAutoSkillsTables();
  });

  afterEach(() => {
    db.close();
  });

  // ── Detection ──────────────────────────────────────────────

  describe('detectSkillCandidate', () => {
    it('returns candidate for 3+ distinct tools with quality ≥70', () => {
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Research competitors and create a report',
      });
      expect(candidate).not.toBeNull();
      expect(candidate!.sourceType).toBe('tool_chain');
      expect(candidate!.toolsUsed).toHaveLength(3);
    });

    it('returns null for fewer than 3 tools', () => {
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Search something',
      });
      expect(candidate).toBeNull();
    });

    it('returns null for quality score below 70', () => {
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 50,
        chatId: 'test-chat',
        originalRequest: 'Do something',
      });
      expect(candidate).toBeNull();
    });

    it('returns candidate for orchestration with 3+ successful steps', () => {
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'summarize_url', 'generate_document'],
        stepResults: [
          { step: 1, instruction: 'Search', output: 'Found 5 results', success: true },
          { step: 2, instruction: 'Analyze', output: 'Compared pricing', success: true },
          { step: 3, instruction: 'Report', output: 'Created document', success: true },
        ],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Research competitors, compare pricing, create report',
      });
      expect(candidate).not.toBeNull();
      expect(candidate!.sourceType).toBe('orchestration');
    });

    it('returns null for orchestration with a failed step', () => {
      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'summarize_url', 'generate_document'],
        stepResults: [
          { step: 1, instruction: 'Search', output: 'Found results', success: true },
          { step: 2, instruction: 'Analyze', output: 'Error: timeout', success: false },
          { step: 3, instruction: 'Report', output: 'Skipped', success: true },
        ],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Research and report',
      });
      expect(candidate).toBeNull();
    });

    it('enforces cooldown — rejects second proposal within 1 hour', () => {
      // Create a proposal to trigger cooldown
      insertSkillProposal({
        id: 'existing-proposal',
        chatId: 'test-chat',
        name: 'old-skill',
        description: 'Old',
        systemPrompt: 'Old prompt',
        allowedTools: ['web_search'],
        triggerPatterns: [],
        sourceType: 'tool_chain',
        sourceSummary: 'Old request',
      });

      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'New request',
      });
      expect(candidate).toBeNull();
    });

    it('detects deduplication — rejects when existing skill has similar tools', () => {
      // Create an existing skill with similar tools
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, allowed_tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('existing-skill', 'existing', 'Existing skill', 'prompt', '["web_search","read_file","generate_document"]', Date.now(), Date.now());

      const candidate = detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Same tools',
      });
      expect(candidate).toBeNull();
    });
  });

  // ── Proposal Flow ──────────────────────────────────────────

  describe('proposal flow', () => {
    const testProposal: SkillProposal = {
      id: 'test-proposal-1',
      chatId: 'chat-123',
      name: 'competitor-analysis',
      description: 'Research competitors, compare pricing, create summary',
      systemPrompt: 'You are a competitive analysis assistant. Step 1: Search for competitors...',
      allowedTools: ['web_search', 'summarize_url', 'generate_document'],
      triggerPatterns: ['competitor.*analysis', 'pricing.*comparison'],
      sourceType: 'orchestration',
      sourceSummary: 'Research competitors and compare pricing',
    };

    it('insertProposal stores and getPendingProposal retrieves', () => {
      insertSkillProposal(testProposal);
      const retrieved = getPendingProposal('chat-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('competitor-analysis');
      expect(retrieved!.allowedTools).toEqual(['web_search', 'summarize_url', 'generate_document']);
      expect(retrieved!.triggerPatterns).toEqual(['competitor.*analysis', 'pricing.*comparison']);
    });

    it('getPendingProposal returns null for different chatId', () => {
      insertSkillProposal(testProposal);
      expect(getPendingProposal('other-chat')).toBeNull();
    });

    it('expirePendingProposals changes status', () => {
      insertSkillProposal(testProposal);
      expirePendingProposals('chat-123');
      expect(getPendingProposal('chat-123')).toBeNull();
    });
  });

  // ── Approval / Rejection ───────────────────────────────────

  describe('approval flow', () => {
    const proposal: SkillProposal = {
      id: 'approval-test',
      chatId: 'chat-456',
      name: 'budget-workflow',
      description: 'Automated budget analysis workflow',
      systemPrompt: 'You are a budget analyst. Follow these steps...',
      allowedTools: ['web_search', 'read_file', 'generate_document'],
      triggerPatterns: ['budget.*analysis', 'financial.*report'],
      sourceType: 'tool_chain',
      sourceSummary: 'Analyze budget and create report',
    };

    it('createAutoSkill creates skill + triggers + revision', () => {
      const skillId = createAutoSkill(proposal);
      expect(skillId).toBe('auto-budget-workflow');

      // Verify skill in DB
      const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
      expect(skill.name).toBe('budget-workflow');
      expect(skill.description).toBe('Automated budget analysis workflow');
      expect(skill.system_prompt).toContain('budget analyst');
      expect(JSON.parse(skill.allowed_tools)).toEqual(['web_search', 'read_file', 'generate_document']);

      // Verify triggers in DB
      const triggers = getSkillTriggers();
      expect(triggers.length).toBe(2);
      expect(triggers[0].pattern).toBe('budget.*analysis');
      expect(triggers[1].pattern).toBe('financial.*report');
      expect(triggers[0].mode).toBe('suggest');

      // Verify revision
      const revision = db.prepare('SELECT * FROM skill_revisions WHERE skill_id = ?').get(skillId) as any;
      expect(revision.revision_note).toBe('Auto-generated from workflow');
    });

    it('handleProposalResponse with approved creates skill', () => {
      insertSkillProposal(proposal);
      const msg = handleProposalResponse('chat-456', true);
      expect(msg).toContain('created');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('budget-workflow');

      // Skill exists in DB
      const skill = db.prepare("SELECT * FROM skills WHERE id = 'auto-budget-workflow'").get() as any;
      expect(skill).not.toBeUndefined();
    });

    it('handleProposalResponse with rejected does not create skill', () => {
      insertSkillProposal(proposal);
      const msg = handleProposalResponse('chat-456', false);
      expect(msg).toContain('skipped');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');

      // Skill does NOT exist
      const skill = db.prepare("SELECT * FROM skills WHERE id = 'auto-budget-workflow'").get();
      expect(skill).toBeUndefined();
    });
  });

  // ── Proposal Detection (user response matching) ────────────

  describe('detectProposalResponse', () => {
    it('detects English affirmative', () => {
      expect(detectProposalResponse('yes')).toBe('approve');
      expect(detectProposalResponse('Yes')).toBe('approve');
      expect(detectProposalResponse('sure')).toBe('approve');
      expect(detectProposalResponse('ok')).toBe('approve');
      expect(detectProposalResponse('yep')).toBe('approve');
    });

    it('detects Spanish affirmative', () => {
      expect(detectProposalResponse('si')).toBe('approve');
      expect(detectProposalResponse('sí')).toBe('approve');
      expect(detectProposalResponse('dale')).toBe('approve');
      expect(detectProposalResponse('claro')).toBe('approve');
    });

    it('detects English negative', () => {
      expect(detectProposalResponse('no')).toBe('reject');
      expect(detectProposalResponse('nah')).toBe('reject');
      expect(detectProposalResponse('skip')).toBe('reject');
      expect(detectProposalResponse('cancel')).toBe('reject');
    });

    it('detects Spanish negative', () => {
      expect(detectProposalResponse('omitir')).toBe('reject');
      expect(detectProposalResponse('cancelar')).toBe('reject');
      expect(detectProposalResponse('no gracias')).toBe('reject');
    });

    it('returns null for longer messages (not a proposal response)', () => {
      expect(detectProposalResponse('Tell me about the weather today please')).toBeNull();
      expect(detectProposalResponse('I want to analyze the data from last quarter')).toBeNull();
    });

    it('returns null for ambiguous short messages', () => {
      expect(detectProposalResponse('hello')).toBeNull();
      expect(detectProposalResponse('hola')).toBeNull();
      expect(detectProposalResponse('help')).toBeNull();
    });
  });

  // ── Bilingual Messages ─────────────────────────────────────

  describe('bilingual messages', () => {
    it('proposeSkillToUser returns EN + ES', () => {
      const msg = proposeSkillToUser({
        id: 'test',
        chatId: 'chat',
        name: 'test-skill',
        description: 'A test skill',
        systemPrompt: 'prompt',
        allowedTools: ['web_search'],
        triggerPatterns: ['test.*pattern'],
        sourceType: 'tool_chain',
        sourceSummary: 'Test',
      });
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('test-skill');
      expect(msg).toContain('web_search');
      expect(msg).toContain('yes');
      expect(msg).toContain('si');
    });
  });

  // ── Dynamic Trigger Validation ─────────────────────────────

  describe('dynamic triggers', () => {
    it('invalid regex patterns are skipped during skill creation', () => {
      const proposal: SkillProposal = {
        id: 'trigger-test',
        chatId: 'chat',
        name: 'trigger-skill',
        description: 'Test',
        systemPrompt: 'Test prompt',
        allowedTools: ['web_search'],
        triggerPatterns: ['valid.*pattern', '[invalid(regex', 'another.*valid'],
        sourceType: 'tool_chain',
        sourceSummary: 'Test',
      };

      createAutoSkill(proposal);

      // Only valid patterns should be stored
      const triggers = getSkillTriggers();
      expect(triggers.length).toBe(2); // 2 valid, 1 invalid skipped
      expect(triggers.map((t) => t.pattern)).toContain('valid.*pattern');
      expect(triggers.map((t) => t.pattern)).toContain('another.*valid');
    });
  });

  // ── Skill Self-Healing ─────────────────────────────────────

  describe('skill self-healing', () => {
    function createAutoSkillInDb(name: string): Skill {
      const id = `auto-${name}`;
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      ).run(id, name, 'Auto test', 'You are a test assistant', '["web_search"]', Date.now(), Date.now());
      return db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill;
    }

    describe('shouldHealSkill', () => {
      it('returns true for low quality on auto-generated skill', () => {
        const skill = createAutoSkillInDb('heal-test-1');
        expect(shouldHealSkill(skill, 40)).toBe(true);
      });

      it('returns false for high quality on auto-generated skill', () => {
        const skill = createAutoSkillInDb('heal-test-2');
        expect(shouldHealSkill(skill, 85)).toBe(false);
      });

      it('returns false for builtin skills (never heal builtins)', () => {
        db.prepare(
          'INSERT INTO skills (id, name, description, system_prompt, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        ).run('builtin-debugger', 'debugger', 'Debug', 'Debug prompt', Date.now(), Date.now());
        const skill = db.prepare("SELECT * FROM skills WHERE id = 'builtin-debugger'").get() as Skill;
        expect(shouldHealSkill(skill, 30)).toBe(false);
      });

      it('returns false for manually created skills', () => {
        db.prepare(
          'INSERT INTO skills (id, name, description, system_prompt, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        ).run('custom-manual', 'manual', 'Manual', 'Manual prompt', Date.now(), Date.now());
        const skill = db.prepare("SELECT * FROM skills WHERE id = 'custom-manual'").get() as Skill;
        expect(shouldHealSkill(skill, 30)).toBe(false); // id doesn't start with 'auto-'
      });

      it('returns true when user correction detected', () => {
        const skill = createAutoSkillInDb('heal-test-3');
        expect(shouldHealSkill(skill, 80, "no, that's wrong")).toBe(true);
      });
    });

    describe('detectSkillCorrection', () => {
      it('detects English corrections', () => {
        expect(detectSkillCorrection("no, that's wrong")).toBe(true);
        expect(detectSkillCorrection('try again differently')).toBe(true);
        expect(detectSkillCorrection("that didn't work")).toBe(true);
        expect(detectSkillCorrection('wrong approach')).toBe(true);
        expect(detectSkillCorrection('you should have used a different method')).toBe(true);
      });

      it('detects Spanish corrections', () => {
        expect(detectSkillCorrection('no, eso está mal')).toBe(true);
        expect(detectSkillCorrection('intenta de nuevo')).toBe(true);
        expect(detectSkillCorrection('eso no funciona')).toBe(true);
        expect(detectSkillCorrection('enfoque incorrecto')).toBe(true);
      });

      it('returns false for normal messages', () => {
        expect(detectSkillCorrection('What is the weather today?')).toBe(false);
        expect(detectSkillCorrection('Show me the production report')).toBe(false);
        expect(detectSkillCorrection('Thanks, that looks great')).toBe(false);
      });
    });
  });
});
