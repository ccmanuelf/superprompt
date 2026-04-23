import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  calculateBudget,
  trimToBudget,
  formatBudgetReport,
  ContextPriority,
  type ContextComponent,
} from '../src/context-budget.js';

/**
 * Sprint S8: Context Budget tests.
 *
 * Tests REAL exported functions from context-budget.ts.
 * Verifies the budget system correctly estimates, prioritizes, and trims content.
 */

// ── estimateTokens (real function) ─────────────────────────

describe('estimateTokens (real function)', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello')).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });

  it('returns 0 for empty strings', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles realistic text', () => {
    const systemPrompt = 'You are Luna, a helpful AI assistant. Follow quality rules.';
    const tokens = estimateTokens(systemPrompt);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(30);
  });
});

// ── calculateBudget (real function) ────────────────────────

describe('calculateBudget (real function)', () => {
  it('calculates total tokens across components', () => {
    const components: ContextComponent[] = [
      { label: 'system', content: 'x'.repeat(400), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'message', content: 'x'.repeat(200), priority: ContextPriority.USER_MESSAGE, trimmable: false },
      { label: 'memory', content: 'x'.repeat(800), priority: ContextPriority.MEMORY_SEMANTIC, trimmable: true },
    ];

    const budget = calculateBudget(components, 32768);
    expect(budget.totalTokens).toBe(350); // (400+200+800) / 4
    expect(budget.overBudget).toBe(false);
    expect(budget.usagePercent).toBeLessThan(5);
  });

  it('detects over-budget scenarios', () => {
    const components: ContextComponent[] = [
      { label: 'huge', content: 'x'.repeat(130000), priority: ContextPriority.CHAT_HISTORY, trimmable: true },
    ];

    // 130000 chars / 4 = 32500 tokens > (32768 - 2048) = 30720
    const budget = calculateBudget(components, 32768);
    expect(budget.overBudget).toBe(true);
    expect(budget.usagePercent).toBeGreaterThan(100);
  });

  it('calculates available output tokens', () => {
    const components: ContextComponent[] = [
      { label: 'small', content: 'x'.repeat(4000), priority: ContextPriority.SYSTEM, trimmable: false },
    ];

    const budget = calculateBudget(components, 32768);
    expect(budget.availableForOutput).toBe(32768 - 1000); // 32768 - (4000/4)
  });

  it('returns 0 available when over budget', () => {
    const components: ContextComponent[] = [
      { label: 'huge', content: 'x'.repeat(140000), priority: ContextPriority.CHAT_HISTORY, trimmable: true },
    ];

    const budget = calculateBudget(components, 32768);
    expect(budget.availableForOutput).toBe(0);
  });
});

// ── trimToBudget (real function) ───────────────────────────

