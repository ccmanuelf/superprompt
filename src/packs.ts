/**
 * Domain Pack System — Extensible capability modules for department-specific AI tools.
 *
 * Packs live in packs/<name>/ and contain:
 *   pack.yaml     — metadata, capabilities prompt, intent patterns
 *   tools/*.md    — tool definitions (reuses forge tool-parser format)
 *   skills/*.md   — skill definitions (reuses forge skill-parser format)
 *   templates/*   — example data files (CSV, XLSX)
 *
 * Loaded at startup after forge auto-import. Pack tools and skills are registered
 * via the same DB + registry infrastructure as forge.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { logger } from './logger.js';
import { PROJECT_ROOT } from './config.js';
import { parseToolMarkdown } from './forge/tool-parser.js';
import { parseSkillMarkdown } from './forge/skill-parser.js';
import { scanToolCode } from './forge/safety-scanner.js';
import {
  getSkillByName,
  createSkill,
  insertSkillRevision,
  getUserToolByName,
  createUserTool,
  insertToolRevision,
} from './db-core.js';

// ── Types ──────────────────────────────────────────────────

export interface IntentPattern {
  pattern: RegExp;
  scoreBoost: number;
  tools: string[];
  webApps: string[];
}

export interface PackCommand {
  name: string;
  description: string;
}

export interface PackMetadata {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  capabilities: string;
  selfDescription: string;
  intentPatterns: IntentPattern[];
  commands: PackCommand[];
  toolCount: number;
  skillCount: number;
  templateFiles: string[];
  path: string;
}

// ── Registry ───────────────────────────────────────────────

const PACKS_DIR = resolve(PROJECT_ROOT, 'packs');
const loadedPacks: PackMetadata[] = [];

export function getLoadedPacks(): PackMetadata[] {
  return loadedPacks;
}

export function getPackByName(name: string): PackMetadata | undefined {
  return loadedPacks.find((p) => p.name === name);
}

// ── Aggregation (for system prompt injection) ──────────────

export function getAggregatedCapabilities(): string {
  const parts = loadedPacks
    .filter((p) => p.enabled && p.capabilities)
    .map((p) => p.capabilities);
  return parts.length > 0 ? parts.join('\n\n') : '';
}

/**
 * Get all web UI URLs from loaded packs.
 * Used to dynamically update the AI's self-awareness about available dashboards.
 * Prevents the AI from trying to build solutions that already exist as web UIs.
 */
export function getAggregatedWebApps(): Array<{ packName: string; url: string }> {
  const webApps: Array<{ packName: string; url: string }> = [];
  const seen = new Set<string>();

  for (const pack of loadedPacks) {
    if (!pack.enabled) continue;
    for (const ip of pack.intentPatterns) {
      for (const url of ip.webApps) {
        if (!seen.has(url)) {
          seen.add(url);
          webApps.push({ packName: pack.name, url });
        }
      }
    }
  }

  return webApps;
}

/**
 * Build a dynamic web UI discovery prompt section.
 * Injected into the system prompt so the AI knows about ALL available dashboards,
 * including those added by newly loaded packs.
 */
export function buildWebAppsPrompt(): string {
  const apps = getAggregatedWebApps();
  if (apps.length === 0) return '';

  const lines = apps.map((a) => `- ${a.url} (from pack: ${a.packName})`);
  return `\n### Pack-Provided Web Dashboards (auto-discovered)\nThese web UIs are available from loaded packs. ALWAYS suggest them instead of building from scratch:\n${lines.join('\n')}\n`;
}

