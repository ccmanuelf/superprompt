import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePackYaml } from '../src/packs.js';

describe('parsePackYaml — Finance pack.yaml', () => {
  const content = readFileSync(resolve(process.cwd(), 'packs/finance/pack.yaml'), 'utf-8');
  const parsed = parsePackYaml(content);

  it('extracts name', () => {
    expect(parsed.name).toBe('finance');
  });

  it('extracts display_name (quoted)', () => {
    expect(parsed.display_name).toBe('Finance & Accounting');
  });

  it('extracts description (quoted)', () => {
    expect(parsed.description).toContain('Financial analysis');
  });

  it('extracts version', () => {
    expect(parsed.version).toBe('1.0.0');
  });

  it('extracts enabled', () => {
    expect(parsed.enabled).toBe('true');
  });

  it('extracts capabilities as multiline block', () => {
    expect(parsed.capabilities).toBeDefined();
    expect(typeof parsed.capabilities).toBe('string');
    expect(parsed.capabilities!.length).toBeGreaterThan(50);
    expect(parsed.capabilities).toContain('Finance & Accounting');
    expect(parsed.capabilities).toContain('calculate_npv');
    expect(parsed.capabilities).toContain('budget_variance');
    expect(parsed.capabilities).toContain('NPV');
  });

  it('extracts self_description as multiline block', () => {
    expect(parsed.self_description).toBeDefined();
    expect(typeof parsed.self_description).toBe('string');
    expect(parsed.self_description!.length).toBeGreaterThan(10);
    expect(parsed.self_description).toContain('Finance & Accounting');
  });

  it('extracts intent_patterns as array', () => {
    expect(Array.isArray(parsed.intent_patterns)).toBe(true);
    expect(parsed.intent_patterns!.length).toBe(3);
  });

  it('intent_patterns[0] has correct fields', () => {
    const p = parsed.intent_patterns![0];
    expect(p.pattern).toBeDefined();
    expect(typeof p.pattern).toBe('string');
    expect(p.score_boost).toBeDefined();
    expect(p.tools).toBeDefined();
    expect(Array.isArray(p.tools)).toBe(true);
  });

  it('intent pattern regex strings are valid when unescaped', () => {
    for (const ip of parsed.intent_patterns!) {
      const regexStr = (ip.pattern as string).replace(/\\\\/g, '\\');
      expect(() => new RegExp(regexStr, 'i')).not.toThrow();
    }
  });

  it('intent patterns contain expected tools', () => {
    const allTools = parsed.intent_patterns!.flatMap(ip => ip.tools || []);
    expect(allTools).toContain('calculate_npv');
    expect(allTools).toContain('budget_variance');
  });

  it('commands is empty array', () => {
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(parsed.commands).toHaveLength(0);
  });
});

describe('parsePackYaml — Template pack.yaml', () => {
  const content = readFileSync(resolve(process.cwd(), 'packs/_template/pack.yaml'), 'utf-8');
  const parsed = parsePackYaml(content);

  it('extracts name from comment-heavy file', () => {
    expect(parsed.name).toBe('template');
  });

  it('extracts capabilities block despite comments', () => {
    expect(parsed.capabilities).toBeDefined();
    expect(parsed.capabilities!.length).toBeGreaterThan(10);
  });

  it('extracts intent_patterns', () => {
    expect(Array.isArray(parsed.intent_patterns)).toBe(true);
    expect(parsed.intent_patterns!.length).toBeGreaterThan(0);
  });
});

