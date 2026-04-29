/**
 * antislop + council built-in skills (rc.97).
 *
 * Adapted from olelehmann1337/marketing-os-workshop (MIT) per the user's
 * approved Option B from the rc.97 scoping conversation. These tests
 * verify both that the skills are wired into BUILTIN_SKILLS and
 * SKILL_TRIGGERS correctly, and that key content survives without
 * accidentally being trimmed or mangled in future edits.
 *
 * No DB setup needed — these are pure structural checks against the
 * exported arrays. The runtime skill activation/persistence path is
 * already covered by tests/skills.test.ts and tests/skill-auto-trigger.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, SKILL_TRIGGERS } from '../src/skills.js';

function getSkill(name: string) {
  const s = BUILTIN_SKILLS.find((s) => s.name === name);
  if (!s) throw new Error(`builtin skill "${name}" not registered`);
  return s;
}

function getTrigger(name: string) {
  const t = SKILL_TRIGGERS.find((t) => t.skillName === name);
  if (!t) throw new Error(`auto-trigger for "${name}" not registered`);
  return t;
}

describe('antislop skill (rc.97)', () => {
  const skill = getSkill('antislop');

  it('is registered with the expected id and shape', () => {
    expect(skill.id).toBe('builtin-antislop');
    expect(skill.description).toMatch(/strip ai-writing patterns/i);
    expect(skill.allowedTools).toBeNull();  // null = inherit defaults
  });

  it('system prompt names all 5 passes in order', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/STRUCTURE\s*→\s*PHRASES\s*→\s*VERBS\s*→\s*FORMATTING\s*→\s*CONTENT/);
    expect(p).toMatch(/PASS 1 — STRUCTURE/);
    expect(p).toMatch(/PASS 2 — PHRASES/);
    expect(p).toMatch(/PASS 3 — VERBS/);
    expect(p).toMatch(/PASS 4 — FORMATTING/);
    expect(p).toMatch(/PASS 5 — CONTENT/);
  });

  it('banned-list contains both marketing and ops/manufacturing patterns', () => {
    const p = skill.systemPrompt;
    // Marketing-era tells (kept from upstream)
    expect(p).toMatch(/game-changer/);
    expect(p).toMatch(/supercharge/);
    expect(p).toMatch(/leverage \(as verb\)/);
    expect(p).toMatch(/deep dive/);
    // Ops/mfg additions (Luna)
    expect(p).toMatch(/best-in-class|world-class|industry-leading/);
    expect(p).toMatch(/operational excellence/);
    expect(p).toMatch(/drive (engagement|value|efficiency|results)/);
  });

  it('ships both example domains — marketing kept, ops/manufacturing added', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/EXAMPLE 1 — marketing\/LinkedIn/);
    expect(p).toMatch(/EXAMPLE 2 — operations\/manufacturing/);
    // Ops example uses concrete manufacturing vocabulary
    expect(p).toMatch(/takt-?time|takt time|cell 4|SMED|changeover/i);
  });

  it('includes the 6-test quality checklist', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/THE 6 TESTS/);
    expect(p).toMatch(/Read-aloud test/);
    expect(p).toMatch(/Banned phrase test/);
    expect(p).toMatch(/Specificity test/);
  });

  it('attributes upstream Lehmann/Fynnster MIT', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/Ole Lehmann/);
    expect(p).toMatch(/Fynnster Limited/);
    expect(p).toMatch(/MIT/);
    expect(p).toMatch(/marketing-os-workshop/);
  });

  it('flags the Luna-runtime adaptations honestly', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/feedback\.log/);  // explains why the upstream learning loop is dropped
    expect(p).toMatch(/cannot write files/);
  });
});

describe('antislop auto-trigger (rc.97)', () => {
  const trigger = getTrigger('antislop');

  it('is mode "suggest" — deliberate opt-in, not silent activation', () => {
    expect(trigger.mode).toBe('suggest');
  });

  const positives = [
    "can you de-slop this for me",
    "humanize this paragraph please",
    "this sounds like AI, can you fix it",
    "clean it up — too much LinkedIn energy",
    "edit this for slop",
    "strip the AI patterns from this email",
    "make it read more human",
    "does this sound like AI to you",
  ];
  for (const msg of positives) {
    it(`fires on positive: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected at least one pattern to match "${msg}"`).toBe(true);
    });
  }

  const negatives = [
    "what's the weather today",
    "schedule a meeting for tomorrow",
    "show me the kanban board",
    "write me a poem about the ocean",
    "summarize this article",  // summarize, not de-slop
  ];
  for (const msg of negatives) {
    it(`does NOT fire on negative: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected NO pattern to match "${msg}"`).toBe(false);
    });
  }
});

describe('council skill (rc.97)', () => {
  const skill = getSkill('council');

  it('is registered with the expected id and shape', () => {
    expect(skill.id).toBe('builtin-council');
    expect(skill.description).toMatch(/5 advisor perspectives/i);
    expect(skill.allowedTools).toBeNull();
  });

  it('system prompt names all 5 advisors with their thinking style', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/THE CONTRARIAN/);
    expect(p).toMatch(/THE FIRST PRINCIPLES THINKER/);
    expect(p).toMatch(/THE EXPANSIONIST/);
    expect(p).toMatch(/THE OUTSIDER/);
    expect(p).toMatch(/THE EXECUTOR/);
  });

  it('explains the parallel→sequential degradation honestly', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/sub-agent/i);
    expect(p).toMatch(/sequential/i);
    expect(p).toMatch(/Luna does not have/i);
  });

  it('specifies the 5-section verdict structure', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/Where the Council Agrees/);
    expect(p).toMatch(/Where the Council Clashes/);
    expect(p).toMatch(/Blind Spots the Council Caught/);
    expect(p).toMatch(/The Recommendation/);
    expect(p).toMatch(/The One Thing to Do First/);
  });

  it('lists when NOT to convene the council', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/DO NOT CONVENE/);
    expect(p).toMatch(/Factual lookups/);
    expect(p).toMatch(/Trivial decisions/);
  });

  it('ships both example domains — marketing kept, ops/infra added', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/EXAMPLE 1 — marketing\/product decision/);
    expect(p).toMatch(/EXAMPLE 2 — infrastructure decision/);
    // Ops example specifically references the NovaLink bridge scenario
    expect(p).toMatch(/NovaLink|same-VM|Replit/);
  });

  it('attributes upstream Lehmann/Fynnster + Karpathy', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/Ole Lehmann/);
    expect(p).toMatch(/Karpathy/);
    expect(p).toMatch(/MIT/);
  });
});

describe('council auto-trigger (rc.97)', () => {
  const trigger = getTrigger('council');

  it('is mode "suggest" — deliberate opt-in', () => {
    expect(trigger.mode).toBe('suggest');
  });

  const positives = [
    "council this: should I launch a $97 workshop or a $497 course",
    "Run the council on my pricing decision",
    "pressure-test this idea for me",
    "stress-test this plan",
    "should I move the bridge now or wait for the VM",
    "i'm torn between architecture A and architecture B",
    "I can't decide between the two vendors",
    "I need multiple perspectives on this",
    "war room this decision",
  ];
  for (const msg of positives) {
    it(`fires on positive: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected at least one pattern to match "${msg}"`).toBe(true);
    });
  }

  // The original Lehmann SKILL.md says: "do NOT trigger on simple yes/no
  // questions, factual lookups, or casual 'should I' without a meaningful
  // tradeoff (e.g. 'should I use markdown' is not a council question)."
  //
  // We can't fully enforce that with regex alone — the pattern catches
  // "should I X or Y" which is a strong signal of a real tradeoff, but
  // not bare "should I X" since that pattern is too noisy. Negatives
  // below verify the regex doesn't fire on obviously-wrong inputs.
  const negatives = [
    "what's the capital of France",
    "summarize this article please",
    "should I use markdown",  // bare "should I X" — no tradeoff
    "write me a tweet about AI",
    "schedule a follow-up for tomorrow",
  ];
  for (const msg of negatives) {
    it(`does NOT fire on negative: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected NO pattern to match "${msg}"`).toBe(false);
    });
  }
});

describe('rc.97 — skill name uniqueness', () => {
  // Sanity check that adding the two new skills didn't collide with
  // existing names. Future skill additions should keep this passing.
  it('all builtin skill names are unique', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all auto-trigger skillNames map to a real builtin skill', () => {
    const builtinNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
    for (const t of SKILL_TRIGGERS) {
      expect(
        builtinNames.has(t.skillName),
        `auto-trigger references missing skill "${t.skillName}"`,
      ).toBe(true);
    }
  });
});
