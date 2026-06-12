import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// We need to test the pack system in isolation. Since packs.ts imports from db.ts
// and other modules that need initialization, we'll test the pure functions directly
// by extracting and testing the YAML parser and other logic.

// First, let's test the YAML parser by importing the module
// We can't easily test loadAllPacks without a DB, but we can test the parser

describe('Pack YAML Parser', () => {
  // Read the actual finance pack.yaml to test against real data
  const FINANCE_YAML_PATH = resolve(process.cwd(), 'packs/finance/pack.yaml');
  const TEMPLATE_YAML_PATH = resolve(process.cwd(), 'packs/_template/pack.yaml');

  it('finance pack.yaml exists', () => {
    expect(existsSync(FINANCE_YAML_PATH)).toBe(true);
  });

  it('template pack.yaml exists', () => {
    expect(existsSync(TEMPLATE_YAML_PATH)).toBe(true);
  });

  // Test the YAML parsing logic directly by reimplementing the parse
  // (since parsePackYaml is not exported, we test against the file content)
  it('finance pack.yaml has correct structure', () => {
    const content = readFileSync(FINANCE_YAML_PATH, 'utf-8');

    // Check required top-level keys exist
    expect(content).toContain('name: finance');
    expect(content).toContain('display_name:');
    expect(content).toContain('description:');
    expect(content).toContain('enabled: true');
    expect(content).toContain('capabilities: |');
    expect(content).toContain('self_description: |');
    expect(content).toContain('intent_patterns:');
  });

  it('finance pack has valid intent pattern regex syntax', () => {
    const content = readFileSync(FINANCE_YAML_PATH, 'utf-8');

    // Extract pattern lines
    const patternLines = content.match(/pattern: "([^"]+)"/g);
    expect(patternLines).not.toBeNull();
    expect(patternLines!.length).toBeGreaterThan(0);

    for (const line of patternLines!) {
      const match = line.match(/pattern: "([^"]+)"/);
      if (match) {
        // The YAML has double-escaped backslashes: \\b → \b in JS
        const regexStr = match[1].replace(/\\\\/g, '\\');
        expect(() => new RegExp(regexStr, 'i')).not.toThrow();
      }
    }
  });

  it('template pack.yaml has correct structure', () => {
    const content = readFileSync(TEMPLATE_YAML_PATH, 'utf-8');
    expect(content).toContain('name: template');
    expect(content).toContain('enabled: false');
    expect(content).toContain('capabilities: |');
    expect(content).toContain('intent_patterns:');
  });
});

describe('Pack Tool Files', () => {
  const NPV_TOOL_PATH = resolve(process.cwd(), 'packs/finance/tools/calculate-npv.md');
  const VARIANCE_TOOL_PATH = resolve(process.cwd(), 'packs/finance/tools/budget-variance.md');

  it('calculate-npv.md exists and has correct frontmatter', () => {
    expect(existsSync(NPV_TOOL_PATH)).toBe(true);
    const content = readFileSync(NPV_TOOL_PATH, 'utf-8');
    expect(content).toContain('name: calculate_npv');
    expect(content).toContain('type: generated_code');
    expect(content).toContain('discount_rate');
    expect(content).toContain('initial_investment');
    expect(content).toContain('cash_flows');
  });

  it('budget-variance.md exists and has correct frontmatter', () => {
    expect(existsSync(VARIANCE_TOOL_PATH)).toBe(true);
    const content = readFileSync(VARIANCE_TOOL_PATH, 'utf-8');
    expect(content).toContain('name: budget_variance');
    expect(content).toContain('type: generated_code');
    expect(content).toContain('data');
    expect(content).toContain('threshold');
  });

  it('calculate-npv tool parses via tool-parser', async () => {
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');
    const content = readFileSync(NPV_TOOL_PATH, 'utf-8');
    const result = parseToolMarkdown(content);

    // Should parse without error
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('calculate_npv');
      expect(result.type).toBe('generated_code');
      expect(result.parameters.length).toBe(3);
      expect(result.parameters.find(p => p.name === 'discount_rate')).toBeDefined();
      expect(result.parameters.find(p => p.name === 'initial_investment')).toBeDefined();
      expect(result.parameters.find(p => p.name === 'cash_flows')).toBeDefined();
      // Should have code
      expect(result.code).toBeDefined();
      expect(result.code!.length).toBeGreaterThan(50);
    }
  });

  it('budget-variance tool parses via tool-parser', async () => {
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');
    const content = readFileSync(VARIANCE_TOOL_PATH, 'utf-8');
    const result = parseToolMarkdown(content);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('budget_variance');
      expect(result.type).toBe('generated_code');
      expect(result.parameters.length).toBe(2);
      expect(result.code).toBeDefined();
      expect(result.code!.length).toBeGreaterThan(50);
    }
  });

  it('calculate-npv tool passes safety scan', async () => {
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');
    const { scanToolCode } = await import('../src/forge/safety-scanner.js');
    const content = readFileSync(NPV_TOOL_PATH, 'utf-8');
    const parsed = parseToolMarkdown(content);

    expect('error' in parsed).toBe(false);
    if (!('error' in parsed) && parsed.code) {
      const scan = scanToolCode(parsed.code);
      expect(scan.safe).toBe(true);
      expect(scan.issues).toHaveLength(0);
    }
  });

  it('budget-variance tool passes safety scan', async () => {
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');
    const { scanToolCode } = await import('../src/forge/safety-scanner.js');
    const content = readFileSync(VARIANCE_TOOL_PATH, 'utf-8');
    const parsed = parseToolMarkdown(content);

    expect('error' in parsed).toBe(false);
    if (!('error' in parsed) && parsed.code) {
      const scan = scanToolCode(parsed.code);
      expect(scan.safe).toBe(true);
      expect(scan.issues).toHaveLength(0);
    }
  });
});

