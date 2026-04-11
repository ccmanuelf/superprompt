import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import type { Skill, UserTool } from '../db-core.js';

const FORGE_DIR = resolve(PROJECT_ROOT, 'forge');
const SKILLS_DIR = resolve(FORGE_DIR, 'skills');
const TOOLS_DIR = resolve(FORGE_DIR, 'tools');

/**
 * Export a skill to a markdown file in forge/skills/.
 * Returns the file path.
 */
export function exportSkillToMarkdown(skill: Skill): string {
  mkdirSync(SKILLS_DIR, { recursive: true });

  let frontmatter = `name: ${skill.name}\ndescription: ${skill.description}`;

  if (skill.allowed_tools) {
    try {
      const tools = JSON.parse(skill.allowed_tools) as string[];
      frontmatter += `\ntools: [${tools.join(', ')}]`;
    } catch { /* skip tools if invalid */ }
  }

  const content = `---\n${frontmatter}\n---\n${skill.system_prompt}\n`;
  const filename = `${skill.name}.md`;
  const filepath = resolve(SKILLS_DIR, filename);

  writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Export a user tool to a markdown file in forge/tools/.
 * Returns the file path.
 */
export function exportToolToMarkdown(tool: UserTool): string {
  mkdirSync(TOOLS_DIR, { recursive: true });

  const config = JSON.parse(tool.config);
  const params = config.parameters || [];
  const endpoint = config.endpoint;
  const code = config.code;

  let frontmatter = `name: ${tool.name}\ndescription: ${tool.description}\ntype: ${tool.tool_type}`;

  // Parameters
  if (params.length > 0) {
    frontmatter += '\nparameters:';
    for (const p of params) {
      frontmatter += `\n  - name: ${p.name}`;
      frontmatter += `\n    type: ${p.type || 'string'}`;
      frontmatter += `\n    description: ${p.description || ''}`;
      frontmatter += `\n    required: ${p.required ? 'true' : 'false'}`;
    }
  }

  // Endpoint (for declarative_http)
  if (endpoint) {
    frontmatter += '\nendpoint:';
    frontmatter += `\n  method: ${endpoint.method}`;
    frontmatter += `\n  url: "${endpoint.url}"`;
    if (endpoint.query) {
      frontmatter += '\n  query:';
      for (const [k, v] of Object.entries(endpoint.query)) {
        frontmatter += `\n    ${k}: "${v}"`;
      }
    }
    if (endpoint.headers) {
      frontmatter += '\n  headers:';
      for (const [k, v] of Object.entries(endpoint.headers)) {
        frontmatter += `\n    ${k}: ${v}`;
      }
    }
    if (endpoint.response_path) {
      frontmatter += `\n  response_path: "${endpoint.response_path}"`;
    }
  }

  let content = `---\n${frontmatter}\n---\n`;

  // Code body (for generated_code)
  if (code) {
    content += `\`\`\`typescript\n${code}\n\`\`\`\n`;
  }

  const filename = `${tool.name}.md`;
  const filepath = resolve(TOOLS_DIR, filename);

  writeFileSync(filepath, content, 'utf-8');
  return filepath;
}
