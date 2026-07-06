import { describe, it, expect, beforeAll } from 'vitest';
import { estimateTokens } from '../src/context-budget.js';

describe('buildLocalCapabilitiesPrompt (Task 7b — capabilities diet for the local path)', () => {
  beforeAll(async () => {
    // Populate the real pack registry from packs/*/pack.yaml (same source
    // getAggregatedCapabilities() reads) so the budget/content tests reflect
    // "all current packs enabled", not an empty registry. DB-touching tool/skill
    // import calls fail safely (getKnex() throws, caught per-file) — pack
    // metadata (name/displayName/description/capabilities/enabled) is parsed
    // from YAML regardless and does not depend on DB state.
    const { loadAllPacks } = await import('../src/packs.js');
    await loadAllPacks();
  });

  it('hard budget: estimated tokens <= 800 with all current packs enabled', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const out = buildLocalCapabilitiesPrompt();
    expect(estimateTokens(out)).toBeLessThanOrEqual(800);
  });

  it('lists every enabled pack that getAggregatedCapabilities() would include', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const { getLoadedPacks } = await import('../src/packs.js');
    const out = buildLocalCapabilitiesPrompt();
    const enabledPacks = getLoadedPacks().filter((p) => p.enabled && p.capabilities);
    expect(enabledPacks.length).toBeGreaterThan(0);
    for (const pack of enabledPacks) {
      expect(out).toContain(pack.name);
    }
  });

  it('keeps action-critical facts: documents, memory, tasks, and which tool reaches web dashboards', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const out = buildLocalCapabilitiesPrompt();
    expect(out).toContain('generate_document');
    expect(out).toContain('query_memory');
    expect(out).toContain('kanban_manage');
    expect(out).toContain('/sim');
  });
});
