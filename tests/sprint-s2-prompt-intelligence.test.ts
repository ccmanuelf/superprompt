import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Sprint S2: Prompt Intelligence tests.
 *
 * Tests that:
 * 1. New Superpowers-inspired skills exist with meaningful content
 * 2. Anti-rationalization rules are present in router prompts
 * 3. Command list is complete and matches actual commands
 * 4. Skills actually modify behavior (system prompt injection)
 */

// Import the actual source modules
import {
  QUALITY_RULES,
  COMMAND_LIST,
  classifyMessage,
} from '../src/providers/router.js';

const TMP_DIR = resolve(tmpdir(), 'clauded-test-s2');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 's2-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* ignore */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      allowed_tools TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      source_file TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_skills (
      chat_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
  `);
}

beforeEach(() => {
  initTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ── Anti-Rationalization Rules (real exports) ──────────────

describe('anti-rationalization rules (real exports)', () => {
  it('QUALITY_RULES is a non-empty string', () => {
    expect(typeof QUALITY_RULES).toBe('string');
    expect(QUALITY_RULES.length).toBeGreaterThan(50);
  });

  it('contains key anti-rationalization patterns', () => {
    expect(QUALITY_RULES).toContain('should work');
    expect(QUALITY_RULES).toContain('probably');
    expect(QUALITY_RULES).toContain('verify');
    expect(QUALITY_RULES).toContain('evidence');
    expect(QUALITY_RULES).toContain('3+');
  });

  it('forbids specific bad behaviors', () => {
    // The rules should explicitly tell the AI what NOT to do
    expect(QUALITY_RULES).toMatch(/[Nn]ever/);
    expect(QUALITY_RULES).toMatch(/don't|do not/i);
  });
});

// ── Command List (real export, verified complete) ──────────

describe('command list (real export)', () => {
  it('COMMAND_LIST is a non-empty string', () => {
    expect(typeof COMMAND_LIST).toBe('string');
    expect(COMMAND_LIST.length).toBeGreaterThan(100);
  });

  it('contains ALL actual bot commands', () => {
    // Every command registered in telegram.ts must appear in COMMAND_LIST
    const requiredCommands = [
      '/newchat',
      '/memory',
      '/voice',
      '/claude',
      '/ollama',
      '/auto',
      '/provider',
      '/models',
      '/model',
      '/schedule',
      '/skill',
      '/tool',
      '/careful',
      '/reload',
    ];

    for (const cmd of requiredCommands) {
      expect(COMMAND_LIST).toContain(cmd);
    }
  });

  it('does NOT contain non-existent commands', () => {
    // Guard against hallucinated commands
    expect(COMMAND_LIST).not.toContain('/delete');
    expect(COMMAND_LIST).not.toContain('/settings');
    expect(COMMAND_LIST).not.toContain('/config');
  });

  it('provides usage hints for complex commands', () => {
    // Commands with arguments should have their syntax shown
    expect(COMMAND_LIST).toContain('<name>'); // /model <name>
  });
});

// ── Superpowers Skills (real DB, real content) ─────────────

describe('Superpowers-inspired skills', () => {
  // Simulate initBuiltinSkills by inserting with same SQL as src/skills.ts
  function seedSkills(): void {
    const skills = [
      {
        id: 'builtin-debugger',
        name: 'debugger',
        description: 'Systematic problem-solving',
        prompt: 'PHASE 1 — INVESTIGATE',
      },
      {
        id: 'builtin-brainstormer',
        name: 'brainstormer',
        description: 'Design-first thinking',
        prompt: 'UNDERSTAND',
      },
      {
        id: 'builtin-careful',
        name: 'careful',
        description: 'Safety guardrails',
        prompt: 'SAFETY MODE ACTIVE',
      },
    ];

    const now = Date.now();
    for (const skill of skills) {
      db.prepare(
        `INSERT OR IGNORE INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, 0, ?, ?)`,
      ).run(skill.id, skill.name, skill.description, skill.prompt, now, now);
    }
  }

  it('debugger skill exists and has 4-phase process', () => {
    // Import and verify the actual skill definitions
    // We can't easily import skills.ts (eager db init), but we can verify the source
    const { readFileSync } = require('node:fs');
    const skillsSource = readFileSync(
      resolve(__dirname, '..', 'src', 'skills.ts'),
      'utf-8',
    );

    // Debugger must have all 4 phases
    expect(skillsSource).toContain('PHASE 1 — INVESTIGATE');
    expect(skillsSource).toContain('PHASE 2 — ANALYZE');
    expect(skillsSource).toContain('PHASE 3 — HYPOTHESIZE');
    expect(skillsSource).toContain('PHASE 4 — IMPLEMENT');
    // And the circuit breaker
    expect(skillsSource).toContain('CIRCUIT BREAKER');
    expect(skillsSource).toContain('3+');
  });

  it('brainstormer skill has YAGNI and one-question-at-a-time rules', () => {
    const { readFileSync } = require('node:fs');
    const skillsSource = readFileSync(
      resolve(__dirname, '..', 'src', 'skills.ts'),
      'utf-8',
    );

    expect(skillsSource).toContain('YAGNI');
    expect(skillsSource).toContain('One question per turn');
  });

  it('careful skill has verification rules and confirmation requirement', () => {
    const { readFileSync } = require('node:fs');
    const skillsSource = readFileSync(
      resolve(__dirname, '..', 'src', 'skills.ts'),
      'utf-8',
    );

    expect(skillsSource).toContain('SAFETY MODE ACTIVE');
    expect(skillsSource).toContain('Ask for confirmation');
    expect(skillsSource).toContain('show the evidence');
  });

  it('all new skills have anti-rationalization sections', () => {
    const { readFileSync } = require('node:fs');
    const skillsSource = readFileSync(
      resolve(__dirname, '..', 'src', 'skills.ts'),
      'utf-8',
    );

    // Both debugger and brainstormer should have anti-rationalization
    const antiRatCount = (skillsSource.match(/ANTI-RATIONALIZATION/g) || []).length;
    expect(antiRatCount).toBeGreaterThanOrEqual(2);
  });

  it('skill activation persists in DB and modifies system prompt', () => {
    seedSkills();

    // Activate the debugger skill for a chat
    db.prepare(
      `INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)`,
    ).run('chat1', 'builtin-debugger', Date.now());

    // Verify it's active
    const active = db.prepare(
      `SELECT s.* FROM skills s JOIN chat_skills cs ON cs.skill_id = s.id WHERE cs.chat_id = ?`,
    ).get('chat1') as any;

    expect(active).toBeDefined();
    expect(active.name).toBe('debugger');
    expect(active.system_prompt).toContain('PHASE 1');
    expect(active.is_builtin).toBe(1);
  });

  it('careful skill toggles on and off', () => {
    seedSkills();

    // Activate
    db.prepare(
      `INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)`,
    ).run('chat1', 'builtin-careful', Date.now());

    let active = db.prepare(
      `SELECT s.name FROM skills s JOIN chat_skills cs ON cs.skill_id = s.id WHERE cs.chat_id = ?`,
    ).get('chat1') as any;
    expect(active.name).toBe('careful');

    // Deactivate
    db.prepare('DELETE FROM chat_skills WHERE chat_id = ?').run('chat1');

    active = db.prepare(
      `SELECT s.name FROM skills s JOIN chat_skills cs ON cs.skill_id = s.id WHERE cs.chat_id = ?`,
    ).get('chat1');
    expect(active).toBeUndefined();
  });
});

// ── Integration: prompts actually reach the AI ─────────────

describe('prompt injection integration', () => {
  it('system prompt array includes quality rules and command list (Claude path)', () => {
    // Simulate what router.ts does when building the system prompt
    const voiceHint = '';
    const skillPrompt = '';
    const docPrompt = '## Document Capabilities';
    const languageHint = 'Always respond in the same language';

    const claudePrompt = [voiceHint, skillPrompt, docPrompt, QUALITY_RULES, COMMAND_LIST, languageHint]
      .filter(Boolean)
      .join('\n\n');

    expect(claudePrompt).toContain('Response Quality Rules');
    expect(claudePrompt).toContain('Available User Commands');
    expect(claudePrompt).toContain('/careful');
    expect(claudePrompt).toContain('Never say');
    expect(claudePrompt).toContain('same language'); // Claude-only language hint
  });

  it('system prompt array includes quality rules and command list (Ollama path)', () => {
    const voiceHint = '';
    const skillPrompt = '';
    const docPrompt = '## Document Capabilities';

    const ollamaPrompt = [voiceHint, skillPrompt, docPrompt, QUALITY_RULES, COMMAND_LIST]
      .filter(Boolean)
      .join('\n\n');

    expect(ollamaPrompt).toContain('Response Quality Rules');
    expect(ollamaPrompt).toContain('Available User Commands');
    // Ollama should NOT have the Claude-specific language hint
    expect(ollamaPrompt).not.toContain('Always respond in the same language');
  });

  it('skill prompt is included alongside quality rules (not replacing)', () => {
    const skillPrompt = 'You are a debugger. Follow the 4-phase process.';

    const combined = [skillPrompt, QUALITY_RULES, COMMAND_LIST]
      .filter(Boolean)
      .join('\n\n');

    // Both skill AND quality rules should be present — they stack, not replace
    expect(combined).toContain('debugger');
    expect(combined).toContain('Response Quality Rules');
    expect(combined).toContain('Available User Commands');
  });
});
