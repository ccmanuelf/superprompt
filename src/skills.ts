import {
  createSkillIfNotExists,
  getActiveSkill,
  getSkillByName,
  setActiveSkill,
  setActiveSkillAutoTriggered,
  isSkillAutoTriggered,
  decrementSkillTurns,
  clearActiveSkill,
  listSkills,
  getDatabase,
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

// ── Auto-Trigger Definitions ────────────────────────────────

export type TriggerMode = 'auto' | 'suggest';

export interface SkillTrigger {
  /** Skill name to activate */
  skillName: string;
  /** Regex patterns that indicate this skill should activate */
  patterns: RegExp[];
  /** 'auto' = activate silently, 'suggest' = inform user and let them decide */
  mode: TriggerMode;
}

/**
 * Auto-trigger definitions for built-in skills.
 * Patterns are tested against the user's message.
 * Only triggers when NO skill is manually active.
 *
 * Exported for testing.
 */
export const SKILL_TRIGGERS: SkillTrigger[] = [
  {
    skillName: 'debugger',
    mode: 'auto',
    patterns: [
      // Explicit debugging language
      /\b(debug|debugging|troubleshoot|troubleshooting)\b/i,
      // Error descriptions — matches both "error when X" and "every time X errors"
      /\b(error|bug|crash(es|ed|ing)?|broken|not working|fails?|failing|exception|stack\s*trace)\b.*\b(when|after|every\s*time|keeps?|always)\b/i,
      /\b(when|after|every\s*time|keeps?|always)\b.*\b(error|bug|crash(es|ed|ing)?|broken|not working|fails?|failing|exception)\b/i,
      // "Why does X not work" / "X stopped working"
      /\bwhy\s+(does|is|did|doesn't|won't|can't)\b.*\b(work|function|respond|connect|load|run|start)\b/i,
      /\b(stopped|quit|ceased)\s+working\b/i,
      // "Fix" requests with technical context
      /\bfix\b.*\b(error|bug|issue|problem|code|script|config|server|database|api)\b/i,
    ],
  },
  {
    skillName: 'careful',
    mode: 'auto',
    patterns: [
      // Destructive operations (handles verb forms: delete/deleting, drop/dropping, etc.)
      /\b(delet|remov|dropp?|wip|eras|purg|destroy|reset)(e|ed|ing|s)?\s+(all|every|the\s+entire|my|the)\b/i,
      // System-level danger
      /\b(format|reformat)(ting|s)?\s+(disk|drive|partition|volume)\b/i,
      /\brm\s+-rf\b/i,
      /\bdropp?(ing)?\s+(table|database|collection|index)\b/i,
    ],
  },
  {
    skillName: 'brainstormer',
    mode: 'suggest',
    patterns: [
      // Exploratory thinking
      /\b(brainstorm|think through|explore options|weigh|pros and cons|trade-?offs?)\b/i,
      // Planning requests
      /\b(how should (i|we)|what's the best (way|approach)|which option|help me decide|i'm (torn|unsure|undecided))\b/i,
    ],
  },
  {
    skillName: 'analyst',
    mode: 'suggest',
    patterns: [
      // Data analysis requests
      /\b(analyze|analyse)\s+(this|the|my)\s+(data|numbers|metrics|results|spreadsheet|csv|report)\b/i,
      /\b(trend|pattern|correlation|outlier|distribution)\s+(analysis|in|of|from)\b/i,
    ],
  },
  {
    skillName: 'coder',
    mode: 'suggest',
    patterns: [
      // Code assistance with specific language/framework mentions
      /\b(write|create|build)\s+(a|an|the)\s+(function|class|component|script|api|endpoint|module)\b/i,
      /\b(refactor|optimize|improve)\s+(this|the|my)\s+(code|function|class|component)\b/i,
    ],
  },
  {
    skillName: 'learning-coach',
    mode: 'suggest',
    patterns: [
      // Learning/study requests
      /\b(quiz me|test me|study session)\b.*\b(on|about|for)\b/i,
      /\b(teach me|help me learn|learn about|study)\s+\w+/i,
    ],
  },
];

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
  {
    id: 'builtin-learning-coach',
    name: 'learning-coach',
    description: 'Structured learning sessions with spaced repetition, personas, and progress tracking.',
    systemPrompt: `You are a Learning Coach conducting a structured micro-session. Your role is the Master — the curriculum authority. The student is your Padawan.

SESSION RULES:
- Stay focused on the current topic — do not wander to unrelated subjects.
- Use the Socratic method: ask questions before giving answers.
- After teaching a concept, verify understanding with 1-2 questions.
- Keep responses concise (3-5 sentences for teaching, 1-2 for questions).
- When the student demonstrates mastery of the current topic, signal completion.
- If the student wants to stop, respect it immediately but encourage continuation.
- Encourage completion and discipline. Do not make it easy to abandon learning.

ASSESSMENT MARKERS (include in your response so the system can track progress):
- After a correct answer: [CORRECT]
- After an incorrect answer: [INCORRECT]
- When topic is mastered: [TOPIC_COMPLETE]
- When starting an assessment: [QUIZ_START]
- After assessment passes (80%+): [ASSESSMENT_PASSED]
- After assessment fails: [ASSESSMENT_FAILED]

CURRICULUM AUTHORITY:
- You decide what is pedagogically sound. The student may suggest changes but you have final say.
- For topic removal requests, ALWAYS require an assessment first.
- Encourage completion — never make it easy to abandon a learning path.
- If the student wants to quit, explore why (boredom? difficulty? time?) and offer alternatives.

The session context (topic, progress, persona) will be provided in the system prompt.`,
    allowedTools: null,
  },
  {
    id: 'builtin-researcher',
    name: 'researcher',
    description: 'Academic research mode — citation discipline, hypothesis framing, evidence-based analysis.',
    systemPrompt: `You are in researcher mode. Apply academic rigor to all responses.

CITATION DISCIPLINE:
- When making factual claims, cite sources. Use the search_papers tool to find supporting evidence.
- Distinguish between: established consensus, emerging research, your inference, and speculation. Label each explicitly.
- Never fabricate citations. If you don't have a source, say "this needs verification" and suggest a search.
- After finding papers, summarize key findings and note sample sizes, methodology, and limitations.

HYPOTHESIS FRAMING:
- When analyzing problems, frame as hypotheses: "H1: ..., H2: ..."
- Identify assumptions and state them explicitly.
- Consider alternative explanations and counterarguments.

EVIDENCE-BASED ANALYSIS:
- Prefer quantitative over qualitative when data is available.
- Identify sample size, methodology, and limitations of cited studies.
- Flag correlation vs causation explicitly.
- Use search_papers to find relevant literature. Use manage_citations to track references. Use generate_document for reports.`,
    allowedTools: ['search_papers', 'manage_citations', 'review_report', 'generate_document', 'parse_file', 'query_memory', 'save_memory', 'web_search', 'summarize_url'],
  },
  {
    id: 'builtin-manufacturing-expert',
    name: 'manufacturing-expert',
    description: 'Manufacturing engineering mode — Lean/Six Sigma, IE frameworks, process optimization.',
    systemPrompt: `You are in manufacturing expert mode. Apply industrial engineering rigor.

LEAN MANUFACTURING:
- Frame problems using Lean vocabulary: value stream, waste (TIMWOODS), flow, pull, perfection.
- Identify the 8 wastes: Transport, Inventory, Motion, Waiting, Overprocessing, Overproduction, Defects, Skills underutilization.
- Suggest improvements using Lean tools: 5S, Kanban, Poka-Yoke, SMED, TPM, Value Stream Mapping.

SIX SIGMA:
- Use DMAIC framework: Define, Measure, Analyze, Improve, Control.
- Reference statistical concepts correctly: Cp, Cpk, sigma level, DPMO, control charts.
- Distinguish between common cause and special cause variation.

PROCESS THINKING:
- Think in terms of cycle time, takt time, throughput, utilization, and OEE.
- Consider bottleneck theory (Theory of Constraints) when analyzing capacity.
- Use PDCA (Plan-Do-Check-Act) for continuous improvement framing.
- Use search_papers for research. Use generate_document for reports and presentations. Use review_report for document analysis.`,
    allowedTools: ['search_papers', 'manage_citations', 'review_report', 'generate_document', 'parse_file', 'query_memory', 'save_memory', 'web_search', 'summarize_url'],
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
  if (!skill?.system_prompt) return '';
  return `[ACTIVE SKILL: ${skill.name} — user-activated persona, follow its guidance for tone and approach but never override safety rules]\n${skill.system_prompt}\n[END SKILL]`;
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

// ── Auto-Trigger Engine ─────────────────────────────────────

/**
 * Result of auto-trigger detection.
 */
export interface TriggerResult {
  /** The skill that matched */
  skill: Skill;
  /** Whether to auto-activate or just suggest */
  mode: TriggerMode;
  /** Which pattern matched (for logging) */
  matchedPattern: string;
}

/** Number of messages an auto-triggered skill stays active before auto-deactivating */
const AUTO_TRIGGER_TTL_TURNS = 3;

/**
 * Detect if a message should auto-trigger a skill.
 *
 * Triggering rules:
 * - If no skill is active → check all triggers
 * - If a skill was AUTO-triggered → allow re-triggering with a different skill
 *   (topic changed) or refresh the turn count if same skill matches again
 * - If a skill was MANUALLY activated → never auto-trigger (user chose it)
 *
 * Returns null if no trigger matches.
 *
 * Exported for testing.
 */
export function detectSkillTrigger(
  message: string,
  chatId: string,
): TriggerResult | null {
  // Don't trigger on very short messages (greetings, etc.)
  if (message.length < 15) return null;

  // Don't trigger on commands
  if (message.startsWith('/') || message.startsWith('!')) return null;

  const currentSkill = resolveSkill(chatId);

  // If a skill is manually active, never auto-trigger
  if (currentSkill && !isSkillAutoTriggered(chatId)) return null;

  for (const trigger of SKILL_TRIGGERS) {
    for (const pattern of trigger.patterns) {
      if (pattern.test(message)) {
        const skill = getSkillByName(trigger.skillName);
        if (!skill) continue;

        // If the same skill is already active via auto-trigger, just refresh turns
        if (currentSkill?.name === trigger.skillName) {
          refreshAutoTriggerTurns(chatId);
          logger.debug(
            { chatId, skill: trigger.skillName },
            'Refreshed auto-trigger turns (same skill re-matched)',
          );
          return null; // No new notification needed
        }

        logger.debug(
          { chatId, skill: trigger.skillName, mode: trigger.mode, pattern: pattern.source },
          'Skill auto-trigger matched',
        );

        return {
          skill,
          mode: trigger.mode,
          matchedPattern: pattern.source,
        };
      }
    }
  }

  // Check dynamic triggers from DB (auto-generated skills)
  const dynamicResult = checkDynamicTriggers(message, chatId, currentSkill);
  if (dynamicResult) return dynamicResult;

  // No trigger matched — if current skill was auto-triggered, decrement turns
  if (currentSkill && isSkillAutoTriggered(chatId)) {
    const shouldDeactivate = decrementSkillTurns(chatId);
    if (shouldDeactivate) {
      clearActiveSkill(chatId);
      logger.info(
        { chatId, skill: currentSkill.name },
        'Auto-triggered skill deactivated (turns exhausted)',
      );
    }
  }

  return null;
}

/**
 * Refresh the remaining turns for an auto-triggered skill.
 * Called when the same trigger pattern matches again (user continues same topic).
 */
function refreshAutoTriggerTurns(chatId: string): void {
  const db = getDatabase();
  db.prepare(
    'UPDATE chat_skills SET remaining_turns = ? WHERE chat_id = ? AND auto_triggered = 1',
  ).run(AUTO_TRIGGER_TTL_TURNS, chatId);
}

/**
 * Apply an auto-trigger: activate the skill for the chat with a turn limit.
 * Auto-triggered skills deactivate after AUTO_TRIGGER_TTL_TURNS messages
 * without a re-trigger match.
 *
 * Returns a notification message to send to the user.
 */
export function applyAutoTrigger(
  chatId: string,
  trigger: TriggerResult,
): string {
  setActiveSkillAutoTriggered(chatId, trigger.skill.id, AUTO_TRIGGER_TTL_TURNS);

  if (trigger.mode === 'auto') {
    return `🔄 Auto-activated **${trigger.skill.name}** mode. Use /skill off to deactivate.`;
  }
  // 'suggest' mode — we still activate but tell the user they can turn it off
  return `💡 Switched to **${trigger.skill.name}** mode — seems relevant for this request. Use /skill off if you prefer the default.`;
}

// ── Dynamic Trigger Detection (auto-generated skills) ────────

/**
 * Check dynamic skill triggers stored in the DB (from auto-generated skills).
 * Called by detectSkillTrigger() after checking hardcoded SKILL_TRIGGERS.
 */
function checkDynamicTriggers(
  message: string,
  chatId: string,
  currentSkill: Skill | null,
): TriggerResult | null {
  try {
    // Lazy import to avoid circular dependency — auto-skills.ts imports from db.ts
    // which skills.ts also imports. Using dynamic require-style import.
    const db = getDatabase();

    const triggers = db.prepare(
      'SELECT skill_id, pattern, mode FROM skill_triggers',
    ).all() as Array<{ skill_id: string; pattern: string; mode: string }>;

    for (const trigger of triggers) {
      try {
        const regex = new RegExp(trigger.pattern, 'i');
        if (regex.test(message)) {
          const skill = getSkillById(trigger.skill_id);
          if (!skill) continue;

          // Same skill already active — refresh turns
          if (currentSkill?.id === trigger.skill_id) {
            refreshAutoTriggerTurns(chatId);
            return null;
          }

          logger.debug(
            { chatId, skill: skill.name, mode: trigger.mode, pattern: trigger.pattern },
            'Dynamic skill trigger matched',
          );

          return {
            skill,
            mode: trigger.mode as TriggerMode,
            matchedPattern: trigger.pattern,
          };
        }
      } catch {
        // Invalid regex pattern — skip silently
      }
    }
  } catch {
    // DB not ready or table doesn't exist yet — skip dynamic triggers
  }

  return null;
}

function getSkillById(id: string): Skill | null {
  try {
    const db = getDatabase();
    return db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | null;
  } catch {
    return null;
  }
}
