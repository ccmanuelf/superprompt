import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider, clearOllamaHistory } from './ollama.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getSession,
  setSession,
  updateSessionProvider,
  updateSessionOllamaModel,
  clearSession,
  setAutoRoute,
  isAutoRouteEnabled,
} from '../db.js';
import { getSkillSystemPrompt, getSkillAllowedTools, detectSkillTrigger, applyAutoTrigger } from '../skills.js';
import { CAPABILITIES_PROMPT, generateMfgContextHint } from '../capabilities.js';
import { getAggregatedCapabilities, buildWebAppsPrompt } from '../packs.js';
import { buildWebUIAwarenessPrompt } from '../web-ui-guide.js';

const LANGUAGE_HINT = 'Always respond in the same language the user\'s latest message is written in. If they switch languages, you switch too — immediately, without being asked.';

/**
 * Anti-rationalization rules applied to ALL responses (both providers).
 * Inspired by Superpowers verification-before-completion patterns.
 */
export const QUALITY_RULES = `## Response Quality Rules

### What NOT to do (enforce these first)
- NEVER say "should work" or "probably" — verify or state uncertainty explicitly.
- NEVER include any claim you cannot support with specific reasoning. No padding, no plausible-sounding filler. If you lack data, say what data you would need.
- NEVER fabricate information — when you don't know something, say so.
- NEVER claim completion without evidence (output, result, confirmation).
- NEVER make assumptions silently. If a complex task requires assumptions, list them explicitly before you begin: "I'm assuming X, Y, Z — correct me if any are wrong."
- NEVER give a one-sided recommendation. After any recommendation, argue the opposite position with equal conviction. If both sides feel equally strong, say so — that means the answer isn't clear-cut yet.
- NEVER bury constraints. When processing a request, handle it as: Ask → Constraints → Context (not context-first with constraints as afterthoughts).

### What TO do

**Audience + format anchor:** Before generating any substantial content (reports, analysis, documents), ask ONE natural question that covers both audience and format: "Who's this for and what format works best — summary, detailed breakdown, table, or document?" A capacity report for a floor supervisor reads differently than one for a VP. Lock onto the answer before processing. Don't ask if the audience and format are obvious from context.

**Assumption audit:** Before any strategic, analytical, or data-dependent task, list every assumption you are making. This surfaces hidden reasoning that would otherwise be buried inside a confident-sounding answer.

**Step separator:** For multi-step tasks, work in hard stops: Complete step 1 → Present result → Wait for user confirmation → Then proceed to step 2. Do not run all steps without checkpoints.

**Counter-argument:** After presenting a recommendation, state: "The strongest argument against this is..." If you can argue both sides with equal conviction, tell the user — that means more information is needed before deciding.

**Specificity check:** If your first draft of a claim feels generic, make it 3x more specific. "Production improved" → "Line 2 throughput increased from 340 to 485 units/shift after the rebalance, a 43% gain." Specificity is credibility.

**Self-critique:** After generating substantial content, identify the single weakest point and strengthen it. If you can't improve it, state what additional information would.

### Persona Boundaries
When a skill is active, respect its hard boundaries. A manufacturing engineering persona does not speculate — if data is missing, it says so explicitly. A financial analyst does not round numbers or estimate without flagging. Each persona has limits; those limits are what make it trustworthy.

### Structured Input Handling
When processing complex multi-part messages, parse as: Ask (what they want) → Constraints (rules, limits, must-haves) → Context (background). Address the ask first, respect the constraints, use the context. Don't let context bury the actual request.

### Applying These Rules Proportionally
- Simple greetings, short questions, casual chat → respond naturally, no framework.
- Moderate tasks (calculations, lookups, single-step) → apply relevant rules without ceremony.
- Complex tasks (analysis, recommendations, planning, reports) → apply all rules deliberately.
Match the response depth to the request complexity.`;

/**
 * Command list injected into system prompts so the AI knows what commands exist
 * and can suggest them to users when relevant.
 */
