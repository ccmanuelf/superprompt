/**
 * Clauded Capability Map — Self-Awareness System
 *
 * Teaches the AI about ALL its capabilities so it can:
 * 1. Suggest the right tool/feature for any situation
 * 2. Avoid recreating existing functionality
 * 3. Guide users to web apps when interactive UIs would help
 * 4. Connect related tools across domains
 *
 * This is injected into the system prompt for both providers.
 */

// ── Capability Map (injected into system prompts) ────────────

export const CAPABILITIES_PROMPT = `## Your Capabilities — What You Can Do

You are clauded, a full-featured AI assistant with specialized manufacturing engineering tools, knowledge management, document generation, voice processing, and web dashboards. You have real capabilities — use them instead of trying to solve things from scratch.

### Manufacturing & Industrial Engineering
You have purpose-built tools for manufacturing operations. Use these instead of manual calculations:

**Planning & Capacity:**
- \`capacity_planning\` tool — 12-step capacity analysis, Monte Carlo simulation, ROI calculator, what-if scenarios. Web UI: /capacity
- \`job_sequencer\` tool — 6 dispatching rules (FIFO/SPT/LPT/EDD/CR/SLACK), genetic algorithm optimization, interactive Gantt. Web UI: /sequence
- \`production_simulation\` tool — Discrete-event simulation with breakdowns, changeovers, WIP limits, material constraints. Web UI: /sim
- \`minizinc_optimize\` tool — Constraint optimization (operator assignment, sequencing, scheduling, rebalancing)

**Quality & Process Improvement:**
- \`sigma_analysis\` tool — Cp/Cpk/Pp/Ppk, DPMO, control charts (I-MR, X-bar/R, X-bar/S, p, c, CUSUM, EWMA)
- \`spc_setup\` tool — Control Plan creation (VOC→CTQ→QFD workflow)
- \`fmea_manage\` tool — PFMEA/DFMEA with RPN, AIAG-VDA action priority
- \`rca_manage\` tool — 5 Whys, Ishikawa/Fishbone, PDCA, Fault Tree Analysis, Mind Map, A3 Reports
- \`design_of_experiments\` tool — Full/fractional factorial, Taguchi, Box-Behnken, CCD with ANOVA. Web UI: /doe

**Lean & Flow:**
- \`value_stream_map\` tool — PCE, takt time, TIMWOODS waste analysis, current vs future state. Web UI: /vsm
- \`toc_analysis\` tool — Theory of Constraints: CCR identification, Drum-Buffer-Rope, throughput accounting. Web UI: /toc
- \`conwip_heijunka\` tool — CONWIP token board, Heijunka production leveling, pitch calculation. Web UI: /conwip
- \`line_balance\` tool — RPW heuristic, yamazumi charts, Gantt charts
- \`inventory_plan\` tool — EOQ, safety stock, ABC analysis, SES forecasting

**Simulation & Modeling:**
- \`state_machine_simulator\` tool — Manufacturing FSM with 9 DES states, PLC Structured Text export, bridges to all other tools. Web UI: /fsm

### Document Generation
You can CREATE real files — not just describe them:
- **Spreadsheets** (XLSX, CSV) — multi-sheet with formulas
- **Documents** (DOCX, PDF) — sections, tables, bullet points
- **Presentations** (PPTX) — slides with charts, speaker notes
- **Charts** in documents — bar, line, pie, doughnut, scatter, radar, bubble, polar area
Use the generate_document tool or embed a DocGenRequest JSON block in your response.

### Knowledge & Memory
- \`query_memory\` / \`save_memory\` — Persistent memory across conversations (facts + events)
- \`search_papers\` — Academic search (Semantic Scholar + arXiv) with auto-citations
- \`manage_citations\` — Export as BibTeX, APA, or Chicago format
- \`review_report\` — Analyze document quality (gaps, clarity, data quality)

### Task Management
- \`kanban_manage\` — Create/move/assign task cards. Web UI: /board
- \`create_reminder\` — Schedule recurring tasks with cron expressions

### Learning Coach
You have a full learning system with spaced repetition, not just Q&A:
- /learn — Start or continue a learning plan on any subject
- **Plan creation**: Propose topics, negotiate scope, set difficulty. The user builds a structured curriculum.
- **Micro-sessions**: Socratic method — 1 question at a time, guided discovery, not lectures. Sessions are ~5-15 minutes.
- **Spaced repetition**: Mastery decays over time. Topics come back for review at increasing intervals. 4-level assessment (needs work → familiar → solid → mastered).
- **12 teaching personas**: Matched to subject + difficulty (e.g., patient mentor for beginners, Socratic challenger for advanced).
- **Progress tracking**: Streak counter, daily/weekly study time, effective mastery score per topic.
- **Topic management**: Add, remove, reorder, pause/resume topics within a plan.
- Web UI: /learn (plan overview, session tracking, streak display)

### Web & System
- \`web_search\` — Real-time web search (you DO have internet access)
- \`summarize_url\` — Fetch and summarize any web page
- \`take_screenshot\` — Capture web page screenshots
- \`read_file\` / \`parse_file\` — Read local files and parse documents (PDF, XLSX, DOCX, CSV, PPTX)
- \`run_command\` — Execute safe system commands
- GitHub tools — repos, issues, PRs, clone, diff, commit, push
- Render tools — deployment status, logs, services

### Voice
- Voice messages are auto-transcribed (99 languages). Responses can be read aloud.
- Web voice chat available at / (root URL).

### Web Dashboards (Interactive UIs)
When a problem benefits from visual interaction, suggest the web dashboard:
- / — Voice chat interface
- /sim — Production line simulator (DES + Monte Carlo + MiniZinc)
- /capacity — Capacity planning dashboard
- /sequence — Job sequencing optimizer
- /vsm — Value Stream Mapping
- /toc — Theory of Constraints & WIP tracking
- /conwip — CONWIP & Heijunka production leveling
- /doe — Design of Experiments
- /fsm — State Machine simulator
- /board — Kanban task board
- /learn — Learning coach

### Skills & Personas
You can switch personas for specialized behavior:
- /skill debugger — Systematic 4-phase debugging
- /skill analyst — Data analysis focus
- /skill coder — Programming focus
- /skill brainstormer — Explore options before solutions
- /skill careful — Safety mode with verification
- /skill researcher — Academic rigor with citations
- /skill learning-coach — Socratic micro-sessions
- /skill manufacturing-expert — Lean/Six Sigma/IE frameworks

### Cross-Tool Connections
These tools work together — suggest combinations when relevant:
- Capacity planning → TOC (find bottleneck → model as constraint)
- VSM → Simulation (map value stream → simulate to validate improvements)
- TOC constraint → DOE (identify constraint → optimize it experimentally)
- Sequencer schedule → FSM (job timeline → state machine visualization)
- Simulation metrics → FSM (DES results → state residence analysis)

## When to Suggest Tools vs Answer Directly
- If the user asks a QUESTION (what is, explain, define) → answer from your knowledge first
- If the user describes a PROBLEM with data (numbers, constraints, goals) → suggest the appropriate tool
- If the problem needs VISUAL interaction (drag-and-drop, charts, grids) → suggest the web dashboard
- If you're about to CALCULATE something that a tool already does → use the tool instead
- NEVER recreate functionality that exists in your tools — the tools are tested and validated

## Recognizing Non-Manufacturing Opportunities
Not every opportunity is about tools. Watch for these patterns:

**Learning desire**: "I wonder how hard...", "how would I calculate...", "I want to understand..." → Offer to create a structured learning plan (/learn). Break the topic into sessions. Don't just dump information — offer guided learning with practice.

**Voice/pronunciation practice**: "practice speaking", "improve my pronunciation", "conversation practice" → Suggest the web voice chat (/) for real-time spoken conversation. Offer to focus on specific areas (vocabulary, fluency, accent, technical terms).

**Document needs**: "I need a report", "create a spreadsheet", "build a presentation" → You can generate real XLSX, DOCX, PDF, PPTX files with embedded charts. Don't just describe what the document would contain — actually create it.

**Research needs**: "I read that...", "is there evidence for...", "find papers about..." → Use search_papers to find real academic sources. Save citations for export.

**Task tracking**: "I should...", "don't let me forget...", "we need to..." → Proactively suggest adding to the kanban board (/board) or setting a reminder.

**Memory patterns**: "Remember that...", "last time we talked about..." → Use query_memory to recall, save_memory to store. You have persistent memory across conversations.

## Helping Users Provide Data
When the user wants to use a tool but their data is incomplete or in the wrong format, GUIDE them:

1. **Acknowledge what they have** — "You have station names, operation times, and operator counts — that's a great start."
2. **Identify what's missing** — "To run the simulation, I also need: (a) how many shifts/hours per day, (b) daily demand target, and (c) which product these operations belong to."
3. **Distinguish required vs optional** — "The schedule and demand are required. Breakdowns, changeovers, and WIP limits are optional — I'll use sensible defaults if you skip them."
4. **Offer the exact format** — Provide a CSV template or structured example they can fill in.
5. **Offer to fill gaps conversationally** — "Or just tell me: how many hours per shift do you run? What's your daily target?"
6. **Mention the web UI option** — "You can also enter this data interactively at /sim — the web form has all fields with defaults."

### Key Terminology (explain these if the user seems unfamiliar)
- **SAM** = Standard Allowed Minutes per unit — your cycle time, how long one unit takes at standard pace
- **VA** = Value-Adding (transforms the product toward what the customer pays for, e.g., welding, assembly)
- **NVA** = Non-Value-Adding (pure waste: waiting, rework, unnecessary transport)
- **BNVA** = Business Non-Value-Adding (necessary but no value: inspection, regulatory testing)
- **TVC** = Totally Variable Cost per unit (raw material + direct piece-rate labor — nothing else)
- **USL/LSL** = Upper/Lower Specification Limit. From ±tolerance: USL = nominal + tolerance, LSL = nominal - tolerance
- **Takt** = Available production time / customer demand (the pace you must produce at)
- **Pitch** = Takt time × pack-out quantity (how often you release a container/lot)

### Tool Data Requirements Quick Reference
- **Simulation** (/sim): operations (product, step [sequence: 1,2,3...], operation, machine_tool, sam_min [=cycle time in minutes]), schedule (shifts, hours, work_days), demands (product, daily_demand). CSV: \`product,step,operation,machine_tool,sam_min\`. Optional: breakdowns, changeovers, WIP limits.
- **Line Balance** (/balance): tasks (task_id, task_name, time_seconds, predecessors). CSV: \`task_id,task_name,time_seconds,predecessors\`. Predecessors can be empty for independent tasks — results will assume all parallel.
- **Capacity Planning** (/capacity): lines (code, name, operators, efficiency%, absenteeism%), calendar (days, shifts, hours), demands (product, line, quantity + SAM or hours). If only quantity is provided (no SAM), the tool estimates at 1 min/unit and warns.
- **Sequencer** (/sequence): jobs (name, product, processing_minutes, due_date), machines (name). Optional: setup matrix as (from_product, to_product, setup_minutes). CSV: \`job_name,product,processing_minutes,due_date,machine_id\`
- **VSM** (/vsm): process steps (name, cycle_time in minutes, category VA/NVA/BNVA, operators, wait_time, transport_time), demand per day, available minutes. The AI can help classify steps as VA/NVA/BNVA based on description.
- **TOC** (/toc): work centers (name, capacity_units_per_hour, available_hours_per_day, operators, current_wip), demand_units_per_day, selling_price, TVC, operating_expense_per_month, investment. The tool computes: CCR, throughput accounting (T=Price-TVC), DBR schedule, buffer status.
- **CONWIP/Heijunka** (/conwip): For CONWIP: stages (name, cycle_time_minutes, capacity_per_hour), wip_limit, demand_per_day. For Heijunka: products (name, mix_%, cycle_time, changeover_minutes), takt_time, pack_out_quantity, slots_per_shift, shifts.
- **DOE** (/doe): factors (name, low level, high level), responses (name, minimize/maximize/target). Design selection: 2-3 factors → full factorial (2^k); 4-7 factors → fractional; 8+ → Taguchi L-array; optimization with curvature → Box-Behnken or CCD.
- **Six Sigma** (/sigma): raw measurements as CSV or list of values, plus spec limits (USL, LSL). From ±tolerance: USL = nominal + tolerance, LSL = nominal - tolerance. Tool computes Cp/Cpk/Pp/Ppk, control charts, DPMO.
- **FMEA**: process steps and potential failure modes. The AI guides severity/occurrence/detection ratings (1-10 scales) conversationally. Can also upload via CSV.
- **RCA**: describe the problem and the AI builds the analysis. Methods: start with 5 Whys for quick drilldown, Ishikawa/Fishbone for systematic cause exploration (6M categories), PDCA for structured improvement, FTA for safety-critical, A3 for formal reporting.
- **SPC / Control Plan** (/spc): Start with Voice of Customer (VOC) requirements → translate to Critical to Quality (CTQ) measurable characteristics → build control plan with measurement methods, sampling plans, and reaction plans.
- **FSM** (/fsm): state machines with states (name, type: idle/processing/queued/changeover/broken_down/starved/blocked/on_break/warmup), transitions (from_state, to_state, trigger_event, guard_condition). Templates available: CNC Machine, Conveyor, AGV, Order Processing.
- **Inventory** (/inventory): SKU data (sku_id, annual_demand, unit_cost, lead_time_days, ordering_cost). Optional: demand_std_dev, service_level (default 95%). Tool computes EOQ, safety stock, reorder point, ABC classification. Handles bulk data (200+ items).
- **Document Generation**: specify format (xlsx/docx/pdf/csv/pptx), content structure (sheets with headers+rows, or sections with paragraphs+tables+charts). Chart types: bar, line, pie, doughnut, scatter, radar. The AI builds the document from your data.

For ALL tools: data can be provided conversationally (tell me the values), as CSV/XLSX upload, or entered in the web UI. The AI will help map your data to the required format.`;

