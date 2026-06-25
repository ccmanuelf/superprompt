/**
 * Plan-gate: the cheap pre-filter that rejects obviously-bad candidates before
 * the expensive replay. Deterministic checks are blocking; the council judge is
 * one cross-family Claude call that fails OPEN.
 */
import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted to the top of the file by vitest, so top-level variables
// cannot be referenced inside the factory unless they are also hoisted via vi.hoisted().
const { claudeCtor } = vi.hoisted(() => {
  // Using a real class so `new ClaudeProvider()` returns a proper instance with prototype methods.
  class MockClaudeProvider {
    async sendMessage() { return { text: '{"plausible": true}', provider: 'claude' }; }
  }
  const claudeCtor = vi.fn(function (...args: unknown[]) {
    return Reflect.construct(MockClaudeProvider, args, claudeCtor);
  }) as unknown as typeof MockClaudeProvider & ReturnType<typeof vi.fn>;
  claudeCtor.prototype = MockClaudeProvider.prototype;
  return { claudeCtor };
});

// Pin the cross-family judge: makeDefaultPlanJudge must construct ClaudeProvider,
// not the local router. (Update the path to match Step 1 if different.)
vi.mock('../src/providers/claude.js', () => ({ ClaudeProvider: claudeCtor }));
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { planGateCandidate, makeDefaultPlanJudge } from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';

const skill = { id: 'auto-demo', name: 'demo', system_prompt: 'A working skill prompt that is sufficiently long.' } as Skill;
const GOOD = 'A clearly different and sufficiently long rewritten skill prompt that addresses the issue.';

describe('planGateCandidate deterministic checks', () => {
  it('rejects a no-op (identical to current)', async () => {
    const r = await planGateCandidate(skill, skill.system_prompt, 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no-op/i);
  });
  it('rejects a too-short candidate', async () => {
    const r = await planGateCandidate(skill, 'too short', 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/short/i);
  });
  it('rejects a degenerate apology candidate', async () => {
    const r = await planGateCandidate(skill, "Sorry, I can't help with rewriting this skill prompt right now.", 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/degenerate/i);
  });
  it('passes a plausible candidate when no judge is supplied', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue');
    expect(r.pass).toBe(true);
  });
});

describe('planGateCandidate council judge', () => {
  it('rejects when the judge says implausible', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue', async () => false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/judge/i);
  });
  it('fails OPEN when the judge throws (defers to the delivery gate)', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue', async () => { throw new Error('judge down'); });
    expect(r.pass).toBe(true);
  });
});

describe('makeDefaultPlanJudge cross-family', () => {
  it('uses ClaudeProvider, not the local router', async () => {
    const judge = makeDefaultPlanJudge('chat-1');
    const verdict = await judge('issue', GOOD);
    expect(claudeCtor).toHaveBeenCalled();
    expect(verdict).toBe(true);
  });
});
