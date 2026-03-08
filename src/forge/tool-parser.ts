import { logger } from '../logger.js';

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface DeclarativeHttpEndpoint {
  method: string;
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  response_path?: string;
}

export interface ParsedTool {
  name: string;
  description: string;
  type: 'declarative_http' | 'generated_code';
  parameters: ToolParameter[];
  endpoint?: DeclarativeHttpEndpoint;
  code?: string;
}

export interface ToolParseError {
  error: string;
}

/**
 * Parse a markdown file with YAML frontmatter into a tool definition.
 */
export function parseToolMarkdown(
  content: string,
): ParsedTool | ToolParseError {
  const trimmed = content.trim();

  if (!trimmed.startsWith('---')) {
    return { error: 'Missing YAML frontmatter (file must start with ---)' };
  }

  const secondDash = trimmed.indexOf('---', 3);
  if (secondDash === -1) {
    return { error: 'Missing closing --- for YAML frontmatter' };
  }

  const frontmatter = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 3).trim();

  const fields = parseSimpleYaml(frontmatter);

  if (!fields.name) {
    return { error: 'Missing required field: name' };
  }
  if (!fields.description) {
    return { error: 'Missing required field: description' };
  }
  if (!fields.type) {
    return { error: 'Missing required field: type' };
  }

  const toolType = fields.type as 'declarative_http' | 'generated_code';
  if (toolType !== 'declarative_http' && toolType !== 'generated_code') {
    return { error: 'type must be "declarative_http" or "generated_code"' };
  }

  // Parse parameters (multiline YAML array)
  const parameters = parseParameters(frontmatter);

  // Parse endpoint config for declarative_http
  let endpoint: DeclarativeHttpEndpoint | undefined;
  if (toolType === 'declarative_http') {
    endpoint = parseEndpoint(frontmatter);
    if (!endpoint) {
      return { error: 'declarative_http tools require an endpoint config with method and url' };
    }
  }

  // For generated_code, body is the code
  let code: string | undefined;
  if (toolType === 'generated_code' && body) {
    // Extract code from markdown code block if present
    const codeBlockMatch = body.match(/```(?:typescript|ts|javascript|js)?\n?([\s\S]*?)```/);
    code = codeBlockMatch ? codeBlockMatch[1].trim() : body;
  }

  return {
    name: fields.name.toLowerCase().trim(),
    description: fields.description.trim(),
    type: toolType,
    parameters,
    endpoint,
    code,
  };
}

/**
 * Simple YAML parser for top-level key-value pairs only.
 * Ignores indented lines (nested structures parsed separately).
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of yaml.split('\n')) {
    // Only parse non-indented lines (top-level keys)
    if (line.startsWith(' ') || line.startsWith('\t')) continue;

    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('-')) continue;

    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    let value = trimmedLine.slice(colonIdx + 1).trim();

    // Skip section headers (keys with no value, like "parameters:" or "endpoint:")
    if (!value) continue;

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Parse parameters block from YAML frontmatter.
 * Format:
 * parameters:
 *   - name: city
 *     type: string
 *     description: City name
 *     required: true
 */
function parseParameters(yaml: string): ToolParameter[] {
  const params: ToolParameter[] = [];
  const lines = yaml.split('\n');
  let inParams = false;
  let currentParam: Partial<ToolParameter> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'parameters:') {
      inParams = true;
      continue;
    }

    if (inParams) {
      // End of parameters section when we hit a non-indented line that's not empty
      if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
        inParams = false;
        if (currentParam?.name) {
          params.push({
            name: currentParam.name,
            type: currentParam.type || 'string',
            description: currentParam.description || '',
            required: currentParam.required ?? false,
          });
          currentParam = null;
        }
        continue;
      }

      if (trimmed.startsWith('- ')) {
        // New parameter entry
        if (currentParam?.name) {
          params.push({
            name: currentParam.name,
            type: currentParam.type || 'string',
            description: currentParam.description || '',
            required: currentParam.required ?? false,
          });
        }
        currentParam = {};
        // Parse inline key-value: "- name: city"
        const kvPart = trimmed.slice(2);
        const colonIdx = kvPart.indexOf(':');
        if (colonIdx > -1) {
          const key = kvPart.slice(0, colonIdx).trim();
          const val = kvPart.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (key === 'required') {
            (currentParam as Record<string, unknown>)[key] = val === 'true';
          } else {
            (currentParam as Record<string, string>)[key] = val;
          }
        }
      } else if (currentParam && trimmed) {
        // Continuation of current param
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (key === 'required') {
            (currentParam as Record<string, unknown>)[key] = val === 'true';
          } else {
            (currentParam as Record<string, string>)[key] = val;
          }
        }
      }
    }
  }

  // Don't forget the last parameter
  if (currentParam?.name) {
    params.push({
      name: currentParam.name,
      type: currentParam.type || 'string',
      description: currentParam.description || '',
      required: currentParam.required ?? false,
    });
  }

  return params;
}

/**
 * Parse endpoint configuration from YAML frontmatter.
 */
function parseEndpoint(yaml: string): DeclarativeHttpEndpoint | undefined {
  const lines = yaml.split('\n');
  let inEndpoint = false;
  let inSubSection = '';
  const endpoint: Partial<DeclarativeHttpEndpoint> = {};
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'endpoint:') {
      inEndpoint = true;
      inSubSection = '';
      continue;
    }

    if (inEndpoint) {
      // End of endpoint section when we hit a non-indented, non-empty line
      if (trimmed && !line.startsWith(' ') && !line.startsWith('\t')) {
        inEndpoint = false;
        continue;
      }

      // Check for sub-sections
      if (trimmed === 'query:') {
        inSubSection = 'query';
        continue;
      }
      if (trimmed === 'headers:') {
        inSubSection = 'headers';
        continue;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > -1) {
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        val = val.replace(/^["']|["']$/g, '');

        // Detect indentation depth to distinguish sub-section items from endpoint-level keys
        const indent = line.length - line.trimStart().length;
        const isDeepIndent = indent >= 4; // sub-section items are typically 4+ spaces

        if (inSubSection && isDeepIndent) {
          if (inSubSection === 'query') query[key] = val;
          else if (inSubSection === 'headers') headers[key] = val;
        } else {
          inSubSection = ''; // reset sub-section for endpoint-level keys
          if (key === 'method') endpoint.method = val.toUpperCase();
          else if (key === 'url') endpoint.url = val;
          else if (key === 'response_path') endpoint.response_path = val;
        }
      }
    }
  }

  if (!endpoint.method || !endpoint.url) return undefined;

  return {
    method: endpoint.method,
    url: endpoint.url,
    query: Object.keys(query).length > 0 ? query : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    response_path: endpoint.response_path,
  };
}