export function getAggregatedSelfDescription(): string {
  const parts = loadedPacks
    .filter((p) => p.enabled && p.selfDescription)
    .map((p) => p.selfDescription);
  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

export function getAggregatedCommands(): PackCommand[] {
  return loadedPacks
    .filter((p) => p.enabled)
    .flatMap((p) => p.commands);
}

// ── Pack Subscriptions (SA5) ──────────────────────────────

import type { TableInitializer } from './core/interfaces.js';
import { getKnex } from './db-knex.js';

export async function initPackSubscriptionTable(): Promise<void> {
  const db = getKnex();
  const exists = await db.schema.hasTable('pack_subscriptions');
  if (!exists) {
    await db.schema.createTable('pack_subscriptions', (t) => {
      t.text('chat_id').notNullable();
      t.text('pack_name').notNullable();
      t.integer('enabled').notNullable().defaultTo(1);
      t.integer('enabled_at').notNullable();
      t.primary(['chat_id', 'pack_name']);
    });
  }
}

export const packSubscriptionTableInit: TableInitializer = {
  name: 'pack-subscriptions',
  initTables: initPackSubscriptionTable,
};

/**
 * Check if a pack is enabled for a specific chat.
 * Default: all packs are enabled (backward compatible).
 * Only returns false if explicitly disabled.
 */
export async function isPackEnabled(chatId: string, packName: string): Promise<boolean> {
  try {
    const db = getKnex();
    const row = await db('pack_subscriptions')
      .where({ chat_id: chatId, pack_name: packName })
      .select('enabled')
      .first() as { enabled: number } | undefined;
    if (!row) return true; // Default: enabled
    return row.enabled === 1;
  } catch {
    return true; // DB not ready — default enabled
  }
}

/**
 * Enable a pack for a chat.
 */
export async function enablePack(chatId: string, packName: string): Promise<void> {
  const db = getKnex();
  await db('pack_subscriptions')
    .insert({
      chat_id: chatId,
      pack_name: packName,
      enabled: 1,
      enabled_at: Date.now(),
    })
    .onConflict(['chat_id', 'pack_name'])
    .merge({
      enabled: 1,
      enabled_at: Date.now(),
    });
}

/**
 * Disable a pack for a chat.
 */
export async function disablePack(chatId: string, packName: string): Promise<void> {
  const db = getKnex();
  await db('pack_subscriptions')
    .insert({
      chat_id: chatId,
      pack_name: packName,
      enabled: 0,
      enabled_at: Date.now(),
    })
    .onConflict(['chat_id', 'pack_name'])
    .merge({
      enabled: 0,
      enabled_at: Date.now(),
    });
}

/**
 * Get all pack subscription statuses for a chat.
 */
export async function getPackSubscriptions(chatId: string): Promise<Array<{ packName: string; enabled: boolean }>> {
  const allPacks = loadedPacks.map((p) => p.name);
  const results: Array<{ packName: string; enabled: boolean }> = [];
  for (const name of allPacks) {
    results.push({
      packName: name,
      enabled: await isPackEnabled(chatId, name),
    });
  }
  return results;
}

/**
 * Get enabled packs for a chat — used to filter tools and intent scoring.
 */
export async function getEnabledPackNames(chatId: string): Promise<string[]> {
  const enabledNames: string[] = [];
  for (const p of loadedPacks) {
    if (p.enabled && await isPackEnabled(chatId, p.name)) {
      enabledNames.push(p.name);
    }
  }
  return enabledNames;
}

// ── Intent Scoring ─────────────────────────────────────────

export async function scorePackIntent(message: string, chatId?: string): Promise<{
  score: number;
  tools: string[];
  webApps: string[];
}> {
  const lower = message.toLowerCase();
  let score = 0;
  const tools: string[] = [];
  const webApps: string[] = [];

  for (const pack of loadedPacks) {
    if (!pack.enabled) continue;

    let packScore = 0;
    for (const ip of pack.intentPatterns) {
      if (ip.pattern.test(lower)) {
        packScore += ip.scoreBoost;
        tools.push(...ip.tools);
        webApps.push(...ip.webApps);
      }
    }

    // Apply self-tuning weight (rc.28) — packs that succeed get boosted
    if (packScore > 0 && chatId) {
      packScore = await applyPackTuning(packScore, pack.name, chatId);
    }

    score += packScore;
  }

  return { score, tools: [...new Set(tools)], webApps: [...new Set(webApps)] };
}

/** Apply self-tuning weight from pack-tuner */
async function applyPackTuning(baseScore: number, packName: string, chatId: string): Promise<number> {
  try {
    const { applyTunedWeight } = packTunerModule;
    return await applyTunedWeight(baseScore, packName, chatId);
  } catch {
    return baseScore;
  }
}

// Lazy-loaded pack-tuner module reference
let packTunerModule: { applyTunedWeight: (b: number, p: string, c: string) => Promise<number> } = {
  applyTunedWeight: async (b) => b,
};

/** Set the pack tuner module reference (called from index.ts after initialization) */
export function setPackTunerModule(mod: { applyTunedWeight: (b: number, p: string, c: string) => Promise<number> }): void {
  packTunerModule = mod;
}

// ── YAML Parser (zero-dep, handles pack.yaml format) ───────

export interface RawPackYaml {
  name?: string;
  display_name?: string;
  description?: string;
  version?: string;
  author?: string;
  enabled?: string;
  capabilities?: string;
  self_description?: string;
  intent_patterns?: Array<{
    pattern?: string;
    score_boost?: string;
    tools?: string[];
    web_apps?: string[];
  }>;
  commands?: Array<{
    name?: string;
    description?: string;
  }>;
}

/** @internal Exported for testing */
export function parsePackYaml(content: string): RawPackYaml {
  const result: RawPackYaml = {};
  const lines = content.split('\n');
  let i = 0;

  // Skip YAML document markers
  while (i < lines.length && (lines[i].trim() === '---' || lines[i].trim() === '')) i++;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '---' || line.trim() === '...') break;

    // Top-level key detection (no leading whitespace)
    const keyMatch = line.match(/^(\w[\w_]*):\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2].trim();

    // Multiline block scalar (key: |)
    if (inlineValue === '|' || inlineValue === '|+' || inlineValue === '|-') {
      i++;
      const blockLines: string[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.length === 0) {
          blockLines.push('');
          i++;
          continue;
        }
        if (/^\S/.test(bl)) break; // un-indented = end of block
        // Remove common indent (minimum 2 spaces)
        blockLines.push(bl.replace(/^ {1,2}/, ''));
        i++;
      }
      // Trim trailing empty lines
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') blockLines.pop();
      (result as Record<string, unknown>)[key] = blockLines.join('\n');
      continue;
    }

    // Array section (intent_patterns: or commands:)
    if ((key === 'intent_patterns' || key === 'commands') && inlineValue === '') {
      i++;
      const items: Array<Record<string, unknown>> = [];
      while (i < lines.length && /^\s/.test(lines[i])) {
        const itemLine = lines[i].trim();
        // New array item
        if (itemLine.startsWith('- ')) {
          const item: Record<string, unknown> = {};
          // Parse first key on the same line as dash
          const firstKv = itemLine.slice(2).match(/^(\w[\w_]*):\s*(.*)/);
          if (firstKv) {
            item[firstKv[1]] = parseYamlValue(firstKv[2]);
          }
          i++;
          // Continuation keys (indented deeper than the dash)
          while (i < lines.length) {
            const contLine = lines[i];
            if (!contLine || /^\S/.test(contLine)) break;
            const contTrimmed = contLine.trim();
            if (contTrimmed.startsWith('- ')) break; // next array item
            const kvMatch = contTrimmed.match(/^(\w[\w_]*):\s*(.*)/);
            if (kvMatch) {
              item[kvMatch[1]] = parseYamlValue(kvMatch[2]);
            }
            i++;
          }
          items.push(item);
        } else {
          i++;
        }
      }
      (result as Record<string, unknown>)[key] = items;
      continue;
    }

    // Simple key: value
    (result as Record<string, unknown>)[key] = parseYamlValue(inlineValue);
    i++;
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  if (!raw) return '';
  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // Unquote and process YAML double-quote escape sequences
  const isDoubleQuoted = raw.startsWith('"') && raw.endsWith('"');
  const isSingleQuoted = raw.startsWith("'") && raw.endsWith("'");
  let unquoted = raw;
  if (isDoubleQuoted) {
    unquoted = raw.slice(1, -1);
    // YAML double-quoted strings: \\ → \, \n → newline, \t → tab, etc.
    unquoted = unquoted
      .replace(/\\\\/g, '\x00BSLASH\x00')  // protect \\
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\x00BSLASH\x00/g, '\\');    // restore \\ as single \
  } else if (isSingleQuoted) {
    unquoted = raw.slice(1, -1);
    // YAML single-quoted strings: '' → ' (only escape)
    unquoted = unquoted.replace(/''/g, "'");
  }
  // Boolean
  if (unquoted === 'true') return 'true';
  if (unquoted === 'false') return 'false';
  return unquoted;
}