export const COMMAND_LIST = `## Available User Commands
The user can type these commands in the chat:
- /newchat — Start a fresh session (clears history)
- /memory — Show stored memories about the user
- /voice — Toggle voice replies on text messages
- /claude — Switch to Claude provider
- /ollama — Switch to Ollama provider
- /auto — Toggle automatic provider routing
- /provider — Show current provider and routing mode
- /models — List available Ollama models
- /model <name> — Switch Ollama model
- /schedule — Manage scheduled tasks (add, list, pause, resume, delete)
- /skill — Manage AI skills (list, use, create, fix, lock, export, upload, delete)
- /tool — Manage tools (list, show, upload, generate, fix, enable, disable, delete)
- /careful — Enable safety guardrails mode
- /digest — Activity digests (daily/weekly/now/off)
- /board — Kanban board (list, add, move, assign, view, delete)
- /learn — Learning coach (start, plan, session, review, time, persona, move, add, remove, pause, resume, done)
- /research <query> — Search academic papers (Semantic Scholar + arXiv)
- /cite — Manage citations (list, export bibtex/apa/chicago, clear)
- /reload — Reload user tools from database
- /compress — Compress the last response into 5 decision-relevant sentences (or reply to any message)
- /pack — Domain packs (list, info, create) — customize for your department
- /help — Show categorized command reference

When relevant, you can mention these commands to help the user. For example, if the user asks "can you remember this?", you might mention /memory. If they seem to want a different AI behavior, mention /skill. If they say "remind me about X", use the create_reminder tool instead of suggesting /schedule.

You also have access to GitHub tools (github_list_repos, github_read_file, github_list_issues, github_clone_repo, github_diff, github_commit_push, github_create_pr), Render deploy tools (render_list_services, render_deploy_status, render_get_logs), a take_screenshot tool for capturing web pages visually, and kanban_manage for task tracking.

IMPORTANT — Kanban Board: When you identify tasks, ideas, issues, or follow-ups during conversation, proactively suggest adding them to the board. With Ollama: call kanban_manage directly. With Claude: embed a kanban_action JSON block OR guide the user to \`/board add <title>\`.`;

/**
 * Kanban board action format — teaches BOTH providers how to create/manage cards.
 * Uses the same JSON-in-response pattern as document generation.
 * The platform handler detects and executes these automatically.
 */
const KANBAN_PROMPT = `## Kanban Board — Always Accessible

The board is ALWAYS accessible from this conversation. NEVER say "the board is unavailable" or "I can't access it."

**How to access the board:**
- **With tools (Ollama):** call kanban_manage directly with action "list", "create", "move", "assign", or "summary"
- **Without tools (Claude):** use these Telegram commands or embed a kanban_action JSON block:
  - \`/board\` — shows the full board with all columns and cards
  - \`/board add "Task title"\` — creates a new card
  - \`/board move [id] done\` — moves a card to done
  - \`/board show [id]\` — shows card details
  - \`/board priority [id] 1\` — sets priority (1=critical to 5=minimal)
  - Web UI: \`/board.html\`

NEVER say a feature is unavailable — either use the tool directly OR guide to the slash command/web UI.

When you identify a task, idea, issue, or opportunity during conversation, you can also add it by including a JSON block in your response:

\`\`\`json
{"kanban_action": "create", "title": "Task title", "description": "Optional details", "assignee": "noted", "priority": 3, "due_date": "2026-03-25", "scheduled_for": "tonight"}
\`\`\`

ASSIGNMENT RULES — follow these strictly:
- DEFAULT is always "noted" — capture the item for visibility but do NOT assign an owner until explicitly requested
- Set "bot" ONLY when the user explicitly asks you to handle it: "please take care of X", "can you handle X", "you do X", "let the bot do X"
- Set "me" ONLY when the user explicitly says they will do it: "I will do X", "I'll handle X", "let me take care of X"
- Set "collaborative" ONLY when the user explicitly says to work together: "let's work on X together", "we should both look at X"
- Keep "noted" for everything else — brainstorming, ideas, discussions, reviews, and anything ambiguous
- When in doubt, use "noted" — NEVER assign ownership unless the user explicitly requests it
- The user will review and reassign cards from the board when ready

Priority: 1=critical, 2=high, 3=medium, 4=low, 5=minimal.
due_date: optional deadline in ISO format (YYYY-MM-DD) — when the task should be DONE.
scheduled_for: optional start time — "tonight", "tomorrow morning", or ISO datetime. Bot tasks with priority 1-2 execute immediately; priority 3-5 execute during nightly window (22:00-06:00) or at scheduled_for time.

Set priority and dates conversationally: "this is urgent" → priority 1. "by Friday" → due_date. "run it tonight" → scheduled_for.

Be PROACTIVE about creating cards when the user mentions something actionable. But be CONSERVATIVE about assignment — let the user decide who does what.`;

