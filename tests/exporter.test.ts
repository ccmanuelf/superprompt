import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = resolve(tmpdir(), 'clauded-test-exporter');

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: resolve(tmpdir(), 'clauded-test-exporter'),
}));

import { exportSkillToMarkdown, exportToolToMarkdown } from '../src/forge/exporter.js';
import type { Skill, UserTool } from '../src/db-core.js';

describe('exportSkillToMarkdown', () => {
  afterEach(() => {
    try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('exports a skill with tools to markdown', () => {
    const skill: Skill = {
      id: 'custom-pirate',
      name: 'pirate',
      description: 'Speaks like a pirate',
      system_prompt: 'You are a pirate. Say arrr.',
      allowed_tools: JSON.stringify(['query_memory', 'web_search']),
      is_builtin: 0,
      source_file: 'pirate.md',
      locked: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const filepath = exportSkillToMarkdown(skill);

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('name: pirate');
    expect(content).toContain('description: Speaks like a pirate');
    expect(content).toContain('tools: [query_memory, web_search]');
    expect(content).toContain('You are a pirate. Say arrr.');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('\n---\n');
  });

  it('exports a skill without tools', () => {
    const skill: Skill = {
      id: 'custom-simple',
      name: 'simple',
      description: 'A simple skill',
      system_prompt: 'Be helpful.',
      allowed_tools: null,
      is_builtin: 0,
      source_file: null,
      locked: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const filepath = exportSkillToMarkdown(skill);
    const content = readFileSync(filepath, 'utf-8');

    expect(content).not.toContain('tools:');
    expect(content).toContain('Be helpful.');
  });
});

describe('exportToolToMarkdown', () => {
  afterEach(() => {
    try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('exports a declarative_http tool to markdown', () => {
    const tool: UserTool = {
      id: 'user-weather',
      name: 'weather',
      description: 'Get weather data',
      tool_type: 'declarative_http',
      config: JSON.stringify({
        parameters: [
          { name: 'city', type: 'string', description: 'City name', required: true },
        ],
        endpoint: {
          method: 'GET',
          url: 'https://api.weather.com/v1',
          query: { q: '${city}', key: '${WEATHER_API_KEY}' },
          response_path: 'current.text',
        },
      }),
      enabled: 1,
      locked: 0,
      source_file: 'weather.md',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const filepath = exportToolToMarkdown(tool);

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('name: weather');
    expect(content).toContain('type: declarative_http');
    expect(content).toContain('method: GET');
    expect(content).toContain('url: "https://api.weather.com/v1"');
    expect(content).toContain('q: "${city}"');
    expect(content).toContain('key: "${WEATHER_API_KEY}"');
    expect(content).toContain('response_path: "current.text"');
    expect(content).toContain('- name: city');
    expect(content).toContain('required: true');
  });

  it('exports a generated_code tool with code body', () => {
    const tool: UserTool = {
      id: 'user-formatter',
      name: 'formatter',
      description: 'Format JSON',
      tool_type: 'generated_code',
      config: JSON.stringify({
        parameters: [
          { name: 'data', type: 'string', description: 'JSON string', required: true },
        ],
        code: 'const parsed = JSON.parse(args.data);\nreturn { formatted: JSON.stringify(parsed, null, 2) };',
      }),
      enabled: 1,
      locked: 0,
      source_file: 'formatter.md',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const filepath = exportToolToMarkdown(tool);
    const content = readFileSync(filepath, 'utf-8');

    expect(content).toContain('type: generated_code');
    expect(content).toContain('```typescript');
    expect(content).toContain('JSON.parse(args.data)');
    expect(content).toContain('```');
  });

  it('round-trips: export then re-parse produces same data', async () => {
    const { parseToolMarkdown } = await import('../src/forge/tool-parser.js');

    const tool: UserTool = {
      id: 'user-joke',
      name: 'joke',
      description: 'Get a joke',
      tool_type: 'declarative_http',
      config: JSON.stringify({
        parameters: [
          { name: 'category', type: 'string', description: 'Joke category', required: false },
        ],
        endpoint: {
          method: 'GET',
          url: 'https://api.example.com/jokes',
          query: { category: '${category}' },
          response_path: 'joke.text',
        },
      }),
      enabled: 1,
      locked: 0,
      source_file: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const filepath = exportToolToMarkdown(tool);
    const content = readFileSync(filepath, 'utf-8');
    const parsed = parseToolMarkdown(content);

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    expect(parsed.name).toBe('joke');
    expect(parsed.description).toBe('Get a joke');
    expect(parsed.type).toBe('declarative_http');
    expect(parsed.parameters).toHaveLength(1);
    expect(parsed.parameters[0].name).toBe('category');
    expect(parsed.endpoint?.method).toBe('GET');
    expect(parsed.endpoint?.url).toBe('https://api.example.com/jokes');
    expect(parsed.endpoint?.response_path).toBe('joke.text');
  });
});
