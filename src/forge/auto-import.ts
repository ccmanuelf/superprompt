import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { logger } from '../logger.js';
import { PROJECT_ROOT } from '../config.js';
import { parseSkillMarkdown } from './skill-parser.js';
import { parseToolMarkdown } from './tool-parser.js';
import {
  getSkillByName,
  createSkill,
  insertSkillRevision,
  getUserToolByName,
  createUserTool,
  insertToolRevision,
} from '../db.js';
import { scanToolCode } from './safety-scanner.js';

const FORGE_DIR = resolve(PROJECT_ROOT, 'forge');
const SKILLS_DIR = resolve(FORGE_DIR, 'skills');
const TOOLS_DIR = resolve(FORGE_DIR, 'tools');

/**
 * Import skills and tools from forge/ directory.
 * Uses INSERT OR IGNORE semantics — existing DB entries are not overwritten.
 * Call after initDatabase() and initBuiltinSkills().
 */
export function autoImportForge(): { skills: number; tools: number } {
  let skills = 0;
  let tools = 0;

  skills = importSkills();
  tools = importTools();

  if (skills > 0 || tools > 0) {
    logger.info({ skills, tools }, 'Auto-imported from forge/ directory');
  }

  return { skills, tools };
}

function importSkills(): number {
  if (!existsSync(SKILLS_DIR)) return 0;

  const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));
  let imported = 0;

  for (const file of files) {
    try {
      const content = readFileSync(resolve(SKILLS_DIR, file), 'utf-8');
      const parsed = parseSkillMarkdown(content);

      if ('error' in parsed) {
        logger.warn({ file, error: parsed.error }, 'Skipping invalid skill file');
        continue;
      }

      // Skip if already exists in DB
      const existing = getSkillByName(parsed.name);
      if (existing) {
        logger.debug({ skill: parsed.name }, 'Skill already exists, skipping import');
        continue;
      }

      const id = `custom-${parsed.name}`;
      createSkill(
        id,
        parsed.name,
        parsed.description,
        parsed.systemPrompt,
        parsed.tools,
        false, // not builtin
        file,
      );

      insertSkillRevision(id, parsed.systemPrompt, 'Auto-imported from forge/skills/');
      imported++;
      logger.info({ skill: parsed.name, file }, 'Imported skill from forge/');
    } catch (err) {
      logger.warn({ err, file }, 'Failed to import skill file');
    }
  }

  return imported;
}

function importTools(): number {
  if (!existsSync(TOOLS_DIR)) return 0;

  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.md'));
  let imported = 0;

  for (const file of files) {
    try {
      const content = readFileSync(resolve(TOOLS_DIR, file), 'utf-8');
      const parsed = parseToolMarkdown(content);

      if ('error' in parsed) {
        logger.warn({ file, error: parsed.error }, 'Skipping invalid tool file');
        continue;
      }

      // Skip if already exists in DB
      const existing = getUserToolByName(parsed.name);
      if (existing) {
        logger.debug({ tool: parsed.name }, 'Tool already exists, skipping import');
        continue;
      }

      // Safety scan for generated_code
      if (parsed.type === 'generated_code' && parsed.code) {
        const scan = scanToolCode(parsed.code);
        if (!scan.safe) {
          logger.warn(
            { tool: parsed.name, issues: scan.issues },
            'Skipping unsafe tool file',
          );
          continue;
        }
      }

      const id = `user-${parsed.name}`;
      const config = JSON.stringify({
        parameters: parsed.parameters,
        endpoint: parsed.endpoint,
        code: parsed.code,
      });

      createUserTool(
        id,
        parsed.name,
        parsed.description,
        parsed.type,
        config,
        file,
      );

      insertToolRevision(id, config, 'Auto-imported from forge/tools/');
      imported++;
      logger.info({ tool: parsed.name, file }, 'Imported tool from forge/');
    } catch (err) {
      logger.warn({ err, file }, 'Failed to import tool file');
    }
  }

  return imported;
}