/**
 * Claude-specific provider notice — injected ONLY when Claude is the active provider.
 *
 * KEY INSIGHT: Claude CLI has its own built-in identity ("I am Claude Code") which
 * overrides our system prompt unless we explicitly counter it. The platformIdentity
 * section (injected first in the prompt) handles identity. This section handles
 * HOW Claude accesses features without callable tool functions.
 *
 * The framing is critical: NOT "you can't call tools" (which Claude misinterprets as
 * "tools don't exist here") but "the platform executes actions for you via JSON blocks
 * and slash commands."
 */
const CLAUDE_PROVIDER_NOTICE = `## How You Access Features (Claude Engine)

You are powered by the Claude engine. Your tool access works differently from Ollama — you access features through JSON blocks embedded in your response and by guiding users to slash commands. The platform intercepts your JSON blocks and executes them automatically.

### What works DIRECTLY from your response (embed JSON blocks):
1. **Board cards** — embed a kanban_action JSON block and the platform creates/manages cards automatically
2. **Documents** — embed a DocGenRequest JSON block and the platform generates XLSX/DOCX/PDF/PPTX/CSV files
3. **Conversation** — analysis, reasoning, writing, advice, bilingual support — this is where you excel

### What works via SLASH COMMANDS (tell the user to type these in chat):
| Feature | Command | What it does |
|---------|---------|-------------|
| Board | \`/board\` | List all cards with status |
| Board | \`/board add "title"\` | Create a new card |
| Board | \`/board move [id] done\` | Move card to done |
| Board | \`/board show [id]\` | Show card details |
| Memory | \`/memory\` | Show stored memories |
| Schedule | \`/schedule add "msg" "cron"\` | Create reminder |
| Schedule | \`/schedule list\` | List active schedules |
| Skills | \`/skill list\` | Show available skills |
| Learning | \`/learn start <topic>\` | Start learning plan |
| Research | \`/research <query>\` | Search academic papers |
| Citations | \`/cite list\` | Show saved citations |

### What works via WEB DASHBOARDS (guide the user to open in browser):
| Dashboard | URL | Best for |
|-----------|-----|----------|
| Board | /board | Visual kanban with drag-and-drop |
| Learning | /learn | Study plans, streak tracking |
| Voice | / | Voice conversation |
| Simulation | /sim | Production line DES modeling |
| Capacity | /capacity | Capacity planning analysis |
| Sequencing | /sequence | Job scheduling optimizer |
| VSM | /vsm | Value stream mapping |
| TOC | /toc | Theory of constraints |
| CONWIP | /conwip | Production leveling |
| DOE | /doe | Design of experiments |
| FSM | /fsm | State machine simulator |
| Hub | /hub | Production orders & tracking |
| BOM | /hub/bom | BOM & shortage resolution |

### What requires switching to Ollama (\`/ollama\`):
Manufacturing calculation tools (capacity_planning, production_simulation, job_sequencer, line_balance, sigma_analysis, etc.), web search, file reading, GitHub operations, system commands. These need Ollama's direct function-calling.

When the user asks for these: "I can help you think through this, and for the full calculation you can switch to \`/ollama\` or use the web dashboard at [URL]."

### ABSOLUTE RULES:
1. NEVER say "I don't have access to that" or "that tool isn't available" — EVERY feature has an access path
2. NEVER say "this is Claude Code" or "this is a CLI/terminal" — you are clauded on the user's messaging platform
3. NEVER pretend to execute a function call — use JSON blocks or guide to slash commands
4. When creating board cards: ALWAYS embed the kanban_action JSON block — it works immediately
5. When the user needs manufacturing tools: suggest \`/ollama\` AND the web dashboard URL`;

