import { describe, it, expect } from 'vitest';
import { parseToolMarkdown } from '../src/forge/tool-parser.js';

describe('parseToolMarkdown', () => {
  it('parses a declarative_http tool', () => {
    const md = `---
name: weather
description: Get current weather for a city
type: declarative_http
parameters:
  - name: city
    type: string
    description: City name
    required: true
endpoint:
  method: GET
  url: "https://api.weatherapi.com/v1/current.json"
  query:
    key: "\${WEATHER_API_KEY}"
    q: "\${city}"
  headers:
    Accept: application/json
  response_path: "current.condition.text"
---
Optional notes about this tool.`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('weather');
      expect(result.description).toBe('Get current weather for a city');
      expect(result.type).toBe('declarative_http');
      expect(result.parameters).toHaveLength(1);
      expect(result.parameters[0].name).toBe('city');
      expect(result.parameters[0].required).toBe(true);
      expect(result.endpoint).toBeDefined();
      expect(result.endpoint!.method).toBe('GET');
      expect(result.endpoint!.url).toBe('https://api.weatherapi.com/v1/current.json');
      expect(result.endpoint!.response_path).toBe('current.condition.text');
    }
  });

  it('parses a generated_code tool with code body', () => {
    const md = `---
name: calculator
description: Simple math calculator
type: generated_code
parameters:
  - name: expression
    type: string
    description: Math expression
    required: true
---
\`\`\`typescript
const result = eval(args.expression);
return { result };
\`\`\``;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.type).toBe('generated_code');
      expect(result.code).toContain('eval(args.expression)');
    }
  });

  it('returns error for missing name', () => {
    const md = `---
description: Test
type: declarative_http
---
Body.`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(true);
  });

  it('returns error for missing type', () => {
    const md = `---
name: test
description: Test
---
Body.`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(true);
  });

  it('returns error for invalid type', () => {
    const md = `---
name: test
description: Test
type: invalid_type
---
Body.`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('type must be');
    }
  });

  it('returns error for declarative_http without endpoint', () => {
    const md = `---
name: test
description: Test
type: declarative_http
---
Body.`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('endpoint');
    }
  });

  it('handles multiple parameters', () => {
    const md = `---
name: multi
description: Multi-param tool
type: declarative_http
parameters:
  - name: first
    type: string
    description: First param
    required: true
  - name: second
    type: number
    description: Second param
    required: false
endpoint:
  method: POST
  url: "https://example.com/api"
---`;

    const result = parseToolMarkdown(md);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.parameters).toHaveLength(2);
      expect(result.parameters[0].name).toBe('first');
      expect(result.parameters[1].name).toBe('second');
      expect(result.parameters[1].required).toBe(false);
    }
  });
});