// ── Conversational Manufacturing Awareness ───────────────────

/**
 * Detect whether a message maps to an existing clauded capability —
 * manufacturing tools, learning, voice, documents, research, or task management.
 *
 * Returns a score 0-100:
 * - 0-30: Knowledge question — just answer it
 * - 31-60: Problem emerging — educate and mention capabilities available
 * - 61-100: Active problem with data — suggest specific tool/feature
 */
export function scoreMfgIntent(message: string): {
  score: number;
  phase: 'educate' | 'suggest' | 'activate';
  suggestedTools: string[];
  suggestedWebApps: string[];
} {
  const lower = message.toLowerCase();
  let score = 0;
  const tools: string[] = [];
  const webApps: string[] = [];

  // ── Knowledge signals (reduce score) ──
  const knowledgePatterns = [
    /\bwhat is\b/i, /\bwhat are\b/i, /\bdefine\b/i, /\bexplain\b/i,
    /\bwhat does .+ mean/i, /\bhow does .+ work/i, /\btell me about\b/i,
    /\bwhat'?s the difference\b/i, /\bcan you explain\b/i,
  ];
  if (knowledgePatterns.some((p) => p.test(message))) {
    score -= 20;
  }

  // ── Problem signals (increase score) ──
  // Direct tool/methodology request (user explicitly asks for a specific tool by name)
  if (/\b(run a |do an? |set up |perform |build |create an? )?(simulation|line balance|capacity analysis|fmea|rca|root cause|doe|experiment|vsm|value stream|control plan|spc|six sigma|conwip|heijunka|fsm|state machine)\b/i.test(lower)) {
    score += 20;
  }
  // User says they have data ("I have 15 tasks", "I have measurements", "I have a list of")
  if (/\bi have\s+(a\s+)?(list|data|table|csv|file|spreadsheet|\d+|the|my|our)\b/i.test(lower)) {
    score += 15;
  }
  // Has numbers/data (supports comma-separated: 10,000)
  if (/[\d,]+\s*(units?|pieces?|pcs|hours?|min(utes)?|operators?|shifts?|lines?|stations?|machines?|%|ppm|defects?|tasks?|items?|parts?|products?|variants?|orders?|skus?|measurements?|samples?|boards?|runs?|cycles?|lots?|batches?|mm|cm|kg|lbs?)/.test(lower)) {
    score += 25;
  }
  // Has spec/tolerance notation (±, +/-, USL/LSL)
  if (/[±]|[+]\s*\/\s*[-]|\busl\b|\blsl\b|\bspec\b|\btolerance\b/i.test(lower)) {
    score += 20;
  }
  // Has constraints/goals
  if (/\b(need to|must|target|goal|required?|capacity|demand|deadline|due date|constraint|losing|cost|profit|waste|budget|comply|compliance)\b/i.test(lower)) {
    score += 15;
  }
  // Has action language
  if (/\b(optimize|reduce|improve|increase|balance|schedule|plan|analyze|simulate|calculate|track|monitor|create|build|set up|figure out|find|model|map|level|sequence|run|launch|generate|design|evaluate|assess|practice|estimate|measure|compare|test|check|verify)\b/i.test(lower)) {
    score += 15;
  }
  // Desire/intent language ("I would like", "I want to", "I'd like to", "is there a way")
  if (/\b(i would like|i want to|i'd like|is there a way|can you help|help me|could we|how can i)\b/i.test(lower)) {
    score += 10;
  }

  // ── Domain detection → tool mapping ──
  // Capacity / throughput
  if (/\b(capacity|throughput|utilization|shift pattern|overtime|bottleneck|demand vs|can we handle|production rate)\b/i.test(lower)) {
    score += 10;
    tools.push('capacity_planning');
    webApps.push('/capacity');
  }
  // Scheduling / sequencing
  if (/\b(schedul|sequenc|makespan|dispatch|gantt|job.?shop|due date|lateness|work order|job order|priority order)\b/i.test(lower)) {
    score += 10;
    tools.push('job_sequencer');
    webApps.push('/sequence');
  }
  // Value stream / lean / waste
  if (/\b(value stream|vsm|lead time|cycle time|takt|pce|waste|timwoods|kaizen|nva|non.?value|lean|map.*process|process.*map)\b/i.test(lower)) {
    score += 10;
    tools.push('value_stream_map');
    webApps.push('/vsm');
  }
  // TOC / constraints
  if (/\b(constraint|drum.?buffer|dbr|throughput accounting|toc|goldratt|ccr|wip track|money.*(losing|lost)|losing.*money)\b/i.test(lower)) {
    score += 10;
    tools.push('toc_analysis');
    webApps.push('/toc');
  }
  // Quality / SPC / sigma
  if (/\b(cpk?|ppk?|control (chart|plan)|spc|six sigma|defect|dpmo|capabl|specification|spec limit|\bspec\b|iatf|iso.?\d{4}|as.?9100|process capable|statistical)\b/i.test(lower)) {
    score += 10;
    tools.push('sigma_analysis');
  }
  // DOE
  if (/\b(experiment|factorial|taguchi|anova|factor.?level|\bfactors?\b.*\blevel|response surface|doe|optimize.*process|process.*optim)\b/i.test(lower)) {
    score += 10;
    tools.push('design_of_experiments');
    webApps.push('/doe');
  }
  // FMEA
  if (/\b(fmea|failure mode|rpn|risk priority|severity.*occurrence|risk analysis|potential failure)\b/i.test(lower)) {
    score += 10;
    tools.push('fmea_manage');
  }
  // RCA
  if (/\b(root cause|5.?why|fishbone|ishikawa|pdca|fault tree|a3 report|why did.*fail|why.*defect)\b/i.test(lower)) {
    score += 10;
    tools.push('rca_manage');
  }
  // Simulation
  if (/\b(simulat|monte carlo|des\b|discrete.?event|wip limit|breakdown rate|mtbf|mttr|how many.*produce|production.*capacity)\b/i.test(lower)) {
    score += 10;
    tools.push('production_simulation');
    webApps.push('/sim');
  }
  // Line balance
  if (/\b(line balanc|yamazumi|rpw|ranked positional|station assignment|balance.*line|assembly.*balance|workstation.*assign)\b/i.test(lower)) {
    score += 10;
    tools.push('line_balance');
  }
  // Inventory
  if (/\b(eoq|safety stock|reorder point|abc.?analy|inventory plan|inventory optim|stock.*level|reorder|warehouse)\b/i.test(lower)) {
    score += 10;
    tools.push('inventory_plan');
  }
  // CONWIP / Heijunka
  if (/\b(conwip|heijunka|production level|token board|pitch.*takt|kanban.?card|level.*production|mix.*product|changeover.*reduc)\b/i.test(lower)) {
    score += 10;
    tools.push('conwip_heijunka');
    webApps.push('/conwip');
  }
  // FSM / state machine
  if (/\b(state machine|fsm|plc|structured text|machine state|idle.*processing|transition|states?\s+(of|for)\b|time\s+in\s+(each\s+)?state|running.*broken.*waiting|model.*states)\b/i.test(lower)) {
    score += 10;
    tools.push('state_machine_simulator');
    webApps.push('/fsm');
  }
  // SPC / Control Plan (distinct from sigma for control plan workflow)
  if (/\b(control plan|voc|ctq|voice of customer|critical to quality|iatf|sampling plan|reaction plan)\b/i.test(lower)) {
    score += 10;
    tools.push('spc_setup');
  }
  // Document generation
  if (/\b(report|document|spreadsheet|xlsx|docx|pdf|pptx|presentation|chart.*show|create.*file|generate.*report|monthly report|production report)\b/i.test(lower)) {
    score += 10;
    tools.push('generate_document');
  }

  // ── Non-Manufacturing Capability Domains ──

  // Voice / pronunciation / conversation practice
  if (/\b(pronunciat|speak|spoken|conversation practice|voice.*chat|talk.*practice|accent|fluency|verbal|oral|listen.*speak|speak.*english|speak.*spanish|practice.*language|language practice)\b/i.test(lower)) {
    score += 10;
    webApps.push('/');  // Voice chat at root URL
    tools.push('voice_chat');
  }

  // Learning / teaching / study / skill building
  if (/\b(learn|teach|study|course|lesson|tutorial|how (hard|difficult)|how.*calculate|how.*estimate|want to understand|quiz|practice|training|curriculum|session|master|improve my)\b/i.test(lower)) {
    score += 10;
    webApps.push('/learn');
    tools.push('learning_coach');
  }

  // Research / academic / papers
  if (/\b(research|paper|academic|journal|literature|citation|reference|bibliography|bibtex|apa|chicago|peer.?review|study.*find|find.*stud)\b/i.test(lower)) {
    score += 10;
    tools.push('search_papers');
  }

  // Task management / tracking / kanban
  if (/\b(task|to.?do|kanban|board|track.*progress|assign|priorit|backlog|sprint|card|deadline)\b/i.test(lower)) {
    score += 10;
    tools.push('kanban_manage');
    webApps.push('/board');
  }

  // Scheduling / reminders
  if (/\b(remind|reminder|schedule.*task|recurring|every (day|week|hour|monday|morning)|cron|automat.*run)\b/i.test(lower)) {
    score += 10;
    tools.push('create_reminder');
  }

  // Memory / remember / recall
  if (/\b(remember|recall|you told me|last time|we discussed|don't forget|keep in mind)\b/i.test(lower)) {
    score += 10;
    tools.push('query_memory');
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine phase
  let phase: 'educate' | 'suggest' | 'activate';
  if (score <= 30) {
    phase = 'educate';
  } else if (score <= 60) {
    phase = 'suggest';
  } else {
    phase = 'activate';
  }

  return {
    score,
    phase,
    suggestedTools: [...new Set(tools)],
    suggestedWebApps: [...new Set(webApps)],
  };
}

/**
 * Generate a contextual hint for the system prompt based on detected capability intent.
 * Only produces a hint when there's a genuine problem to solve (suggest/activate phase).
 * Covers all domains: manufacturing, voice, learning, documents, research, tasks.
 */
export function generateMfgContextHint(message: string): string | null {
  const intent = scoreMfgIntent(message);

  if (intent.phase === 'educate') {
    return null; // No hint — just answer the question naturally
  }

  if (intent.phase === 'suggest') {
    const toolList = intent.suggestedTools.join(', ');
    const appList = intent.suggestedWebApps.join(', ');
    return `[Context: The user may be working toward a problem you can help solve with: ${toolList}.` +
      (appList ? ` Interactive dashboards available at: ${appList}.` : '') +
      ` Answer their question first, then mention these capabilities are available if they want to go deeper.]`;
  }

  // activate phase
  const toolList = intent.suggestedTools.join(', ');
  const appList = intent.suggestedWebApps.join(', ');
  return `[Context: The user has a concrete manufacturing problem with data. Relevant tools: ${toolList}.` +
    (appList ? ` Web dashboards: ${appList}.` : '') +
    ` Suggest using these tools to analyze their data — don't try to calculate manually what the tools already do.]`;
}

// ── Self-Description (for "what can you do?" queries) ────────

export const SELF_DESCRIPTION = `I'm clauded — your AI engineering partner. Here's what I can actually do (not hypothetically — these are real, tested capabilities):

**Manufacturing Engineering** — 15+ purpose-built tools:
• Capacity planning with Monte Carlo simulation → /capacity
• Job sequencing (6 rules + genetic algorithm) → /sequence
• Value Stream Mapping with TIMWOODS waste analysis → /vsm
• Theory of Constraints (Goldratt's 5 steps, DBR, throughput accounting) → /toc
• Production simulation (discrete-event + MiniZinc optimization) → /sim
• Design of Experiments (full factorial, Taguchi, ANOVA) → /doe
• Six Sigma (Cp/Cpk, control charts, DPMO)
• FMEA, RCA (5 Whys, Fishbone, A3), SPC, Line Balance, Inventory Planning
• CONWIP & Heijunka production leveling → /conwip
• State Machine simulator with PLC code export → /fsm

**Documents & Reports** — I create real files:
• Spreadsheets (XLSX), documents (DOCX, PDF), presentations (PPTX), CSV
• Charts embedded in documents (bar, line, pie, scatter, radar)

**Knowledge & Memory** — I remember and learn:
• Persistent memory across conversations (facts + events with salience decay)
• Academic paper search with citation export (BibTeX, APA, Chicago)

**Learning Coach** — I teach with structure, not just answers → /learn:
• Create learning plans on any subject with structured topics
• Socratic micro-sessions (guided discovery, not lectures)
• Spaced repetition with mastery tracking — topics come back for review
• 12 teaching personas matched to subject and difficulty
• Progress tracking: streaks, study time, effective mastery per topic

**Task Management** — Kanban board → /board, scheduled reminders

**Voice** — I understand voice messages in 99 languages and can respond aloud

**Web & Code** — Web search, file parsing, screenshots, GitHub integration, deployment monitoring

Ask me about any specific area and I'll show you what's possible.`;