// ── Pack Loading ───────────────────────────────────────────

export async function loadAllPacks(): Promise<PackMetadata[]> {
  loadedPacks.length = 0;

  if (!existsSync(PACKS_DIR)) {
    mkdirSync(PACKS_DIR, { recursive: true });
    return [];
  }

  const entries = readdirSync(PACKS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

    const packDir = resolve(PACKS_DIR, entry.name);
    const yamlPath = resolve(packDir, 'pack.yaml');

    if (!existsSync(yamlPath)) {
      logger.debug({ pack: entry.name }, 'Skipping pack directory (no pack.yaml)');
      continue;
    }

    try {
      const pack = await loadSinglePack(packDir, entry.name);
      if (pack) {
        loadedPacks.push(pack);
      }
    } catch (err) {
      logger.warn({ err, pack: entry.name }, 'Failed to load domain pack');
    }
  }

  return [...loadedPacks];
}

async function loadSinglePack(packDir: string, dirName: string): Promise<PackMetadata | null> {
  const yamlContent = readFileSync(resolve(packDir, 'pack.yaml'), 'utf-8');
  const raw = parsePackYaml(yamlContent);

  const name = (raw.name as string) || dirName;
  const enabled = raw.enabled !== 'false';

  if (!enabled) {
    logger.info({ pack: name }, 'Pack disabled, skipping');
    return null;
  }

  // Import tools
  const toolsDir = resolve(packDir, 'tools');
  let toolCount = 0;
  if (existsSync(toolsDir)) {
    toolCount = await importPackTools(toolsDir, name);
  }

  // Import skills
  const skillsDir = resolve(packDir, 'skills');
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = await importPackSkills(skillsDir, name);
  }

  // Discover templates
  const templatesDir = resolve(packDir, 'templates');
  const templateFiles: string[] = [];
  if (existsSync(templatesDir)) {
    const tFiles = readdirSync(templatesDir).filter((f) => !f.startsWith('.'));
    templateFiles.push(...tFiles);
  }

  // Parse intent patterns
  const intentPatterns: IntentPattern[] = [];
  if (Array.isArray(raw.intent_patterns)) {
    for (const ip of raw.intent_patterns) {
      if (!ip.pattern) continue;
      try {
        intentPatterns.push({
          pattern: new RegExp(ip.pattern as string, 'i'),
          scoreBoost: Number(ip.score_boost) || 10,
          tools: Array.isArray(ip.tools) ? ip.tools as string[] : [],
          webApps: Array.isArray(ip.web_apps) ? ip.web_apps as string[] : [],
        });
      } catch (err) {
        logger.warn({ pack: name, pattern: ip.pattern }, 'Invalid intent pattern regex');
      }
    }
  }

  // Parse commands
  const commands: PackCommand[] = [];
  if (Array.isArray(raw.commands)) {
    for (const cmd of raw.commands) {
      if (cmd.name && cmd.description) {
        commands.push({
          name: cmd.name as string,
          description: cmd.description as string,
        });
      }
    }
  }

  // Level 3: If pack has src/ directory, import compiled TypeScript module
  const srcDir = resolve(packDir, 'src');
  let level: 1 | 2 | 3 = toolCount > 0 || skillCount > 0 ? 2 : 1;

  if (existsSync(resolve(srcDir, 'index.ts')) || existsSync(resolve(srcDir, 'index.js'))) {
    level = 3;
    // Level 3 source will be loaded asynchronously via loadLevel3Pack()
    // The compiled output is at dist/packs/<name>/src/index.js (after tsc)
    // OR the source imports are resolved by the pack loader at startup
    logger.info({ pack: name }, 'Level 3 pack detected (has src/)');
  }

  const metadata: PackMetadata = {
    name,
    displayName: (raw.display_name as string) || name,
    description: (raw.description as string) || '',
    version: (raw.version as string) || '0.1.0',
    author: (raw.author as string) || '',
    enabled,
    capabilities: (raw.capabilities as string) || '',
    selfDescription: (raw.self_description as string) || '',
    intentPatterns,
    commands,
    toolCount,
    skillCount,
    templateFiles,
    path: packDir,
  };

  logger.info(
    { pack: name, level, tools: toolCount, skills: skillCount, templates: templateFiles.length },
    'Loaded domain pack',
  );

  // rc.100 Phase 5 — pack-scoped assumption defaults via assumptions.yaml.
  // Idempotent: re-running upserts via setAssumption (change-log appended,
  // no duplicate rows). Silently skipped when the file is absent.
  try {
    const { loadPackAssumptions } = await import('./assumptions.js');
    await loadPackAssumptions(packDir, name);
  } catch (err) {
    logger.warn({ err, pack: name }, 'Failed to load pack assumptions');
  }

  return metadata;
}

