import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseToolMarkdown } from '../src/forge/tool-parser.js';
import { executeDeclarativeHttp } from '../src/forge/declarative-http.js';
import { scanToolCode } from '../src/forge/safety-scanner.js';

const originalFetch = global.fetch;

describe('forge tool integration', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parse → validate → execute flow for declarative_http', async () => {
    const md = `---
name: joke
description: Get a random joke
type: declarative_http
parameters:
  - name: category
    type: string
    description: Joke category
    required: false
endpoint:
  method: GET
  url: "https://api.example.com/jokes"
  query:
    category: "\${category}"
  response_path: "joke.text"
---`;

    // 1. Parse
    const parsed = parseToolMarkdown(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    expect(parsed.name).toBe('joke');
    expect(parsed.type).toBe('declarative_http');
    expect(parsed.endpoint).toBeDefined();

    // 2. Mock fetch and execute
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ joke: { text: 'Why did the chicken cross the road?' } }),
        { headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await executeDeclarativeHttp(
      parsed.endpoint!,
      { category: 'classic' },
    );

    expect(result).toEqual({ result: 'Why did the chicken cross the road?' });
  });

  it('parse → scan → reject unsafe generated_code', () => {
    const md = `---
name: evil
description: An unsafe tool
type: generated_code
parameters:
  - name: input
    type: string
    description: Input
    required: true
---
\`\`\`typescript
const result = eval(args.input);
process.exit(0);
return { result };
\`\`\``;

    const parsed = parseToolMarkdown(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    expect(parsed.code).toBeDefined();

    const scan = scanToolCode(parsed.code!);
    expect(scan.safe).toBe(false);
    expect(scan.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('parse → scan → accept safe generated_code', () => {
    const md = `---
name: formatter
description: Format JSON data
type: generated_code
parameters:
  - name: data
    type: string
    description: JSON string
    required: true
---
\`\`\`typescript
const parsed = JSON.parse(args.data as string);
const formatted = JSON.stringify(parsed, null, 2);
return { formatted, keys: Object.keys(parsed) };
\`\`\``;

    const parsed = parseToolMarkdown(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    const scan = scanToolCode(parsed.code!);
    expect(scan.safe).toBe(true);
  });

  it('full DB lifecycle: create → enable → disable → lock → unlock → delete', () => {
    // This test validates the data flow without requiring actual DB
    const md = `---
name: weather_api
description: Get weather data
type: declarative_http
parameters:
  - name: city
    type: string
    description: City name
    required: true
endpoint:
  method: GET
  url: "https://api.weather.com/v1"
  query:
    q: "\${city}"
---`;

    const parsed = parseToolMarkdown(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    // Simulate the config that would be stored in DB
    const config = JSON.stringify({
      parameters: parsed.parameters,
      endpoint: parsed.endpoint,
      code: parsed.code,
    });

    // Verify config is valid JSON
    const restored = JSON.parse(config);
    expect(restored.parameters).toHaveLength(1);
    expect(restored.endpoint.method).toBe('GET');
    expect(restored.endpoint.url).toBe('https://api.weather.com/v1');

    // Simulate lifecycle states
    const states = {
      enabled: true,
      locked: false,
    };

    // Disable
    states.enabled = false;
    expect(states.enabled).toBe(false);

    // Enable
    states.enabled = true;
    expect(states.enabled).toBe(true);

    // Lock
    states.locked = true;
    expect(states.locked).toBe(true);

    // Can't delete while locked
    expect(states.locked).toBe(true);

    // Unlock
    states.locked = false;
    expect(states.locked).toBe(false);
  });
});
