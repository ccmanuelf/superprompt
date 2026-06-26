import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueHeal,
  __setHealRunnerForTests,
  __resetHealSchedulerForTests,
  type HealRequest,
} from '../src/auto-skills.js';

// Minimal Skill-shaped stub; the scheduler only reads `.id`.
function reqFor(skillId: string, over: Partial<HealRequest> = {}): HealRequest {
  return {
    skill: { id: skillId, name: skillId, system_prompt: 'x' } as HealRequest['skill'],
    issue: `issue-${skillId}`,
    conversationContext: `ctx-${skillId}`,
    router: {} as HealRequest['router'],
    chatId: 'chat-1',
    ...over,
  };
}

/** A runner whose completion is controlled by the test via a returned resolver. */
function deferredRunner() {
  const calls: string[] = [];
  const issues: string[] = [];
  const resolvers: Array<(v: { patched: boolean; summary: string }) => void> = [];
  const runner = (req: HealRequest) => {
    calls.push(req.skill.id);
    issues.push(req.issue);
    return new Promise<{ patched: boolean; summary: string }>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return { runner, calls, issues, resolveNext: (r = { patched: false, summary: '' }) => resolvers.shift()!(r) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('heal scheduler', () => {
  beforeEach(() => __resetHealSchedulerForTests());

  it('N=1: a second distinct-skill heal starts only after the first frees its slot', async () => {
    const d = deferredRunner();
    __setHealRunnerForTests(d.runner);

    enqueueHeal(reqFor('skill-a'));
    enqueueHeal(reqFor('skill-b'));
    await tick();

    expect(d.calls).toEqual(['skill-a']); // only first running

    d.resolveNext(); // finish skill-a
    await tick();

    expect(d.calls).toEqual(['skill-a', 'skill-b']); // skill-b now runs
  });

  it('per-skill dedup: corrections for an in-flight skill coalesce into one follow-up with latest context', async () => {
    const d = deferredRunner();
    __setHealRunnerForTests(d.runner);

    enqueueHeal(reqFor('skill-a', { issue: 'first' }));
    await tick();
    enqueueHeal(reqFor('skill-a', { issue: 'second' }));
    enqueueHeal(reqFor('skill-a', { issue: 'third' }));
    await tick();

    expect(d.calls).toEqual(['skill-a']); // still only the first in-flight, no stacking
    expect(d.issues).toEqual(['first']); // in-flight run keeps its original context

    d.resolveNext(); // finish first
    await tick();

    expect(d.calls).toEqual(['skill-a', 'skill-a']); // exactly one coalesced follow-up
    expect(d.issues).toEqual(['first', 'third']); // coalesced run used the LATEST context
  });

  it('slot is released even when a heal throws (no deadlock)', async () => {
    const calls: string[] = [];
    __setHealRunnerForTests(async (req) => {
      calls.push(req.skill.id);
      if (req.skill.id === 'boom') throw new Error('heal failed');
      return { patched: false, summary: '' };
    });

    enqueueHeal(reqFor('boom'));
    enqueueHeal(reqFor('skill-ok'));
    await tick();
    await tick();

    expect(calls).toEqual(['boom', 'skill-ok']); // throw freed the slot
  });

  it('onResult fires with the heal result', async () => {
    __setHealRunnerForTests(async () => ({ patched: true, summary: 'done' }));
    const onResult = vi.fn();

    enqueueHeal(reqFor('skill-a', { onResult }));
    await tick();
    await tick();

    expect(onResult).toHaveBeenCalledWith({ patched: true, summary: 'done' });
  });
});
