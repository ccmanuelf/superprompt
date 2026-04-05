/**
 * Pack Builder — Real Execution Tests
 *
 * Tests the conversational pack builder: blueprint generation,
 * proposal formatting, file creation, and guide output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatPackProposal,
  detectPackCreationResponse,
  buildPackFromBlueprint,
  setPendingBlueprint,
  getPendingBlueprint,
  clearPendingBlueprint,
  getPackGuide,
  type PackBlueprint,
} from '../src/pack-builder.js';

const PACKS_DIR = resolve(process.cwd(), 'packs');

// Clean up test packs
const testPackNames: string[] = [];
afterEach(() => {
  for (const name of testPackNames) {
    const dir = resolve(PACKS_DIR, name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  testPackNames.length = 0;
});

const sampleBlueprint: PackBlueprint = {
  name: 'test-quality',
  displayName: 'Quality Engineering',
  description: 'Tools for quality audits, inspection planning, and defect tracking',
  tools: [
    {
      name: 'audit_checklist',
      description: 'Generate an audit checklist from process description',
      parameters: [
        { name: 'process_name', type: 'string', description: 'Process to audit', required: true },
        { name: 'standard', type: 'string', description: 'Standard (ISO 9001, etc.)', required: false },
      ],
      code: 'const checks = ["Document control", "Record keeping", "Corrective actions"]; return { process: args.process_name, standard: args.standard || "ISO 9001", checklist: checks };',
    },
  ],
  skillName: 'quality-advisor',
  skillPrompt: 'You are a quality engineering expert specializing in ISO standards and process improvement.',
  intentPatterns: ['quality.*audit', 'inspection.*plan'],
  departments: ['manufacturing', 'engineering'],
};

describe('pack-builder — real execution', () => {

  describe('formatPackProposal', () => {
    it('generates bilingual proposal with tool list', () => {
      const msg = formatPackProposal(sampleBlueprint);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('Quality Engineering');
      expect(msg).toContain('test-quality');
      expect(msg).toContain('audit_checklist');
      expect(msg).toContain('quality-advisor');
      expect(msg).toContain('manufacturing');
      expect(msg).toContain('crear');
    });
  });

  describe('detectPackCreationResponse', () => {
    it('detects English creation responses', () => {
      expect(detectPackCreationResponse('create')).toBe('create');
      expect(detectPackCreationResponse('build')).toBe('create');
      expect(detectPackCreationResponse('yes')).toBe('create');
      expect(detectPackCreationResponse('go')).toBe('create');
    });

    it('detects Spanish creation responses', () => {
      expect(detectPackCreationResponse('crear')).toBe('create');
      expect(detectPackCreationResponse('construir')).toBe('create');
      expect(detectPackCreationResponse('si')).toBe('create');
      expect(detectPackCreationResponse('dale')).toBe('create');
    });

    it('returns null for normal messages', () => {
      expect(detectPackCreationResponse('tell me about quality')).toBeNull();
      expect(detectPackCreationResponse('what tools do we have')).toBeNull();
    });
  });

  describe('buildPackFromBlueprint', () => {
    it('creates complete pack directory with all files', () => {
      testPackNames.push('test-quality');
      const packDir = buildPackFromBlueprint(sampleBlueprint);

      // Directory exists
      expect(existsSync(packDir)).toBe(true);

      // pack.yaml exists and has content
      const yamlPath = resolve(packDir, 'pack.yaml');
      expect(existsSync(yamlPath)).toBe(true);

      // Tool .md file exists
      const toolPath = resolve(packDir, 'tools', 'audit-checklist.md');
      expect(existsSync(toolPath)).toBe(true);

      // Skill .md file exists
      const skillPath = resolve(packDir, 'skills', 'quality-advisor.md');
      expect(existsSync(skillPath)).toBe(true);

      // README exists
      expect(existsSync(resolve(packDir, 'README.md'))).toBe(true);

      // Subdirectories exist
      expect(existsSync(resolve(packDir, 'tools'))).toBe(true);
      expect(existsSync(resolve(packDir, 'skills'))).toBe(true);
      expect(existsSync(resolve(packDir, 'templates'))).toBe(true);
    });

    it('throws if pack already exists', () => {
      testPackNames.push('test-quality');
      buildPackFromBlueprint(sampleBlueprint);
      expect(() => buildPackFromBlueprint(sampleBlueprint)).toThrow('already exists');
    });

    it('creates multi-tool pack', () => {
      const multiToolBlueprint: PackBlueprint = {
        name: 'test-multi',
        displayName: 'Multi Tool Pack',
        description: 'Pack with multiple tools',
        tools: [
          { name: 'tool_one', description: 'First tool', parameters: [], code: 'return { one: true };' },
          { name: 'tool_two', description: 'Second tool', parameters: [], code: 'return { two: true };' },
          { name: 'tool_three', description: 'Third tool', parameters: [], code: 'return { three: true };' },
        ],
        intentPatterns: ['multi.*tool'],
        departments: ['engineering'],
      };
      testPackNames.push('test-multi');
      const packDir = buildPackFromBlueprint(multiToolBlueprint);

      expect(existsSync(resolve(packDir, 'tools', 'tool-one.md'))).toBe(true);
      expect(existsSync(resolve(packDir, 'tools', 'tool-two.md'))).toBe(true);
      expect(existsSync(resolve(packDir, 'tools', 'tool-three.md'))).toBe(true);
    });
  });

  describe('pending blueprint state', () => {
    it('stores and retrieves pending blueprint', () => {
      setPendingBlueprint('chat-1', sampleBlueprint);
      const retrieved = getPendingBlueprint('chat-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('test-quality');
    });

    it('returns null when no pending blueprint', () => {
      expect(getPendingBlueprint('no-chat')).toBeNull();
    });

    it('clears pending blueprint', () => {
      setPendingBlueprint('chat-2', sampleBlueprint);
      clearPendingBlueprint('chat-2');
      expect(getPendingBlueprint('chat-2')).toBeNull();
    });
  });

  describe('getPackGuide', () => {
    it('returns bilingual guide with all 3 levels', () => {
      const guide = getPackGuide();
      expect(guide).toContain('[EN]');
      expect(guide).toContain('[ES]');
      expect(guide).toContain('Level 1');
      expect(guide).toContain('Level 2');
      expect(guide).toContain('Level 3');
      expect(guide).toContain('/pack enable');
      expect(guide).toContain('/pack disable');
      expect(guide).toContain('Nivel 1');
      expect(guide).toContain('Nivel 2');
      expect(guide).toContain('Nivel 3');
    });
  });
});