const VOICE_RESPONSE_HINT = `The user sent a voice message. Respond as if in a verbal conversation:
- Keep responses to 1-3 sentences. Be concise.
- No markdown formatting (no bullet points, headers, code blocks, bold, italics).
- Speak naturally and conversationally — your response will be read aloud.
- If the question requires a long answer, give a brief summary and offer to elaborate.`;

/**
 * Claude-specific prompt that teaches it about document capabilities.
 * The platform layer parses uploaded files and injects their text into messages,
 * and detects DocGenRequest JSON blocks in responses to generate real files.
 * Claude just needs to know the JSON schema to trigger document generation.
 */
const CLAUDE_DOCUMENT_PROMPT = `## Document Capabilities

### Reading Files
When a user uploads a document (PDF, DOCX, XLSX, CSV, PPTX, JSON, MD, TXT), the system extracts its text content and includes it in the message as "[Document: filename]" followed by the parsed content. You can analyze, summarize, and answer questions about this content directly.

### Generating Documents
When the user asks you to create or generate a document (spreadsheet, report, PDF, CSV), respond with a JSON code block in this exact format. The system will detect it and generate the actual file.

**For spreadsheets (XLSX or CSV):**
\`\`\`json
{
  "format": "xlsx",
  "filename": "descriptive-name.xlsx",
  "title": "Optional Title",
  "content": {
    "type": "spreadsheet",
    "sheets": [{
      "name": "Sheet1",
      "headers": ["Column A", "Column B", "Column C"],
      "rows": [
        ["value1", 2, true],
        ["value2", 3, false]
      ]
    }]
  }
}
\`\`\`

**For documents (DOCX or PDF):**
\`\`\`json
{
  "format": "docx",
  "filename": "descriptive-name.docx",
  "title": "Document Title",
  "content": {
    "type": "document",
    "sections": [{
      "heading": "Section Title",
      "paragraphs": ["Paragraph text here."],
      "bulletPoints": ["Point 1", "Point 2"],
      "table": {
        "headers": ["Col A", "Col B"],
        "rows": [["val1", "val2"]]
      }
    }]
  }
}
\`\`\`

**Charts in documents (PDF or DOCX):**
Sections can include a "chart" field to render a visual chart. Supported types: bar, line, pie, doughnut, scatter, radar, bubble, polarArea.

\`\`\`json
{
  "format": "pdf",
  "filename": "report.pdf",
  "title": "Sales Report",
  "content": {
    "type": "document",
    "sections": [
      {
        "heading": "Revenue Overview",
        "paragraphs": ["Quarterly revenue breakdown:"],
        "chart": {
          "type": "bar",
          "title": "Quarterly Revenue",
          "data": {
            "labels": ["Q1", "Q2", "Q3", "Q4"],
            "datasets": [{
              "label": "Revenue ($K)",
              "data": [120, 190, 150, 220],
              "backgroundColor": ["#4BC0C0", "#FF6384", "#36A2EB", "#FFCE56"]
            }]
          }
        }
      }
    ]
  }
}
\`\`\`

**For presentations (PPTX):**
\`\`\`json
{
  "format": "pptx",
  "filename": "presentation.pptx",
  "title": "Presentation Title",
  "content": {
    "type": "presentation",
    "slides": [
      {"layout": "title", "title": "Main Title", "subtitle": "Subtitle text"},
      {"layout": "bullets", "title": "Key Points", "bullets": ["Point 1", "Point 2", "Point 3"], "notes": "Speaker notes here"},
      {"layout": "two-column", "title": "Comparison", "leftColumn": ["Left item 1", "Left item 2"], "rightColumn": ["Right item 1", "Right item 2"]},
      {"layout": "chart", "title": "Data", "chart": {"type": "bar", "data": {"labels": ["A", "B"], "datasets": [{"label": "Values", "data": [10, 20]}]}}}
    ]
  }
}
\`\`\`

Slide layouts: title, bullets, two-column, chart, image, blank. Each slide can have speaker notes.

Supported formats: \`xlsx\`, \`docx\`, \`pdf\`, \`csv\`, \`pptx\`. Use \`csv\` format with spreadsheet content type for simple tabular data. Include any explanatory text outside the JSON code block — it will be sent alongside the file.

When you cite a source in your response, use the search_papers tool to find supporting evidence and the manage_citations tool to save references for the user.`;