describe('trimToBudget (real function)', () => {
  it('does not trim when under budget', () => {
    const components: ContextComponent[] = [
      { label: 'system', content: 'Small system prompt', priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'message', content: 'User question here', priority: ContextPriority.USER_MESSAGE, trimmable: false },
    ];

    const { components: result, trimLog } = trimToBudget(components, 32768);
    expect(result).toHaveLength(2);
    expect(trimLog).toHaveLength(0);
  });

  it('trims lowest-priority content first', () => {
    const components: ContextComponent[] = [
      { label: 'system', content: 'x'.repeat(4000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'old_history', content: 'x'.repeat(120000), priority: ContextPriority.CHAT_HISTORY_OLD, trimmable: true },
      { label: 'memory', content: 'x'.repeat(4000), priority: ContextPriority.MEMORY_SEMANTIC, trimmable: true },
    ];

    // Total: (4000+120000+4000)/4 = 32000 > 30720 budget
    const { components: result, trimLog } = trimToBudget(components, 32768);

    // old_history should be removed first (lowest priority)
    expect(trimLog.length).toBeGreaterThan(0);
    expect(trimLog[0]).toContain('old_history');

    // system and memory should remain
    expect(result.some((c) => c.label === 'system')).toBe(true);
    expect(result.some((c) => c.label === 'memory')).toBe(true);
  });

  it('never trims non-trimmable components', () => {
    const components: ContextComponent[] = [
      { label: 'system', content: 'x'.repeat(120000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'history', content: 'x'.repeat(20000), priority: ContextPriority.CHAT_HISTORY, trimmable: true },
    ];

    const { components: result } = trimToBudget(components, 32768);

    // System prompt is never trimmed, even if it's the biggest component
    const systemComponent = result.find((c) => c.label === 'system');
    expect(systemComponent).toBeDefined();
    expect(systemComponent!.content.length).toBe(120000);
  });

  it('trims chat history to last few turns when over budget', () => {
    // Create enough history to push us over budget with the system prompt
    const historyContent = Array.from({ length: 50 }, (_, i) =>
      `Turn ${i + 1}: This is conversation turn number ${i + 1} with substantial content that takes up space in the context window and pushes toward the budget limit.`,
    ).join('\n');

    const components: ContextComponent[] = [
      { label: 'system', content: 'x'.repeat(110000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'history', content: historyContent, priority: ContextPriority.CHAT_HISTORY, trimmable: true },
    ];

    // system = 110000/4 = 27500 tokens, history = ~8000 chars/4 = ~2000 tokens
    // Total ~29500 vs budget 30720. Close but might fit. Let's make it overflow:
    // Actually 110000 + 8000 = 118000 / 4 = 29500. Under 30720. Need more.
    // Use a different approach: make system 120000 chars
    components[0].content = 'x'.repeat(120000); // 30000 tokens > 30720 budget

    const { components: result, trimLog } = trimToBudget(components, 32768);

    // History should be trimmed (system can't be trimmed, so history takes the hit)
    expect(trimLog.length).toBeGreaterThan(0);
    const historyResult = result.find((c) => c.label === 'history');
    if (historyResult) {
      expect(historyResult.content.length).toBeLessThan(historyContent.length);
      // Should keep the LAST turns (most recent)
      expect(historyResult.content).toContain('Turn 50');
    }
  });
});

// ── formatBudgetReport (real function) ─────────────────────

describe('formatBudgetReport (real function)', () => {
  it('generates a readable report', () => {
    const budget = calculateBudget([
      { label: 'system', content: 'x'.repeat(2000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'memory', content: 'x'.repeat(1000), priority: ContextPriority.MEMORY_SEMANTIC, trimmable: true },
      { label: 'message', content: 'x'.repeat(400), priority: ContextPriority.USER_MESSAGE, trimmable: false },
    ], 32768);

    const report = formatBudgetReport(budget);
    expect(report).toContain('Context Budget');
    expect(report).toContain('% used');
    expect(report).toContain('system');
    expect(report).toContain('memory');
    expect(report).toContain('Available for response');
  });

  it('shows warning when over budget', () => {
    const budget = calculateBudget([
      { label: 'huge', content: 'x'.repeat(140000), priority: ContextPriority.CHAT_HISTORY, trimmable: true },
    ], 32768);

    const report = formatBudgetReport(budget);
    expect(report).toContain('exceeds budget');
  });
});

// ── Real-world budget scenarios ────────────────────────────

describe('real-world budget scenarios', () => {
  it('typical message fits comfortably', () => {
    // Simulate: system prompt (~2000 chars) + memory (~600 chars) + user message (~200 chars)
    const components: ContextComponent[] = [
      { label: 'system', content: 'You are Luna...' + 'x'.repeat(2000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'quality_rules', content: 'Never say should work...' + 'x'.repeat(400), priority: ContextPriority.QUALITY_RULES, trimmable: false },
      { label: 'command_list', content: '/newchat, /memory...' + 'x'.repeat(1000), priority: ContextPriority.DOC_CAPABILITIES, trimmable: false },
      { label: 'memory', content: '- User likes coffee (semantic)\n- Past conversation about AI (episode)', priority: ContextPriority.MEMORY_SEMANTIC, trimmable: true },
      { label: 'message', content: 'What is the weather in Santiago?', priority: ContextPriority.USER_MESSAGE, trimmable: false },
    ];

    const budget = calculateBudget(components, 32768);
    expect(budget.overBudget).toBe(false);
    expect(budget.usagePercent).toBeLessThan(10);
  });

  it('long conversation history triggers trimming of old history first', () => {
    const components: ContextComponent[] = [
      { label: 'system', content: 'x'.repeat(8000), priority: ContextPriority.SYSTEM, trimmable: false },
      { label: 'old_history', content: 'x'.repeat(115000), priority: ContextPriority.CHAT_HISTORY_OLD, trimmable: true },
      { label: 'memory', content: 'x'.repeat(2000), priority: ContextPriority.MEMORY_SEMANTIC, trimmable: true },
    ];

    // Total: (8000+115000+2000)/4 = 31250 > 30720 budget
    const { components: result, trimLog } = trimToBudget(components, 32768);

    // Old history should be removed first (lowest priority)
    expect(trimLog.some((l) => l.includes('old_history'))).toBe(true);

    // Memory should survive (higher priority)
    expect(result.some((c) => c.label === 'memory')).toBe(true);
  });
});
