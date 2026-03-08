import {
  createSkillIfNotExists,
  getActiveSkill,
  listSkills,
  type Skill,
} from './db.js';
import { logger } from './logger.js';

// ── Built-in Skill Definitions ──────────────────────────────

interface BuiltinSkillDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[] | null;
}

const BUILTIN_SKILLS: BuiltinSkillDef[] = [
  {
    id: 'builtin-general',
    name: 'general',
    description: 'Default assistant — no special persona, all tools available.',
    systemPrompt: '', // No additional prompt — uses provider default
    allowedTools: null, // null = all tools
  },
  {
    id: 'builtin-translator',
    name: 'translator',
    description: 'Translate between English and Spanish (or other specified languages).',
    systemPrompt:
      'You are a translator. Your ONLY job is to translate text. When the user sends ANY text, immediately translate it — if it is in English, translate to Spanish; if it is in Spanish, translate to English. If it is in another language, translate to English. Output ONLY the translation, nothing else. Never ask questions, never explain, never comment on the content. Just translate.',
    allowedTools: ['query_memory', 'save_memory', 'web_search'],
  },
  {
    id: 'builtin-analyst',
    name: 'analyst',
    description: 'Data analysis persona — reads files, generates reports and documents.',
    systemPrompt:
      'You are a data analyst. Analyze data the user provides, identify patterns and insights, and present findings clearly. Use tables, bullet points, and structured formats. When asked, generate spreadsheets or reports using the generate_document tool.',
    allowedTools: ['parse_file', 'read_file', 'query_memory', 'generate_document', 'web_search'],
  },
  {
    id: 'builtin-coder',
    name: 'coder',
    description: 'Programming expert — reads code, runs commands, explains technical topics.',
    systemPrompt:
      'You are an expert programmer. Help the user with code, debugging, architecture decisions, and technical questions. Use code blocks with syntax highlighting. When needed, read files and run commands to investigate issues.',
    allowedTools: ['read_file', 'run_command', 'web_search', 'summarize_url'],
  },
  {
    id: 'builtin-summarizer',
    name: 'summarizer',
    description: 'Concise summaries of documents, URLs, and conversations.',
    systemPrompt:
      'You are a summarization expert. Provide concise, well-structured summaries that capture key points. Use bullet points for clarity. For documents, highlight the main findings, conclusions, and action items. Keep summaries to 2-4 paragraphs unless the user specifies otherwise.',
    allowedTools: ['parse_file', 'read_file', 'summarize_url', 'web_search'],
  },
];

/**
 * Insert or replace all built-in skills in the database.
 * Call on startup after initDatabase().
 */
export function initBuiltinSkills(): void {
  for (const skill of BUILTIN_SKILLS) {
    createSkillIfNotExists(
      skill.id,
      skill.name,
      skill.description,
      skill.systemPrompt,
      skill.allowedTools,
      true, // isBuiltin
    );
  }

  const total = listSkills().length;
  logger.info({ count: total }, 'Skills initialized');
}

/**
 * Resolve the active skill for a chat.
 * Returns the active skill or null (meaning default/general behavior).
 */
export function resolveSkill(chatId: string): Skill | null {
  const skill = getActiveSkill(chatId);
  if (!skill) return null;
  // "general" skill means no special behavior
  if (skill.name === 'general') return null;
  return skill;
}

/**
 * Get the system prompt addition for the active skill.
 * Returns empty string if no skill is active or if it's the general skill.
 */
export function getSkillSystemPrompt(chatId: string): string {
  const skill = resolveSkill(chatId);
  return skill?.system_prompt || '';
}

/**
 * Get the list of allowed tool names for the active skill.
 * Returns null if all tools are allowed (no skill or general skill).
 */
export function getSkillAllowedTools(chatId: string): string[] | null {
  const skill = resolveSkill(chatId);
  if (!skill) return null;
  if (!skill.allowed_tools) return null;
  try {
    return JSON.parse(skill.allowed_tools) as string[];
  } catch {
    return null;
  }
}
