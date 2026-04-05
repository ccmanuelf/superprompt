/**
 * Conversational Pack Builder — AI-guided pack creation.
 *
 * When a user says "I need a pack for quality engineering" or uses
 * "/pack create quality-engineering", the AI guides them through
 * creating a complete pack with tools, skills, and intent patterns.
 *
 * Uses the same AI-as-author pattern as auto-skills:
 * the LLM drafts the pack content, user approves.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { PROJECT_ROOT } from './config.js';
import type { ProviderRouter } from './providers/router.js';

const PACKS_DIR = resolve(PROJECT_ROOT, 'packs');

// ── Types ────────────────────────────────────────────────────

export interface PackBlueprint {
  name: string;
  displayName: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
    code: string;
  }>;
  skillName?: string;
  skillPrompt?: string;
  intentPatterns: string[];
  departments: string[];
}

// ── Conversational Builder ───────────────────────────────────

/**
 * Use AI to generate a complete pack blueprint from a natural language description.
 *
 * @param userDescription What the user wants (e.g., "quality engineering tools for audits and inspections")
 * @param router AI provider router
 * @param chatId Chat ID for the AI call
 * @returns PackBlueprint or null if generation failed
 */
export async function generatePackBlueprint(
  userDescription: string,
  router: ProviderRouter,
  chatId: string,
): Promise<PackBlueprint | null> {
  const metaprompt = `You are creating a capability pack for an AI assistant platform.
The user wants: "${userDescription}"

Generate a complete pack definition as JSON. Each tool should have working JavaScript code.
The code runs in a sandboxed environment with only 'args' and 'fetch()' available.
Tools should be practical and immediately useful.

Return ONLY valid JSON:
{
  "name": "short-lowercase-kebab-name",
  "displayName": "Human Readable Name",
  "description": "2-3 sentence description of what this pack does",
  "tools": [
    {
      "name": "tool_name_snake_case",
      "description": "What this tool does (one sentence)",
      "parameters": [
        { "name": "param_name", "type": "string|number|object", "description": "What this param is", "required": true }
      ],
      "code": "const result = args.param_name; return { result };"
    }
  ],
  "skillName": "optional-skill-name",
  "skillPrompt": "Optional system prompt for a domain expert skill. Omit if not needed.",
  "intentPatterns": ["regex pattern 1", "regex pattern 2"],
  "departments": ["department1", "department2"]
}

Generate 1-3 practical tools. Each tool should solve a real problem.
Intent patterns should be regex strings (without / delimiters) that match when users discuss this domain.`;

  try {
    const response = await router.sendMessage({
      message: metaprompt,
      chatId,
      skipTools: true,
      skipAutoTrigger: true,
    });

    if (!response.text) return null;

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.name || !parsed.tools || !Array.isArray(parsed.tools)) return null;

    return {
      name: String(parsed.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64),
      displayName: String(parsed.displayName || parsed.name),
      description: String(parsed.description || ''),
      tools: parsed.tools.map((t: Record<string, unknown>) => ({
        name: String(t.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        description: String(t.description || ''),
        parameters: Array.isArray(t.parameters) ? t.parameters : [],
        code: String(t.code || 'return { error: "Not implemented" };'),
      })),
      skillName: parsed.skillName ? String(parsed.skillName) : undefined,
      skillPrompt: parsed.skillPrompt ? String(parsed.skillPrompt) : undefined,
      intentPatterns: Array.isArray(parsed.intentPatterns) ? parsed.intentPatterns.map(String) : [],
      departments: Array.isArray(parsed.departments) ? parsed.departments.map(String) : [],
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to generate pack blueprint');
    return null;
  }
}

/**
 * Format a pack blueprint as a bilingual proposal for user approval.
 */
export function formatPackProposal(blueprint: PackBlueprint): string {
  const toolList = blueprint.tools.map((t) => `  - **${t.name}**: ${t.description}`).join('\n');
  const deptList = blueprint.departments.length > 0
    ? blueprint.departments.join(', ')
    : 'all departments';

  return [
    `[EN] I've designed a pack based on your request:`,
    `**Name:** ${blueprint.displayName} (\`${blueprint.name}\`)`,
    `**Description:** ${blueprint.description}`,
    `**Tools:**`,
    toolList,
    blueprint.skillName ? `**Skill:** ${blueprint.skillName}` : '',
    `**Departments:** ${deptList}`,
    `**Triggers:** ${blueprint.intentPatterns.length} patterns`,
    ``,
    `Reply "create" to build this pack, or describe changes you'd like.`,
    ``,
    `[ES] He disenado un pack basandome en tu solicitud:`,
    `**Nombre:** ${blueprint.displayName} (\`${blueprint.name}\`)`,
    `**Descripcion:** ${blueprint.description}`,
    `**Herramientas:**`,
    toolList,
    blueprint.skillName ? `**Habilidad:** ${blueprint.skillName}` : '',
    `**Departamentos:** ${deptList}`,
    `**Disparadores:** ${blueprint.intentPatterns.length} patrones`,
    ``,
    `Responde "crear" para construir este pack, o describe los cambios que deseas.`,
  ].filter(Boolean).join('\n');
}

/**
 * Detect user's response to a pack creation proposal.
 */
export function detectPackCreationResponse(message: string): 'create' | null {
  const lower = message.trim().toLowerCase();
  if (lower.split(/\s+/).length > 3) return null;

  if (/^(create|crear|build|construir|yes|si|sí|ok|go|dale)$/i.test(lower)) return 'create';
  return null;
}

/**
 * Build a complete pack from a blueprint — creates all files on disk.
 */
export function buildPackFromBlueprint(blueprint: PackBlueprint): string {
  const packDir = resolve(PACKS_DIR, blueprint.name);

  if (existsSync(packDir)) {
    throw new Error(`Pack "${blueprint.name}" already exists`);
  }

  mkdirSync(resolve(packDir, 'tools'), { recursive: true });
  mkdirSync(resolve(packDir, 'skills'), { recursive: true });
  mkdirSync(resolve(packDir, 'templates'), { recursive: true });

  // ── pack.yaml ──
  const intentYaml = blueprint.intentPatterns.map((p) =>
    `  - pattern: "${p.replace(/"/g, '\\"')}"\n    score_boost: 10\n    tools: [${blueprint.tools.map((t) => t.name).join(', ')}]\n    web_apps: []`,
  ).join('\n');

  const yamlContent = `name: ${blueprint.name}
display_name: "${blueprint.displayName}"
description: "${blueprint.description}"
version: "0.1.0"
author: "auto-generated"
enabled: true
level: 2

departments:
${blueprint.departments.map((d) => `  - ${d}`).join('\n')}

capabilities: |
  ### ${blueprint.displayName}
  ${blueprint.description}
  Tools: ${blueprint.tools.map((t) => t.name).join(', ')}

self_description: |
  **${blueprint.displayName}** — ${blueprint.description}

intent_patterns:
${intentYaml}

commands: []
`;

  writeFileSync(resolve(packDir, 'pack.yaml'), yamlContent);

  // ── Tool .md files ──
  for (const tool of blueprint.tools) {
    const params = tool.parameters.map((p) =>
      `  - name: ${p.name}\n    type: ${p.type}\n    description: "${p.description}"\n    required: ${p.required}`,
    ).join('\n');

    const toolMd = `---
name: ${tool.name}
description: "${tool.description}"
type: generated_code
parameters:
${params}
---
\`\`\`javascript
${tool.code}
\`\`\`
`;
    const filename = tool.name.replace(/_/g, '-') + '.md';
    writeFileSync(resolve(packDir, 'tools', filename), toolMd);
  }

  // ── Skill .md file (optional) ──
  if (blueprint.skillName && blueprint.skillPrompt) {
    const skillMd = `---
name: ${blueprint.skillName}
description: "Domain expert for ${blueprint.displayName}"
---
${blueprint.skillPrompt}
`;
    writeFileSync(resolve(packDir, 'skills', `${blueprint.skillName}.md`), skillMd);
  }

  // ── README.md ──
  const readme = `# ${blueprint.displayName}

${blueprint.description}

## Tools

${blueprint.tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n')}

## Usage

This pack is automatically loaded on startup. Use \`/pack info ${blueprint.name}\` for details.

Generated by clauded's conversational pack builder.
`;
  writeFileSync(resolve(packDir, 'README.md'), readme);

  logger.info(
    { pack: blueprint.name, tools: blueprint.tools.length },
    'Pack created from blueprint',
  );

  return packDir;
}

// ── Pending Blueprints (per-chat state) ──────────────────────

const pendingBlueprints = new Map<string, PackBlueprint>();

export function setPendingBlueprint(chatId: string, blueprint: PackBlueprint): void {
  pendingBlueprints.set(chatId, blueprint);
}

export function getPendingBlueprint(chatId: string): PackBlueprint | null {
  return pendingBlueprints.get(chatId) ?? null;
}

export function clearPendingBlueprint(chatId: string): void {
  pendingBlueprints.delete(chatId);
}

// ── Pack Guide ───────────────────────────────────────────────

/**
 * Generate the in-app pack development guide (bilingual EN/ES).
 */
export function getPackGuide(): string {
  return `[EN] **Pack Development Guide**

Packs are capability modules that extend clauded with department-specific tools, skills, and templates.

**3 Levels:**
- **Level 1** (Data): \`pack.yaml\` + \`templates/\` — reference data, no tools
- **Level 2** (Tools): + \`tools/*.md\` + \`skills/*.md\` — YAML-defined tools with generated code
- **Level 3** (Full): + \`src/\` + \`web/\` + \`api/\` — TypeScript source, dashboards, API routes

**Create a Pack:**
- Conversational: "I need a pack for [description]" → AI designs and builds it
- Command: \`/pack create <name>\` → scaffolds empty structure
- Manual: create \`packs/<name>/pack.yaml\` + \`tools/*.md\`

**Share Between Departments:**
- \`/pack enable <name>\` — enable any pack for your department
- \`/pack disable <name>\` — disable a pack you don't need
- Packs are capabilities, not department property — anyone can use any pack

**Tool Format (tools/*.md):**
\`\`\`
---
name: my_tool
description: What it does
type: generated_code
parameters:
  - name: input
    type: string
    description: Input value
    required: true
---
\\${'```'}javascript
return { result: args.input };
\\${'```'}
\`\`\`

---

[ES] **Guia de Desarrollo de Packs**

Los packs son modulos de capacidad que extienden clauded con herramientas, habilidades y plantillas especificas por departamento.

**3 Niveles:**
- **Nivel 1** (Datos): \`pack.yaml\` + \`templates/\` — datos de referencia, sin herramientas
- **Nivel 2** (Herramientas): + \`tools/*.md\` + \`skills/*.md\` — herramientas definidas en YAML
- **Nivel 3** (Completo): + \`src/\` + \`web/\` + \`api/\` — codigo TypeScript, dashboards, rutas API

**Crear un Pack:**
- Conversacional: "Necesito un pack para [descripcion]" → la IA lo disena y construye
- Comando: \`/pack create <nombre>\` → genera estructura vacia
- Manual: crear \`packs/<nombre>/pack.yaml\` + \`tools/*.md\`

**Compartir Entre Departamentos:**
- \`/pack enable <nombre>\` — habilitar cualquier pack para tu departamento
- \`/pack disable <nombre>\` — deshabilitar un pack que no necesitas
- Los packs son capacidades, no propiedad de un departamento — cualquiera puede usar cualquier pack`;
}