/**
 * Load a Level 3 pack's compiled TypeScript source.
 * Called after the pack system initializes, during the Application setup phase.
 *
 * The pack's src/index.ts (compiled to dist/) should export:
 * - tableInit: TableInitializer (for DB schema)
 * - registerTools?: () => void (for tool registration)
 * - getApiHandler?: () => (req, res, path) => Promise<void> (for API routes)
 *
 * @param packName Name of the pack
 * @param packDir Absolute path to the pack directory
 */
export async function loadLevel3Pack(
  packName: string,
  packDir: string,
): Promise<{ tableInit?: TableInitializer; registerTools?: () => void }> {
  // In development: source is at packs/<name>/src/index.ts
  // In production (after tsc): compiled output at dist/packs/<name>/src/index.js
  // We try the compiled path first, then fall back to source via dynamic import

  const compiledPath = resolve(packDir, '..', '..', 'dist', 'packs', packName, 'src', 'index.js');
  const sourcePath = resolve(packDir, 'src', 'index.ts');

  let mod: Record<string, unknown>;

  try {
    if (existsSync(compiledPath)) {
      mod = await import(compiledPath);
    } else if (existsSync(sourcePath)) {
      // Development mode — TypeScript may be transpiled on-the-fly
      mod = await import(sourcePath);
    } else {
      logger.warn({ pack: packName }, 'Level 3 pack has src/ but no index.ts/index.js found');
      return {};
    }
  } catch (err) {
    logger.warn({ err, pack: packName }, 'Failed to load Level 3 pack source');
    return {};
  }

  const result: { tableInit?: TableInitializer; registerTools?: () => void } = {};

  if (mod.tableInit && typeof (mod.tableInit as TableInitializer).initTables === 'function') {
    result.tableInit = mod.tableInit as TableInitializer;
    logger.debug({ pack: packName }, 'Level 3 pack provides TableInitializer');
  }

  if (typeof mod.registerTools === 'function') {
    result.registerTools = mod.registerTools as () => void;
    logger.debug({ pack: packName }, 'Level 3 pack provides registerTools');
  }

  return result;
}

