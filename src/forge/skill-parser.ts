import { logger } from '../logger.js';

export interface ParsedSkill {
  name: string;
  description: string;
  tools: string[] | null;
  systemPrompt: string;
}

export interface SkillParseError {
  error: string;
}

/**
 * Parse a markdown file with YAML frontmatter into a skill definition.
 *
 * Expected format:
 * ```
 * ---
 * name: pirate
 * description: Responds in pirate speak
 * tools: [query_memory, save_memory]
 * ---
 * You are a pirate captain...
 * ```
 */
export function parseSkillMarkdown(
  content: string,
): ParsedSkill | SkillParseError {
  const trimmed = content.trim();

  // Must start with ---
  if (!trimmed.startsWith('---')) {
    return { error: 'Missing YAML frontmatter (file must start with ---)' };
  }

  // Find closing ---
  const secondDash = trimmed.indexOf('---', 3);
  if (secondDash === -1) {
    return { error: 'Missing closing --- for YAML frontmatter' };
  }

  const frontmatter = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 3).trim();

  // Parse YAML-like key-value pairs (simple regex-based, no dependency)
  const fields = parseSimpleYaml(frontmatter);

  if (!fields.name) {
    return { error: 'Missing required field: name' };
  }
  if (!fields.description) {
    return { error: 'Missing required field: description' };
  }
  if (!body) {
    return { error: 'Missing system prompt body (after frontmatter)' };
  }

  // Parse tools array
  let tools: string[] | null = null;
  if (fields.tools) {
    tools = parseToolsList(fields.tools);
    if (!tools) {
      return { error: 'Invalid tools format. Use: tools: [tool1, tool2]' };
    }
  }

  return {
    name: fields.name.toLowerCase().trim(),
    description: fields.description.trim(),
    tools,
    systemPrompt: body,
  };
}

/**
 * Simple YAML parser for flat key-value pairs.
 * Handles: `key: value`, `key: "quoted value"`, `key: [array, items]`
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of yaml.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    let value = trimmedLine.slice(colonIdx + 1).trim();

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Parse a YAML-style array string like `[tool1, tool2, tool3]` into string[].
 */
function parseToolsList(value: string): string[] | null {
  const trimmed = value.trim();

  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  return inner.split(',').map((item) => {
    let cleaned = item.trim();
    // Strip quotes
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }
    return cleaned;
  }).filter(Boolean);
}
