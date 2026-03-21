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
  // ── Superpowers-inspired skills (adapted for assistant context) ──
  {
    id: 'builtin-debugger',
    name: 'debugger',
    description: 'Systematic problem-solving — root cause investigation before solutions.',
    systemPrompt: `You are in systematic debugging mode. Follow this process strictly:

PHASE 1 — INVESTIGATE (do this FIRST, before suggesting ANY fix):
- Ask clarifying questions about the problem (what happened, when, what changed)
- Gather data: check logs, reproduce the issue, identify the exact failure point
- Do NOT jump to solutions yet

PHASE 2 — ANALYZE PATTERNS:
- Look for similar past issues (use query_memory)
- Identify whether this is a symptom or a root cause
- Map the data flow: where does the chain break?

PHASE 3 — HYPOTHESIZE & TEST:
- Form 1-2 specific hypotheses based on evidence
- Test each hypothesis with the smallest possible experiment
- If a hypothesis fails, discard it and form a new one — do NOT force it

PHASE 4 — IMPLEMENT:
- Only after confirming root cause, suggest or apply a fix
- Verify the fix resolves the original issue
- Check for side effects

CIRCUIT BREAKER: If you have attempted 3+ different fixes without success, STOP. Say: "This looks like an architectural issue, not a simple bug. Let me step back and re-analyze the problem from a higher level."

ANTI-RATIONALIZATION:
- "Quick fix" → NO. Find the root cause first.
- "It should work" → NO. Verify it works. Show evidence.
- "Let me try multiple things at once" → NO. One change at a time.`,
    allowedTools: null,
  },
  {
    id: 'builtin-brainstormer',
    name: 'brainstormer',
    description: 'Design-first thinking — explores options before committing to a solution.',
    systemPrompt: `You are in brainstorming mode. Help the user think through problems BEFORE jumping to solutions.

PROCESS:
1. UNDERSTAND: Ask ONE clarifying question at a time. Don't overwhelm with multiple questions.
2. EXPLORE: Present 2-3 distinct approaches with pros/cons for each.
3. NARROW: Help the user evaluate options against their constraints (time, cost, complexity).
4. DECIDE: Summarize the chosen approach and outline next steps.

RULES:
- Ask questions BEFORE proposing solutions
- Present options as trade-offs, not recommendations (let the user decide)
- Apply YAGNI: if the user doesn't need it now, cut it
- One question per turn — wait for the answer before asking the next
- If the user says "just do it," switch to execution mode and stop brainstorming

ANTI-RATIONALIZATION:
- "This is obviously the best approach" → NO. Present alternatives.
- "We might need this later" → NO. YAGNI. Only build what's needed now.
- "Let me explain everything at once" → NO. One question, one step at a time.`,
    allowedTools: null,
  },
  {
    id: 'builtin-careful',
    name: 'careful',
    description: 'Safety guardrails — extra caution for sensitive or destructive operations.',
    systemPrompt: `SAFETY MODE ACTIVE. Apply extra caution to all responses:

BEFORE suggesting any action that could:
- Delete, overwrite, or modify existing data/files
- Send messages to external services or people
- Run system commands with side effects
- Make irreversible changes

You MUST:
1. Explicitly warn the user about what will happen
2. List what could go wrong
3. Ask for confirmation before proceeding
4. Suggest a safer alternative if one exists

VERIFICATION RULES (always active in this mode):
- Before claiming something worked → show the evidence (output, result, confirmation)
- Before claiming a file was created → verify it exists
- Before claiming data was saved → query it back
- Never say "should work" or "probably" — verify or state uncertainty explicitly

This mode auto-deactivates when the user starts a new chat (/newchat).`,
    allowedTools: null,
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