describe('parsePackYaml — Edge Cases', () => {
  it('handles minimal pack.yaml', () => {
    const yaml = `name: minimal\ndescription: "A minimal pack"\nenabled: true`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.name).toBe('minimal');
    expect(parsed.description).toBe('A minimal pack');
    expect(parsed.enabled).toBe('true');
  });

  it('handles empty capabilities block', () => {
    const yaml = `name: empty\ncapabilities: |\n  \n`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.name).toBe('empty');
    // capabilities should be empty or whitespace after trimming
  });

  it('handles no intent_patterns key', () => {
    const yaml = `name: nointent\ndescription: "No patterns"`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.name).toBe('nointent');
    expect(parsed.intent_patterns).toBeUndefined();
  });

  it('handles YAML with --- document markers', () => {
    const yaml = `---\nname: markers\ndescription: "Has markers"\n---`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.name).toBe('markers');
  });

  it('handles intent_patterns with web_apps', () => {
    const yaml = `name: webapps
intent_patterns:
  - pattern: "\\\\btest\\\\b"
    score_boost: 15
    tools: [tool_a, tool_b]
    web_apps: [/dashboard]
`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.intent_patterns).toHaveLength(1);
    expect(parsed.intent_patterns![0].tools).toEqual(['tool_a', 'tool_b']);
    expect(parsed.intent_patterns![0].web_apps).toEqual(['/dashboard']);
    expect(parsed.intent_patterns![0].score_boost).toBe('15');
  });

  it('handles commands array', () => {
    const yaml = `name: cmds
commands:
  - name: finance
    description: "Financial tools"
  - name: budget
    description: "Budget analysis"
`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands![0].name).toBe('finance');
    expect(parsed.commands![0].description).toBe('Financial tools');
    expect(parsed.commands![1].name).toBe('budget');
  });

  it('handles multiline block with mixed indentation', () => {
    const yaml = `name: mixed
capabilities: |
  Line one
  Line two
    Indented deeper
  Back to normal
description: "After block"`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.capabilities).toContain('Line one');
    expect(parsed.capabilities).toContain('Indented deeper');
    expect(parsed.description).toBe('After block');
  });

  it('does not confuse comment lines with keys', () => {
    // Comment lines start with # and should be skipped by the key regex
    const yaml = `# This is a comment\nname: commented\n# Another comment\ndescription: "Has comments"`;
    const parsed = parsePackYaml(yaml);
    expect(parsed.name).toBe('commented');
    expect(parsed.description).toBe('Has comments');
  });
});

describe('parsePackYaml — Regex escaping (critical)', () => {
  it('YAML double-quoted \\\\b becomes JS \\b for word boundary regex', () => {
    // In pack.yaml on disk: pattern: "\\b(npv|irr)\\b"
    // The file literally has backslash-backslash-b.
    // The parser must unescape \\\\ → \\ so RegExp gets \\b = word boundary.
    const yaml = 'name: regex_test\nintent_patterns:\n  - pattern: "\\\\b(npv|irr)\\\\b"\n    score_boost: 10\n    tools: [calculate_npv]\n    web_apps: []\n';
    const parsed = parsePackYaml(yaml);
    const pattern = parsed.intent_patterns![0].pattern as string;

    // The parsed string should have single backslash + b
    const re = new RegExp(pattern, 'i');
    expect(re.test('calculate npv')).toBe(true);
    expect(re.test('what is irr')).toBe(true);
    expect(re.test('hello world')).toBe(false);
  });

  it('finance pack.yaml intent patterns actually match finance messages', () => {
    const content = readFileSync(resolve(process.cwd(), 'packs/finance/pack.yaml'), 'utf-8');
    const parsed = parsePackYaml(content);

    for (const ip of parsed.intent_patterns!) {
      const re = new RegExp(ip.pattern as string, 'i');
      // Each pattern should match at least one finance-related message
      if ((ip.pattern as string).includes('npv')) {
        expect(re.test('calculate the npv for this investment')).toBe(true);
        expect(re.test('what is the internal rate of return')).toBe(true);
        expect(re.test('random unrelated message')).toBe(false);
      }
      if ((ip.pattern as string).includes('budget')) {
        expect(re.test('analyze the budget variance')).toBe(true);
        expect(re.test('we are over budget this quarter')).toBe(true);
        expect(re.test('random unrelated message')).toBe(false);
      }
    }
  });
});