/**
 * Patterns that FORCE Ollama — tool-dependent operations that Claude cannot execute.
 * These are checked FIRST, before Claude patterns and length heuristics.
 * Without this, auto-routing may send tool-heavy requests to Claude which can't call them.
 * Exported for testing.
 */
export const OLLAMA_TOOL_PATTERNS = [
  // Manufacturing tools (EN + ES)
  /\b(simulat|capacity|sequenc|balance|bottleneck|toc|conwip|heijunka|kanban|vsm|value stream|doe|experiment|fmea|rca|root cause|spc|control chart|sigma|cpk|fsm|state machine|inventory plan)\b/i,
  /\b(simulaci[oó]n|capacidad|secuencia|balanc|cuello de botella|heijunka|kanban|flujo de valor|experimento|causa ra[ií]z|carta de control|m[aá]quina de estados|inventario)\b/i,
  // Tool-action phrases (EN + ES)
  /\b(run|execute|calculate|optimize|schedule)\s+(a\s+)?(simulation|capacity|sequence|balance|doe|experiment|fmea|rca)\b/i,
  /\b(ejecut|calcul|optimi|program)\w*\s+(una?\s+)?(simulaci[oó]n|capacidad|secuencia|balance|experimento)\b/i,
  // Board/task management via tool
  /\b(show|list|create|move|assign|delete)\s+(a\s+)?(card|task|board)\b/i,
  /\b(muestra|lista|crea|mueve|asigna|elimina)\w*\s+(una?\s+)?(tarjeta|tarea|tablero)\b/i,
  // Memory queries
  /\b(remember|recall|what did (I|we)|search memory|query memory)\b/i,
  /\b(recuerd|qu[eé] (dije|hablamos)|busca en memoria)\b/i,
  // Web search / URL
  /\b(search the web|web search|look up online|busca en (la )?web|buscar en internet)\b/i,
  /\b(summarize|fetch|read)\s+(this\s+)?(url|link|page|p[aá]gina)\b/i,
  // GitHub operations (action-oriented: clone repo, list issues, create PR — not "review the pull request")
  /\b(clone|commit|push)\s+(a\s+|the\s+|to\s+)?(repo|branch|remote)\b/i,
  /\b(list|show|check)\s+(my\s+)?(repos|issues|prs|pull requests)\b/i,
  /\b(create|open)\s+(a\s+)?(pr|pull request|issue)\b/i,
  /\bgithub\s+(clone|list|issues|deploy|diff)\b/i,
  // Schedule / reminder
  /\b(remind me|set (a\s+)?reminder|schedule|recu[eé]rdame|programa)\b/i,
  // File operations
  /\b(read|parse|open)\s+(the\s+)?(file|document|archivo|documento)\b/i,
  // Screenshot
  /\b(take|capture)\s+(a\s+)?screenshot\b/i,
  // Research
  /\b(search papers|find papers|academic search|busca art[ií]culos|papers)\b/i,
];

/**
 * Heuristic patterns that suggest Claude is the better provider.
 * These indicate complex analysis, creative writing, or document generation.
 * Exported for testing.
 */