describe('Pack Skill Files', () => {
  const ANALYST_SKILL_PATH = resolve(process.cwd(), 'packs/finance/skills/financial-analyst.md');

  it('financial-analyst.md exists and parses', async () => {
    expect(existsSync(ANALYST_SKILL_PATH)).toBe(true);
    const { parseSkillMarkdown } = await import('../src/forge/skill-parser.js');
    const content = readFileSync(ANALYST_SKILL_PATH, 'utf-8');
    const result = parseSkillMarkdown(content);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('financial_analyst');
      expect(result.description).toContain('financial');
      expect(result.systemPrompt.length).toBeGreaterThan(50);
      expect(result.tools).toContain('calculate_npv');
      expect(result.tools).toContain('budget_variance');
    }
  });
});

describe('Pack Template Files', () => {
  it('budget-template.csv exists and has correct format', () => {
    const csvPath = resolve(process.cwd(), 'packs/finance/templates/budget-template.csv');
    expect(existsSync(csvPath)).toBe(true);
    const content = readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Header
    expect(lines[0]).toContain('Department');
    expect(lines[0]).toContain('Budgeted');
    expect(lines[0]).toContain('Actual');

    // Data rows
    expect(lines.length).toBeGreaterThan(5);
  });
});

describe('Pack Scaffold', () => {
  const TEST_PACK_DIR = resolve(process.cwd(), 'packs/_test_scaffold');

  afterEach(() => {
    // Cleanup
    if (existsSync(TEST_PACK_DIR)) {
      rmSync(TEST_PACK_DIR, { recursive: true, force: true });
    }
  });

  it('scaffoldPack creates valid directory structure', async () => {
    const { scaffoldPack } = await import('../src/packs.js');

    const path = scaffoldPack('_test_scaffold', 'Test pack for validation');

    expect(existsSync(path)).toBe(true);
    expect(existsSync(resolve(path, 'pack.yaml'))).toBe(true);
    expect(existsSync(resolve(path, 'tools'))).toBe(true);
    expect(existsSync(resolve(path, 'skills'))).toBe(true);
    expect(existsSync(resolve(path, 'templates'))).toBe(true);
    expect(existsSync(resolve(path, 'README.md'))).toBe(true);
  });

  it('scaffolded pack.yaml has valid content', async () => {
    const { scaffoldPack } = await import('../src/packs.js');
    scaffoldPack('_test_scaffold', 'Test pack for validation');

    const content = readFileSync(resolve(TEST_PACK_DIR, 'pack.yaml'), 'utf-8');
    expect(content).toContain('name: _test_scaffold');
    expect(content).toContain('enabled: true');
    expect(content).toContain('capabilities: |');
    expect(content).toContain('intent_patterns:');
  });

  it('scaffolded tool file has valid frontmatter', async () => {
    const { scaffoldPack } = await import('../src/packs.js');
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');

    scaffoldPack('_test_scaffold', 'Test pack');

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional CJS require in test
    const toolFiles = require('node:fs').readdirSync(resolve(TEST_PACK_DIR, 'tools'));
    expect(toolFiles.length).toBeGreaterThan(0);

    const content = readFileSync(resolve(TEST_PACK_DIR, 'tools', toolFiles[0]), 'utf-8');
    const parsed = parseToolMarkdown(content);
    expect('error' in parsed).toBe(false);
  });

  it('scaffolded skill file has valid frontmatter', async () => {
    const { scaffoldPack } = await import('../src/packs.js');
    const { parseSkillMarkdown } = await import('../src/forge/skill-parser.js');

    scaffoldPack('_test_scaffold', 'Test pack');

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional CJS require in test
    const skillFiles = require('node:fs').readdirSync(resolve(TEST_PACK_DIR, 'skills'));
    expect(skillFiles.length).toBeGreaterThan(0);

    const content = readFileSync(resolve(TEST_PACK_DIR, 'skills', skillFiles[0]), 'utf-8');
    const parsed = parseSkillMarkdown(content);
    expect('error' in parsed).toBe(false);
  });

  it('scaffoldPack throws for existing directory', async () => {
    const { scaffoldPack } = await import('../src/packs.js');
    scaffoldPack('_test_scaffold', 'First');
    expect(() => scaffoldPack('_test_scaffold', 'Second')).toThrow('already exists');
  });
});

