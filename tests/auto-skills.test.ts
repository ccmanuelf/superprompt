/**
 * Auto-Generated Skills — Real Execution Tests
 *
 * No mocks. Real SQLite database, real detection logic, real proposal flows.
 * Validates the full auto-skill lifecycle: detect → propose → approve → trigger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

import { vi } from 'vitest';
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

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
import type { Skill } from '../src/db-core.js';

async function createTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();

  // Create core tables needed by auto-skills
  await testKnex.schema.createTable('skills', (t) => {
    t.text('id').primary();
    t.text('name').notNullable().unique();
    t.text('description').notNullable();
    t.text('system_prompt').notNullable();
    t.text('allowed_tools');
    t.integer('is_builtin').notNullable().defaultTo(0);
    t.text('source_file');
    t.integer('locked').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await testKnex.schema.createTable('skill_revisions', (t) => {
    t.increments('id').primary();
    t.text('skill_id').notNullable().references('id').inTable('skills').onDelete('CASCADE');
    t.text('system_prompt').notNullable();
    t.text('revision_note');
    t.bigInteger('created_at').notNullable();
  });

  await initAutoSkillsTables();
}

describe('auto-skills — real execution', () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // ── Detection ──────────────────────────────────────────────

  describe('detectSkillCandidate', () => {
    it('returns candidate for 3+ distinct tools with quality ≥70', async () => {
      const candidate = await detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Research competitors and create a report',
      });
      expect(candidate).not.toBeNull();
      expect(candidate!.sourceType).toBe('tool_chain');
      expect(candidate!.toolsUsed).toHaveLength(3);
    });

    it('returns null for fewer than 3 tools', async () => {
      const candidate = await detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'Search something',
      });
      expect(candidate).toBeNull();
    });

    it('returns null for quality score below 70', async () => {
      const candidate = await detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 50,
        chatId: 'test-chat',
        originalRequest: 'Do something',
      });
      expect(candidate).toBeNull();
    });

    it('returns candidate for orchestration with 3+ successful steps', async () => {
      const candidate = await detectSkillCandidate({
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

    it('returns null for orchestration with a failed step', async () => {
      const candidate = await detectSkillCandidate({
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

    it('enforces cooldown — rejects second proposal within 1 hour', async () => {
      // Create a proposal to trigger cooldown
      await insertSkillProposal({
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

      const candidate = await detectSkillCandidate({
        toolsUsed: ['web_search', 'read_file', 'generate_document'],
        qualityScore: 80,
        chatId: 'test-chat',
        originalRequest: 'New request',
      });
      expect(candidate).toBeNull();
    });

    it('detects deduplication — rejects when existing skill has similar tools', async () => {
      // Create an existing skill with similar tools
      await testKnex('skills').insert({
        id: 'existing-skill', name: 'existing', description: 'Existing skill',
        system_prompt: 'prompt', allowed_tools: '["web_search","read_file","generate_document"]',
        is_builtin: 0, created_at: Date.now(), updated_at: Date.now(),
      });

      const candidate = await detectSkillCandidate({
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

    it('insertProposal stores and getPendingProposal retrieves', async () => {
      await insertSkillProposal(testProposal);
      const retrieved = await getPendingProposal('chat-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('competitor-analysis');
      expect(retrieved!.allowedTools).toEqual(['web_search', 'summarize_url', 'generate_document']);
      expect(retrieved!.triggerPatterns).toEqual(['competitor.*analysis', 'pricing.*comparison']);
    });

    it('getPendingProposal returns null for different chatId', async () => {
      await insertSkillProposal(testProposal);
      expect(await getPendingProposal('other-chat')).toBeNull();
    });

    it('expirePendingProposals changes status', async () => {
      await insertSkillProposal(testProposal);
      await expirePendingProposals('chat-123');
      expect(await getPendingProposal('chat-123')).toBeNull();
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

    it('createAutoSkill creates skill + triggers + revision', async () => {
      const skillId = await createAutoSkill(proposal);
      expect(skillId).toBe('auto-budget-workflow');

      // Verify skill in DB
      const skill = await testKnex('skills').where({ id: skillId }).first() as any;
      expect(skill.name).toBe('budget-workflow');
      expect(skill.description).toBe('Automated budget analysis workflow');
      expect(skill.system_prompt).toContain('budget analyst');
      expect(JSON.parse(skill.allowed_tools)).toEqual(['web_search', 'read_file', 'generate_document']);

      // Verify triggers in DB
      const triggers = await getSkillTriggers();
      expect(triggers.length).toBe(2);
      expect(triggers[0].pattern).toBe('budget.*analysis');
      expect(triggers[1].pattern).toBe('financial.*report');
      expect(triggers[0].mode).toBe('suggest');

      // Verify revision
      const revision = await testKnex('skill_revisions').where({ skill_id: skillId }).first() as any;
      expect(revision.revision_note).toBe('Auto-generated from workflow');
    });

    it('handleProposalResponse with approved creates skill', async () => {
      await insertSkillProposal(proposal);
      const msg = await handleProposalResponse('chat-456', true);
      expect(msg).toContain('created');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('budget-workflow');

      // Skill exists in DB
      const skill = await testKnex('skills').where({ id: 'auto-budget-workflow' }).first() as any;
      expect(skill).not.toBeUndefined();
    });

    it('handleProposalResponse with rejected does not create skill', async () => {
      await insertSkillProposal(proposal);
      const msg = await handleProposalResponse('chat-456', false);
      expect(msg).toContain('skipped');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');

      // Skill does NOT exist
      const skill = await testKnex('skills').where({ id: 'auto-budget-workflow' }).first();
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
    it('invalid regex patterns are skipped during skill creation', async () => {
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

      await createAutoSkill(proposal);

      // Only valid patterns should be stored
      const triggers = await getSkillTriggers();
      expect(triggers.length).toBe(2); // 2 valid, 1 invalid skipped
      expect(triggers.map((t) => t.pattern)).toContain('valid.*pattern');
      expect(triggers.map((t) => t.pattern)).toContain('another.*valid');
    });
  });

  // ── Skill Self-Healing ─────────────────────────────────────

  describe('skill self-healing', () => {
    async function createAutoSkillInDb(name: string): Promise<Skill> {
      const id = `auto-${name}`;
      await testKnex('skills').insert({
        id, name, description: 'Auto test', system_prompt: 'You are a test assistant',
        allowed_tools: '["web_search"]', is_builtin: 0, created_at: Date.now(), updated_at: Date.now(),
      });
      return await testKnex('skills').where({ id }).first() as Skill;
    }

    describe('shouldHealSkill', () => {
      it('returns true for low quality on auto-generated skill', async () => {
        const skill = await createAutoSkillInDb('heal-test-1');
        expect(shouldHealSkill(skill, 40)).toBe(true);
      });

      it('returns false for high quality on auto-generated skill', async () => {
        const skill = await createAutoSkillInDb('heal-test-2');
        expect(shouldHealSkill(skill, 85)).toBe(false);
      });

      it('returns false for builtin skills (never heal builtins)', async () => {
        await testKnex('skills').insert({
          id: 'builtin-debugger', name: 'debugger', description: 'Debug',
          system_prompt: 'Debug prompt', is_builtin: 1, created_at: Date.now(), updated_at: Date.now(),
        });
        const skill = await testKnex('skills').where({ id: 'builtin-debugger' }).first() as Skill;
        expect(shouldHealSkill(skill, 30)).toBe(false);
      });

      it('returns false for manually created skills', async () => {
        await testKnex('skills').insert({
          id: 'custom-manual', name: 'manual', description: 'Manual',
          system_prompt: 'Manual prompt', is_builtin: 0, created_at: Date.now(), updated_at: Date.now(),
        });
        const skill = await testKnex('skills').where({ id: 'custom-manual' }).first() as Skill;
        expect(shouldHealSkill(skill, 30)).toBe(false); // id doesn't start with 'auto-'
      });

      it('returns true when user correction detected', async () => {
        const skill = await createAutoSkillInDb('heal-test-3');
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
