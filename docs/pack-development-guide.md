# Pack Development Guide

**Version:** v1.0.0-rc.95 — last refreshed 2026-04-27. Pack format stable from rc.20 onward; no breaking changes in rc.95.

## What are Packs?

Packs are capability modules that extend Luna with department-specific tools, skills, and templates. They're the building blocks of the platform — each department enables the packs they need, and any pack can be shared across departments.

> **Packs vs. built-in features:** if you're adding a department-shareable capability, build a pack (this guide). If you're adding a built-in feature that ships with Luna for *all* deployments (like the attendance reconciliation pilot under `src/attendance/`), that's a different code path — it lives directly under `src/`, registers a `TableInitializer` via `storage.registerTables()` in `src/index.ts`, and uses the feature-awareness registry (`src/core/feature-awareness.ts` + per-feature `awareness.ts`). See [`ONBOARDING.md`](./ONBOARDING.md) §6 for that path. Most external work is packs, not built-in features.

## Pack Levels

### Level 1 — Data Pack
```
packs/my-pack/
  pack.yaml       # Metadata, description
  templates/      # Reference files (CSV, Excel)
```
Use for: reference data, example files, templates.

### Level 2 — Tool Pack
```
packs/my-pack/
  pack.yaml       # Metadata + capabilities + intent patterns
  tools/*.md      # Tool definitions with generated code
  skills/*.md     # AI skill personas
  templates/      # Reference files
```
Use for: department tools, calculators, analyzers. Most common level.

### Level 3 — Full Module
```
packs/my-pack/
  pack.yaml       # Metadata
  src/            # TypeScript source code
    index.ts      # Barrel export (TableInitializer, registerTools)
  tools/          # Tool definitions
  skills/         # Skill definitions
  web/            # Dashboard HTML/JS
  api/            # API route handlers
  tests/          # Pack-specific tests
  templates/      # Reference files
```
Use for: complex modules with databases, web dashboards, API routes. Example: manufacturing pack.

## Creating a Pack

### Method 1: Conversational (Recommended)
Just tell Luna what you need:
```
"I need a pack for quality engineering with audit checklists and inspection planning"
```
The AI will design the pack, show you a proposal, and build it on approval.

### Method 2: Command
```
/pack create my-pack-name
```
Scaffolds an empty Level 2 structure with template files.

### Method 3: Manual
Create `packs/<name>/pack.yaml` and `tools/*.md` files following the format below.

## pack.yaml Format

```yaml
name: my-pack
display_name: "My Pack"
description: "What this pack does"
version: "0.1.0"
author: "your name"
enabled: true
level: 2

departments:
  - manufacturing
  - engineering

capabilities: |
  Description of tools for the AI system prompt.
  The AI reads this to know when to use your tools.

self_description: |
  What the AI tells users about this pack's capabilities.

intent_patterns:
  - pattern: "\\b(keyword1|keyword2)\\b"
    score_boost: 10
    tools: [my_tool]
    web_apps: []

commands:
  - name: mycommand
    description: What /mycommand does
```

## Tool Definition Format (tools/*.md)

```markdown
---
name: my_tool_name
description: "What this tool does (one sentence)"
type: generated_code
parameters:
  - name: input_value
    type: number
    description: "The input value"
    required: true
  - name: option
    type: string
    description: "Optional setting"
    required: false
---
```javascript
// Available: args (parameters), fetch() (HTTP client), heartbeat() (for long tasks)
const result = args.input_value * 2;
const option = args.option || 'default';
return { result, option, calculated: true };
```
```

## Sharing Packs Between Departments

Packs are capabilities, not department property. Any department can enable any pack:

```
/pack list              — show all packs with enabled/disabled status
/pack enable finance    — enable the finance pack for your department
/pack disable manufacturing — disable manufacturing tools you don't need
/pack info my-pack      — show pack details
```

## Best Practices

1. **One concern per pack** — a "quality" pack, not a "quality + finance + HR" pack
2. **Clear intent patterns** — help the AI know when to suggest your tools
3. **Practical tools** — each tool should solve a real problem, not be a demo
4. **Bilingual descriptions** — consider EN/ES users in descriptions
5. **Start Level 2, upgrade to Level 3** — only add TypeScript source when you need DB tables or web dashboards
6. **Pack names must be globally unique** (rc.102) — the loader rejects duplicates and logs a clear error rather than silently shadowing by filesystem order. If `pack.yaml.name` collides with an already-loaded pack, the second one is skipped and never registered.

## Site-Adjusted Calculations & Pack Assumptions (rc.100 / rc.101)

If your pack's calculation logic touches any of the registered assumption names (cycle-time source, setup treatment, scrap rule, yield baseline, availability basis, Monte Carlo iterations, ROI hurdle, ROI horizon, default service level), you can ship pack-scoped overrides without writing code. Add an `assumptions.yaml` next to your `pack.yaml`:

```yaml
# packs/my-pack/assumptions.yaml
- assumption_name: roi_default_discount_rate
  value: 0.15
  rationale: "Our shop's WACC is 15%, not the textbook 10% default."
- assumption_name: default_service_level
  value: 0.99
  rationale: "Critical SKU policy — 99% in-stock probability."
```

The pack loader registers these at `pack` scope. When a user runs `/sigma --site-adjusted` (or any manufacturing command with the flag) and your pack is in their active pack list, your overrides apply via first-match-wins precedence (`user → pack → global → built-in default`). Users see the source scope in the `/explain` lineage page.

What your pack **cannot** change via this mechanism: the math itself. Calculation wrappers honor assumption overrides as **input substitutions only** — they never modify the underlying pure function. AIAG control-chart constants (d2, D4, Western Electric thresholds) are explicitly NOT registered as assumptions; they're standards, not knobs.

## Examples

See existing packs in the `packs/` directory:
- `manufacturing/` — Level 3, 15 tools, 8 web dashboards
- `finance/` — Level 2, 2 tools (NPV, budget variance)
- `hr/` — Level 2, 1 tool (PTO calculator)
- `engineering/` — Level 2, 1 tool (code review checklist)

## What You Can Build vs. What Needs the Software Team

### You (any department user) CAN build:
- **Level 1 packs:** Data templates, reference files
- **Level 2 packs:** Tools with calculation logic, API integrations, skills, intent patterns
- **Auto-skills:** Just use Luna — it learns automatically from complex workflows
- All of the above can be created **conversationally** with Luna's help

### The SOFTWARE TEAM must build:
- **Level 3 features:** Web dashboards (HTML/TypeScript), database schemas, custom Telegram commands
- **The manufacturing dashboards** (/sim, /capacity, /sequence, etc.) are Level 3 — they were built by developers
- If you want a similar-looking dashboard for your department, the **tools and logic** can be created conversationally, but the **visual web interface** requires developer expertise

### How to get a dashboard built:
1. Build your tools conversationally (Level 2) — these work immediately via chat
2. Ask Luna to draft requirements for the dashboard you want
3. Submit the requirements to the software team — they build the Level 3 web interface
4. Your Level 2 tools become the backend for the Level 3 dashboard