// ── Tool/Skill Import (mirrors forge/auto-import.ts) ───────

async function importPackTools(toolsDir: string, packName: string): Promise<number> {
  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.md'));
  let imported = 0;

  for (const file of files) {
    try {
      const content = readFileSync(resolve(toolsDir, file), 'utf-8');
      const parsed = parseToolMarkdown(content);

      if ('error' in parsed) {
        logger.warn({ file, pack: packName, error: parsed.error }, 'Skipping invalid pack tool');
        continue;
      }

      const existing = await getUserToolByName(parsed.name);
      if (existing) {
        logger.debug({ tool: parsed.name, pack: packName }, 'Tool already exists, skipping');
        continue;
      }

      if (parsed.type === 'generated_code' && parsed.code) {
        const scan = scanToolCode(parsed.code);
        if (!scan.safe) {
          logger.warn({ tool: parsed.name, pack: packName, issues: scan.issues }, 'Skipping unsafe pack tool');
          continue;
        }
      }

      const id = `pack-${packName}-${parsed.name}`;
      const config = JSON.stringify({
        parameters: parsed.parameters,
        endpoint: parsed.endpoint,
        code: parsed.code,
      });

      await createUserTool(id, parsed.name, parsed.description, parsed.type, config, `packs/${packName}/tools/${file}`);
      await insertToolRevision(id, config, `Auto-imported from pack: ${packName}`);
      imported++;
      logger.info({ tool: parsed.name, pack: packName }, 'Imported pack tool');
    } catch (err) {
      logger.warn({ err, file, pack: packName }, 'Failed to import pack tool');
    }
  }

  return imported;
}

