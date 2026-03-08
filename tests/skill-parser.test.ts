import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown } from '../src/forge/skill-parser.js';

describe('parseSkillMarkdown', () => {
  it('parses a valid skill with all fields', () => {
    const md = `---
name: pirate
description: Responds in pirate speak
tools: [query_memory, save_memory, web_search]
---
You are a pirate captain. Respond to everything in pirate speak.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('pirate');
      expect(result.description).toBe('Responds in pirate speak');
      expect(result.tools).toEqual(['query_memory', 'save_memory', 'web_search']);
      expect(result.systemPrompt).toBe('You are a pirate captain. Respond to everything in pirate speak.');
    }
  });

  it('parses a skill without tools (defaults to null)', () => {
    const md = `---
name: minimal
description: A minimal skill
---
Just be helpful.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('minimal');
      expect(result.tools).toBeNull();
    }
  });

  it('normalizes name to lowercase', () => {
    const md = `---
name: MySkill
description: Test skill
---
Be a test.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('myskill');
    }
  });

  it('returns error for missing frontmatter', () => {
    const result = parseSkillMarkdown('Just some text without frontmatter');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Missing YAML frontmatter');
    }
  });

  it('returns error for missing closing ---', () => {
    const result = parseSkillMarkdown('---\nname: test\n');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Missing closing ---');
    }
  });

  it('returns error for missing name', () => {
    const md = `---
description: No name skill
---
Some prompt.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('name');
    }
  });

  it('returns error for missing description', () => {
    const md = `---
name: noname
---
Some prompt.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('description');
    }
  });

  it('returns error for missing body', () => {
    const md = `---
name: nobody
description: Has no body
---`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('system prompt body');
    }
  });

  it('handles quoted values in frontmatter', () => {
    const md = `---
name: "quoted"
description: "A quoted description"
---
Prompt text.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('quoted');
      expect(result.description).toBe('A quoted description');
    }
  });

  it('handles empty tools array', () => {
    const md = `---
name: notool
description: No tools
tools: []
---
Prompt.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.tools).toEqual([]);
    }
  });

  it('returns error for invalid tools format', () => {
    const md = `---
name: badtools
description: Bad tools
tools: not-an-array
---
Prompt.`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('tools format');
    }
  });

  it('preserves multiline system prompt', () => {
    const md = `---
name: multi
description: Multi-line prompt
---
First line.

Second paragraph.

- Bullet 1
- Bullet 2`;

    const result = parseSkillMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.systemPrompt).toContain('First line.');
      expect(result.systemPrompt).toContain('Second paragraph.');
      expect(result.systemPrompt).toContain('- Bullet 1');
    }
  });
});