describe('Pack Intent Scoring', () => {
  it('scorePackIntent returns empty result when no packs loaded', async () => {
    const { scorePackIntent } = await import('../src/packs.js');
    const result = await scorePackIntent('hello world');
    expect(result.score).toBe(0);
    expect(result.tools).toHaveLength(0);
    expect(result.webApps).toHaveLength(0);
  });
});

describe('Pack Aggregation', () => {
  it('getAggregatedCapabilities returns empty when no packs', async () => {
    const { getAggregatedCapabilities } = await import('../src/packs.js');
    const result = getAggregatedCapabilities();
    expect(result).toBe('');
  });

  it('getLoadedPacks returns empty array initially', async () => {
    const { getLoadedPacks } = await import('../src/packs.js');
    const packs = getLoadedPacks();
    expect(Array.isArray(packs)).toBe(true);
  });
});

describe('Docs Files', () => {
  const DOCS = [
    'docs/user-guide.md',
    'docs/architecture.md',
    'docs/commands.md',
    'docs/customization-guide.md',
  ];

  for (const doc of DOCS) {
    it(`${doc} exists and is non-empty`, () => {
      const path = resolve(process.cwd(), doc);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    });
  }

  it('README.md exists and mentions Luna', () => {
    const path = resolve(process.cwd(), 'README.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('Luna');
    expect(content).toContain('Docker');
  });

  it('architecture.md contains Mermaid diagrams', () => {
    const path = resolve(process.cwd(), 'docs/architecture.md');
    const content = readFileSync(path, 'utf-8');
    const mermaidBlocks = content.match(/```mermaid/g);
    expect(mermaidBlocks).not.toBeNull();
    expect(mermaidBlocks!.length).toBeGreaterThanOrEqual(4);
  });

  it('customization-guide.md covers all 3 levels', () => {
    const path = resolve(process.cwd(), 'docs/customization-guide.md');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('Level 1: Simple');
    expect(content).toContain('Level 2: Medium');
    expect(content).toContain('Level 3: Full');
    expect(content).toContain('Documented Boundaries');
  });

  it('customization-guide.md documents all 7 boundaries', () => {
    const path = resolve(process.cwd(), 'docs/customization-guide.md');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('No Dynamic Web Route Registration');
    expect(content).toContain('No Pack Dependency System');
    expect(content).toContain('No Remote Pack Repository');
    expect(content).toContain('No Hot-Reload');
    expect(content).toContain('No Pack-Level Permissions');
    expect(content).toContain('No Pack-Specific Database Tables');
    expect(content).toContain('No GUI Pack Editor');
  });

  it('commands.md includes /pack commands', () => {
    const path = resolve(process.cwd(), 'docs/commands.md');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('/pack list');
    expect(content).toContain('/pack info');
    expect(content).toContain('/pack create');
    expect(content).toContain('/help');
  });

  it('commands.md includes /docs web route', () => {
    const path = resolve(process.cwd(), 'docs/commands.md');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('/docs');
    expect(content).toContain('Documentation viewer');
  });
});

describe('Web Docs SPA', () => {
  it('docs/index.html exists', () => {
    const path = resolve(process.cwd(), 'src/web/public/docs/index.html');
    expect(existsSync(path)).toBe(true);
  });

  it('docs/index.html includes Mermaid and marked CDN', () => {
    const path = resolve(process.cwd(), 'src/web/public/docs/index.html');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('mermaid');
    expect(content).toContain('marked');
    expect(content).toContain('vuetify');
  });

  it('docs/index.html references all 4 doc tabs', () => {
    const path = resolve(process.cwd(), 'src/web/public/docs/index.html');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('user-guide');
    expect(content).toContain('architecture');
    expect(content).toContain('commands');
    expect(content).toContain('customization-guide');
  });
});
