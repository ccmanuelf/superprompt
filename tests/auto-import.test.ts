import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Mock DB functions before importing
vi.mock('../src/db-core.js', () => ({
  getSkillByName: vi.fn(),
  createSkill: vi.fn(),
  insertSkillRevision: vi.fn(),
  getUserToolByName: vi.fn(),
  createUserTool: vi.fn(),
  insertToolRevision: vi.fn(),
}));

// Mock config to point to temp directory
const TMP_DIR = resolve(tmpdir(), 'clauded-test-auto-import');
vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: resolve(tmpdir(), 'clauded-test-auto-import'),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { autoImportForge } from '../src/forge/auto-import.js';
import { getSkillByName, createSkill, getUserToolByName, createUserTool } from '../src/db-core.js';

describe('autoImportForge', () => {
  beforeEach(() => {
    mkdirSync(resolve(TMP_DIR, 'forge/skills'), { recursive: true });
    mkdirSync(resolve(TMP_DIR, 'forge/tools'), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('imports skill markdown files that do not exist in DB', async () => {
    const skillMd = `---
name: pirate
description: Speaks like a pirate
---
You are a pirate. Say arrr.`;

    writeFileSync(resolve(TMP_DIR, 'forge/skills/pirate.md'), skillMd);
    vi.mocked(getSkillByName).mockResolvedValue(undefined);

    const result = await autoImportForge();

    expect(result.skills).toBe(1);
    expect(createSkill).toHaveBeenCalledWith(
      'custom-pirate',
      'pirate',
      'Speaks like a pirate',
      'You are a pirate. Say arrr.',
      null,
      false,
      'pirate.md',
    );
  });

  it('skips skills that already exist in DB', async () => {
    const skillMd = `---
name: existing
description: Already exists
---
Some prompt.`;

    writeFileSync(resolve(TMP_DIR, 'forge/skills/existing.md'), skillMd);
    vi.mocked(getSkillByName).mockResolvedValue({ id: 'custom-existing' } as any);

    const result = await autoImportForge();

    expect(result.skills).toBe(0);
    expect(createSkill).not.toHaveBeenCalled();
  });

  it('imports tool markdown files that do not exist in DB', async () => {
    const toolMd = `---
name: weather
description: Get weather
type: declarative_http
parameters:
  - name: city
    type: string
    description: City name
    required: true
endpoint:
  method: GET
  url: "https://api.example.com/weather"
  query:
    q: "\${city}"
---`;

    writeFileSync(resolve(TMP_DIR, 'forge/tools/weather.md'), toolMd);
    vi.mocked(getUserToolByName).mockResolvedValue(undefined);

    const result = await autoImportForge();

    expect(result.tools).toBe(1);
    expect(createUserTool).toHaveBeenCalledWith(
      'user-weather',
      'weather',
      'Get weather',
      'declarative_http',
      expect.any(String), // JSON config
      'weather.md',
    );

    // Verify the config contains the endpoint
    const configArg = vi.mocked(createUserTool).mock.calls[0][4];
    const config = JSON.parse(configArg);
    expect(config.endpoint.method).toBe('GET');
    expect(config.endpoint.url).toBe('https://api.example.com/weather');
    expect(config.parameters).toHaveLength(1);
    expect(config.parameters[0].name).toBe('city');
  });

  it('skips tools that already exist in DB', async () => {
    const toolMd = `---
name: existing
description: Already exists
type: declarative_http
endpoint:
  method: GET
  url: "https://example.com"
---`;

    writeFileSync(resolve(TMP_DIR, 'forge/tools/existing.md'), toolMd);
    vi.mocked(getUserToolByName).mockResolvedValue({ id: 'user-existing' } as any);

    const result = await autoImportForge();

    expect(result.tools).toBe(0);
    expect(createUserTool).not.toHaveBeenCalled();
  });

  it('skips invalid markdown files with warnings', async () => {
    writeFileSync(resolve(TMP_DIR, 'forge/skills/bad.md'), 'No frontmatter here');

    const result = await autoImportForge();

    expect(result.skills).toBe(0);
  });

  it('rejects unsafe generated_code tools', async () => {
    const toolMd = `---
name: evil
description: Dangerous tool
type: generated_code
parameters:
  - name: input
    type: string
    description: Input
    required: true
---
\`\`\`typescript
process.exit(1);
return { result: "bye" };
\`\`\``;

    writeFileSync(resolve(TMP_DIR, 'forge/tools/evil.md'), toolMd);
    vi.mocked(getUserToolByName).mockResolvedValue(undefined);

    const result = await autoImportForge();

    expect(result.tools).toBe(0);
    expect(createUserTool).not.toHaveBeenCalled();
  });

  it('returns zeros when forge directories do not exist', async () => {
    rmSync(TMP_DIR, { recursive: true });

    const result = await autoImportForge();

    expect(result.skills).toBe(0);
    expect(result.tools).toBe(0);
  });
});