async function importPackSkills(skillsDir: string, packName: string): Promise<number> {
  const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  let imported = 0;

  for (const file of files) {
    try {
      const content = readFileSync(resolve(skillsDir, file), 'utf-8');
      const parsed = parseSkillMarkdown(content);

      if ('error' in parsed) {
        logger.warn({ file, pack: packName, error: parsed.error }, 'Skipping invalid pack skill');
        continue;
      }

      const existing = await getSkillByName(parsed.name);
      if (existing) {
        logger.debug({ skill: parsed.name, pack: packName }, 'Skill already exists, skipping');
        continue;
      }

      const id = `pack-${packName}-${parsed.name}`;
      await createSkill(id, parsed.name, parsed.description, parsed.systemPrompt, parsed.tools, false, `packs/${packName}/skills/${file}`);
      await insertSkillRevision(id, parsed.systemPrompt, `Auto-imported from pack: ${packName}`);

      // Register trigger patterns if the skill defines them in frontmatter
      const triggerMatch = content.match(/trigger:\s*\n\s*patterns:\s*\n([\s\S]*?)\n\s*mode:\s*(\w+)/);
      if (triggerMatch) {
        const patternLines = triggerMatch[1].split('\n').map(l => l.trim().replace(/^-\s*["']?|["']?$/g, '')).filter(Boolean);
        const mode = triggerMatch[2] || 'suggest';
        try {
          const db = (await import('./db-knex.js')).getKnex();
          for (const pattern of patternLines) {
            const exists = await db('skill_triggers').where({ skill_id: id, pattern }).first();
            if (!exists) {
              await db('skill_triggers').insert({ skill_id: id, pattern, mode, created_at: Date.now() });
            }
          }
          logger.info({ skill: parsed.name, triggers: patternLines.length }, 'Registered pack skill triggers');
        } catch {
          // skill_triggers table may not exist yet
        }
      }

      imported++;
      logger.info({ skill: parsed.name, pack: packName }, 'Imported pack skill');
    } catch (err) {
      logger.warn({ err, file, pack: packName }, 'Failed to import pack skill');
    }
  }

  return imported;
}

// ── Pack Scaffold ──────────────────────────────────────────

export function scaffoldPack(name: string, description: string): string {
  const packDir = resolve(PACKS_DIR, name);

  if (existsSync(packDir)) {
    throw new Error(`Pack directory already exists: packs/${name}/`);
  }

  mkdirSync(resolve(packDir, 'tools'), { recursive: true });
  mkdirSync(resolve(packDir, 'skills'), { recursive: true });
  mkdirSync(resolve(packDir, 'templates'), { recursive: true });

  const yamlContent = `# Domain Pack: ${name}
# Documentation: docs/customization-guide.md

name: ${name}
display_name: "${name.charAt(0).toUpperCase() + name.slice(1)}"
description: "${description}"
version: "0.1.0"
author: ""
enabled: true

# Capabilities prompt — injected into the AI's system prompt.
# Describe what your tools do so the AI knows when to use them.
capabilities: |
  ### ${name.charAt(0).toUpperCase() + name.slice(1)}
  You have domain-specific tools for ${description.toLowerCase()}:
  - (Add your tool descriptions here after creating tools in tools/*.md)

# Self-description — shown when user asks "what can you do?"
self_description: |
  **${name.charAt(0).toUpperCase() + name.slice(1)}** — Domain tools:
  - (Add your tool summaries here)

# Intent patterns — when should the AI suggest your tools?
# Each pattern is a regex tested against the user's message (case-insensitive).
# score_boost: how much to boost the intent score (10 = moderate, 20 = strong)
# tools: which pack tools to suggest
# web_apps: which web dashboard URLs to suggest (if any)
intent_patterns:
  - pattern: "\\\\b(${name}|example keyword)\\\\b"
    score_boost: 10
    tools: []
    web_apps: []

# Commands — listed in /help output
commands: []
`;

  writeFileSync(resolve(packDir, 'pack.yaml'), yamlContent);

  // Starter tool template
  const toolTemplate = `---
name: example_${name}_tool
description: Example tool for ${name} — replace with your own
type: generated_code
parameters:
  - name: input
    type: string
    description: Input value
    required: true
---
\`\`\`javascript
// Your tool code here. Available variables:
//   args.input — the input parameter value
//   fetch() — HTTP client for external APIs
// Return a JSON object with your results.
return { result: args.input, message: "Replace this with your logic" };
\`\`\`
`;

  writeFileSync(resolve(packDir, 'tools', `example-${name}-tool.md`), toolTemplate);

  // Starter skill template
  const skillTemplate = `---
name: ${name}_advisor
description: Domain expert for ${name}
---
You are a ${name} domain expert. When users ask about ${description.toLowerCase()}, provide accurate, practical guidance.

Key behaviors:
- Use domain-specific terminology correctly
- Reference available tools when they can help
- Ask clarifying questions before making assumptions
- Provide actionable recommendations, not just explanations
`;

  writeFileSync(resolve(packDir, 'skills', `${name}-advisor.md`), skillTemplate);

  // README
  const readme = `# ${name.charAt(0).toUpperCase() + name.slice(1)} Domain Pack

${description}

## Tools
- \`example_${name}_tool\` — Example tool (replace with your own)

## Skills
- \`${name}_advisor\` — Domain expert persona

## Templates
(Add example data files here: CSV, XLSX)

## Getting Started
1. Edit \`pack.yaml\` to describe your capabilities and intent patterns
2. Replace the example tool with your own tools in \`tools/\`
3. Customize the skill in \`skills/\`
4. Restart Luna or use \`/reload\`
5. Test with \`/pack info ${name}\`

See \`docs/customization-guide.md\` for the full guide.
`;

  writeFileSync(resolve(packDir, 'README.md'), readme);

  return packDir;
}

// ── Provider Factory ────────────────────────────────────────

import type { PackProvider } from './core/interfaces.js';

/**
 * Create a PackProvider backed by the existing pack subsystem.
 * Wraps loadAllPacks, getPackByName, getAggregatedCapabilities,
 * and scorePackIntent behind the PackProvider interface.
 */
export function createPackProvider(): PackProvider {
  return {
    loadAll: loadAllPacks,
    getByName: getPackByName,
    getAggregatedCapabilities,
    scoreIntent: scorePackIntent,
  };
}
