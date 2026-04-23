# Pack Development Guide

## What are Packs?

Packs are capability modules that extend Luna with department-specific tools, skills, and templates. They're the building blocks of the platform — each department enables the packs they need, and any pack can be shared across departments.

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