export const CLAUDE_PATTERNS = [
  /\b(analy[sz]e|analyze|review|evaluate|compare|assess|critique|explain in detail)\b/i,
  /\b(write|draft|compose|create|generate)\s+(a|an|the|my)?\s*(report|essay|article|document|email|letter|proposal|story|plan)\b/i,
  /\b(refactor|debug|code review|architecture|design pattern)\b/i,
  /\b(format.*?(xlsx|docx|pdf|csv)|(xlsx|docx|pdf|csv)\s+format)\b/i,
  /```[\s\S]{100,}/,  // Long code blocks in the message suggest complex context
];

/** Messages shorter than this are routed to Ollama in auto mode */
export const SHORT_MESSAGE_THRESHOLD = 100;

/** Messages longer than this are routed to Claude in auto mode */
export const LONG_MESSAGE_THRESHOLD = 500;

/**
 * Classify a message to determine the best provider.
 * Heuristic-based — no AI call needed.
 *
 * Priority order:
 * 1. Tool-dependent patterns → Ollama (Claude can't call tools)
 * 2. Claude-preferred patterns → Claude (complex reasoning, writing)
 * 3. Length heuristic → long=Claude, short=Ollama
 * 4. Default → Ollama (local, no API cost)
 *
 * Exported for testing.
 */
export function classifyMessage(message: string): 'claude' | 'ollama' {
  // FIRST: Tool-dependent requests MUST go to Ollama (Claude can't call tools)
  for (const pattern of OLLAMA_TOOL_PATTERNS) {
    if (pattern.test(message)) return 'ollama';
  }

  // Long messages → Claude (more capable at complex reasoning)
  if (message.length > LONG_MESSAGE_THRESHOLD) return 'claude';

  // Check for Claude-preferred patterns
  for (const pattern of CLAUDE_PATTERNS) {
    if (pattern.test(message)) return 'claude';
  }

  // Short, simple messages → Ollama (faster, local)
  if (message.length < SHORT_MESSAGE_THRESHOLD) return 'ollama';

  // Default: Ollama for everything else (local, no API cost)
  return 'ollama';
}

export class ProviderRouter {
  private claude: ClaudeProvider;
  private ollama: OllamaProvider;
  /** Tracks the last provider actually used per chat (for /provider status in auto mode) */
  private lastUsedProvider = new Map<string, 'claude' | 'ollama'>();

  constructor() {
    this.claude = new ClaudeProvider();
    this.ollama = new OllamaProvider();
  }

  /**
   * Get the active provider for a chat.
   * Priority: auto-routing (if enabled) > per-chat override (from DB) > default from config.
   *
   * Auto-routing has stickiness: if the last message used a provider, prefer it
   * unless the classifier strongly disagrees (prevents mid-conversation switching).
   */
  private getProviderForChat(chatId: string, message?: string): AIProvider {
    const session = getSession(chatId);

    // Auto-routing: classify message and pick provider
    if (session?.auto_route && message) {
      const autoChoice = classifyMessage(message);
      const lastUsed = this.lastUsedProvider.get(chatId);

      // Stickiness: if we recently used a provider, stay with it UNLESS
      // the classifier specifically wants Claude (upgrade path).
      // This prevents ping-ponging mid-conversation.
      // Ollama → Claude upgrade: allowed (user needs more capable model)
      // Claude → Ollama downgrade: blocked (preserve conversation context)
      let finalChoice = autoChoice;
      if (lastUsed && lastUsed === 'claude' && autoChoice === 'ollama') {
        // Don't downgrade from Claude mid-conversation
        finalChoice = 'claude';
      }

      const provider = finalChoice === 'ollama' ? this.ollama : this.claude;
      this.lastUsedProvider.set(chatId, provider.name);
      return provider;
    }

    const providerName = session?.provider || config.AI_PROVIDER;

    if (providerName === 'ollama') {
      return this.ollama;
    }
    return this.claude;
  }

  /**
   * Send a message through the appropriate provider.
   * Handles session management (session ID persistence for Claude).
   */
  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { chatId } = params;
    const provider = this.getProviderForChat(chatId, params.message);

    // Rate limiting — check before sending to provider
    const { getRateLimiter } = await import('../rate-limiter.js');
    const limiter = getRateLimiter();
    const rateCheck = limiter.check(chatId, provider.name);
    if (!rateCheck.allowed) {
      return {
        text: rateCheck.message || 'Rate limit reached',
        provider: provider.name,
      };
    }

    // Load existing session ID for Claude
    const session = getSession(chatId);
    const sessionId =
      provider.name === 'claude' ? session?.session_id : undefined;

    logger.info(
      { chatId, provider: provider.name, hasSession: !!sessionId },
      'Routing message',
    );

    // Check for auto-trigger before resolving skill (skip for orchestrator step calls)
    let autoTriggerNotice: string | undefined;
    const triggerResult = params.skipAutoTrigger ? null : detectSkillTrigger(params.message, chatId);
    if (triggerResult) {
      autoTriggerNotice = applyAutoTrigger(chatId, triggerResult);
      logger.info(
        { chatId, skill: triggerResult.skill.name, mode: triggerResult.mode },
        'Skill auto-triggered',
      );
    }

    // Resolve active skill for this chat (may now include auto-triggered skill)
    const skillPrompt = getSkillSystemPrompt(chatId);
    const allowedTools = getSkillAllowedTools(chatId);

    // Inject voice hint when the message is from a voice note
    const voiceHint = params.isVoice ? VOICE_RESPONSE_HINT : '';

    // Platform identity — tells the AI WHERE the user is chatting from
    // This prevents Claude from confusing itself with "Claude Code" CLI
    const platformLabels: Record<string, string> = {
      telegram: 'Telegram Bot',
      matrix: 'Matrix chat',
      'voice-web': 'Web Voice interface',
    };
    const platformName = params.platform ? platformLabels[params.platform] || params.platform : 'messaging platform';
    const platformIdentity = `## Identity — READ THIS FIRST\nYou are **clauded**, an AI assistant running on the user's company infrastructure. The user is chatting with you via **${platformName}**. You are NOT "Claude Code", you are NOT a CLI tool, you are NOT running in a terminal or IDE. You are the clauded ${platformName} — the user's AI partner deployed on their company server.`;

    // Inject capabilities, document generation, quality rules, command list, and kanban prompt
    // Manufacturing context hint is generated per-message based on conversational intent
    const mfgHint = generateMfgContextHint(params.message);
    // Compose full capabilities: base (manufacturing) + domain packs
    const packCaps = getAggregatedCapabilities();
    const webAppsPrompt = buildWebAppsPrompt();
    const webUIAwareness = buildWebUIAwarenessPrompt();
    const fullCapabilities = [CAPABILITIES_PROMPT, packCaps, webAppsPrompt, webUIAwareness].filter(Boolean).join('\n\n');
    // Provider-aware system prompt composition:
    // - BOTH providers: platformIdentity comes FIRST (prevents Claude identity confusion)
    // - Claude: CLAUDE_PROVIDER_NOTICE (tool access via JSON blocks) + LANGUAGE_HINT
    // - Ollama: standard (has callable tools, model handles language)
    const systemPrompt = provider.name === 'claude'
      ? [platformIdentity, voiceHint, params.systemPrompt, skillPrompt, fullCapabilities, mfgHint, CLAUDE_PROVIDER_NOTICE, CLAUDE_DOCUMENT_PROMPT, KANBAN_PROMPT, QUALITY_RULES, COMMAND_LIST, LANGUAGE_HINT].filter(Boolean).join('\n\n')
      : [platformIdentity, voiceHint, params.systemPrompt, skillPrompt, fullCapabilities, mfgHint, CLAUDE_DOCUMENT_PROMPT, KANBAN_PROMPT, QUALITY_RULES, COMMAND_LIST].filter(Boolean).join('\n\n') || undefined;

    // When a skill is active, don't resume Claude sessions — the skill's system prompt
    // needs a fresh session to take effect (resumed sessions keep their original system prompt)
    const effectiveSessionId = (provider.name === 'claude' && skillPrompt) ? undefined : sessionId;

    // Per-chat Ollama model override
    const modelOverride = provider.name === 'ollama' && session?.ollama_model
      ? session.ollama_model
      : undefined;

    const response = await provider.sendMessage({
      ...params,
      sessionId: effectiveSessionId,
      systemPrompt,
      allowedTools: allowedTools ?? undefined,
      modelOverride,
    });

    // Handle stale Claude session — clear and retry without --resume
    if (response.staleSession && sessionId) {
      logger.warn({ chatId, sessionId }, 'Stale Claude session detected, retrying without --resume');
      clearSession(chatId);

      const retryResponse = await provider.sendMessage({
        ...params,
        sessionId: undefined,
        systemPrompt,
        allowedTools: allowedTools ?? undefined,
      });

      // Persist new session ID from retry
      if (retryResponse.newSessionId) {
        setSession(chatId, retryResponse.newSessionId, provider.name);
      }

      if (autoTriggerNotice) retryResponse.autoTriggerNotice = autoTriggerNotice;
      return retryResponse;
    }

    // Persist new session ID for Claude
    if (response.newSessionId) {
      setSession(chatId, response.newSessionId, provider.name);
    }

    if (autoTriggerNotice) response.autoTriggerNotice = autoTriggerNotice;

    // Record successful call for rate limiting
    limiter.record(chatId, provider.name);

    // Context health tracking — both providers
    try {
      const { getContextHealthMonitor } = await import('../context-health.js');
      const monitor = getContextHealthMonitor();
      monitor.recordMessage(chatId, params.message);
    } catch {
      // Context health module not loaded — skip
    }

    return response;
  }

  /**
   * Switch the provider for a chat.
   * Returns the new provider name.
   */
  switchProvider(chatId: string, providerName: string): string {
    const normalized = providerName.toLowerCase().trim();

    if (normalized !== 'claude' && normalized !== 'ollama') {
      return `Unknown provider "${providerName}". Use "claude" or "ollama".`;
    }

    const session = getSession(chatId);
    if (session) {
      updateSessionProvider(chatId, normalized);
    } else {
      setSession(chatId, '', normalized);
    }

    // Explicit provider switch disables auto-routing
    setAutoRoute(chatId, false);

    logger.info({ chatId, provider: normalized }, 'Switched provider (auto-route OFF)');
    return normalized;
  }

  /**
   * Toggle auto-routing for a chat.
   * Returns true if auto-routing is now enabled.
   */
  toggleAutoRoute(chatId: string): boolean {
    const current = isAutoRouteEnabled(chatId);
    const newState = !current;
    setAutoRoute(chatId, newState);
    this.lastUsedProvider.delete(chatId); // Reset stickiness on toggle
    logger.info({ chatId, autoRoute: newState }, 'Toggled auto-routing');
    return newState;
  }

  /**
   * Get the current provider status for a chat.
   * Returns provider name and routing mode.
   * In auto mode, shows the last provider actually used (not the fallback).
   */
  getProviderStatus(chatId: string): { provider: string; mode: 'manual' | 'auto'; model?: string } {
    const session = getSession(chatId);
    const autoRoute = session?.auto_route === 1;

    // In auto mode, show the last-used provider (what actually ran)
    const providerName = autoRoute
      ? (this.lastUsedProvider.get(chatId) || session?.provider || config.AI_PROVIDER)
      : (session?.provider || config.AI_PROVIDER);

    const status: { provider: string; mode: 'manual' | 'auto'; model?: string } = {
      provider: providerName,
      mode: autoRoute ? 'auto' : 'manual',
    };

    if (providerName === 'ollama') {
      status.model = session?.ollama_model || config.OLLAMA_CHAT_MODEL;
    }

    return status;
  }

  /**
   * Start a new chat session.
   * Clears the session from DB and Ollama history.
   */
  newChat(chatId: string): void {
    clearSession(chatId);
    clearOllamaHistory(chatId);
    this.lastUsedProvider.delete(chatId); // Reset auto-routing stickiness
    logger.info({ chatId }, 'New chat started');
  }

  /**
   * Get the current provider name for a chat.
   */
  getProviderName(chatId: string): string {
    const session = getSession(chatId);
    return session?.provider || config.AI_PROVIDER;
  }

  /**
   * List available Ollama models (excluding embedding models).
   */
  async listOllamaModels(): Promise<{ name: string; size: string; family: string }[]> {
    return this.ollama.listModels();
  }

  /**
   * Switch the Ollama model for a specific chat.
   * Validates the model exists locally before switching.
   */
  async switchOllamaModel(chatId: string, model: string): Promise<string> {
    const exists = await this.ollama.modelExists(model);
    if (!exists) {
      return `Model "${model}" not found locally. Use /models to see available models.`;
    }

    const session = getSession(chatId);
    if (session) {
      updateSessionOllamaModel(chatId, model);
    } else {
      setSession(chatId, '', 'ollama');
      updateSessionOllamaModel(chatId, model);
    }

    logger.info({ chatId, model }, 'Switched Ollama model');
    return model;
  }

  /**
   * Get the active Ollama model for a chat (per-chat override or config default).
   */
  getOllamaModel(chatId: string): string {
    const session = getSession(chatId);
    return session?.ollama_model || config.OLLAMA_CHAT_MODEL;
  }
}
