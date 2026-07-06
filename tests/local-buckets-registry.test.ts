import { describe, it, expect, beforeAll } from 'vitest';
import { registerBuiltinTools } from '../src/providers/tools/index.js';
import { registerTools as registerManufacturingTools } from '../src/packs/manufacturing/index.js';
import { listRegisteredTools } from '../src/forge/tool-registry.js';
import { bucketForTool, CORE_TOOLS, BUCKET_TOOLS } from '../src/providers/local-buckets.js';

describe('bucket ↔ registry consistency', () => {
  // Mirrors production bootstrap (src/index.ts): registerBuiltinTools() covers
  // the 33 core tools, and the manufacturing pack's own registerTools() adds
  // its 15 tools (both use source: 'builtin' — see src/packs/manufacturing/index.ts).
  // Neither call touches the DB at registration time (pure in-memory Map.set).
  beforeAll(async () => {
    await registerBuiltinTools();
    registerManufacturingTools();
  });
  it('every bucket-listed name exists in the registry', () => {
    const registered = new Set(listRegisteredTools().map((t) => t.name));
    const listed = [...CORE_TOOLS, ...Object.values(BUCKET_TOOLS).flat()];
    const missing = listed.filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });
  it('every registered builtin tool is assigned to a bucket', () => {
    const unassigned = listRegisteredTools()
      .filter((t) => t.source === 'builtin')
      .filter((t) => bucketForTool(t.name) === undefined)
      .map((t) => t.name);
    expect(unassigned).toEqual([]);
  });
});
