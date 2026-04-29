/**
 * interviewer built-in skill (rc.99).
 *
 * Clean-room adaptation of the four-step pattern from `the-interviewer`
 * by Ole Lehmann (https://github.com/olelehmann1337/interview-skill, no
 * license declared as of 2026-04-29). All wording, calibration, and
 * worked examples are independently authored for Luna's deployment
 * context (maquiladora + shelter operations).
 *
 * These tests verify (1) the skill is wired into BUILTIN_SKILLS and
 * SKILL_TRIGGERS correctly, (2) key prompt content survives future
 * edits, (3) the maquiladora + shelter domain examples (the explicit
 * scope confirmation from the user) are present, (4) trigger patterns
 * fire on real-world phrasings in EN+ES and don't fire on specific
 * already-scoped requests, (5) the clean-room attribution is honest
 * about the upstream license situation.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, SKILL_TRIGGERS } from '../src/skills.js';

const skill = BUILTIN_SKILLS.find((s) => s.name === 'interviewer');
const trigger = SKILL_TRIGGERS.find((t) => t.skillName === 'interviewer');

if (!skill) throw new Error('builtin skill "interviewer" not registered');
if (!trigger) throw new Error('auto-trigger for "interviewer" not registered');

describe('interviewer skill — registration shape (rc.99)', () => {
  it('uses the expected id', () => {
    expect(skill.id).toBe('builtin-interviewer');
  });

  it('description signals "pre-flight planning" and "creation task"', () => {
    expect(skill.description).toMatch(/pre-flight planning/i);
    expect(skill.description).toMatch(/creation task/i);
  });

  it('inherits default tools (allowedTools = null)', () => {
    expect(skill.allowedTools).toBeNull();
  });
});

describe('interviewer prompt — four-step pattern named (rc.99)', () => {
  const p = skill.systemPrompt;

  it('names all 4 steps in order', () => {
    expect(p).toMatch(/STEP 1\s+—\s+IDENTIFY WHAT'S BEING BUILT/i);
    expect(p).toMatch(/STEP 2\s+—\s+SPEC EXPANSION/i);
    expect(p).toMatch(/STEP 3\s+—\s+INTERVIEW/i);
    expect(p).toMatch(/STEP 4\s+—\s+BRIEF AND BUILD/i);
    // Order matters — Step 1 must appear before Step 2, etc.
    const idx1 = p.search(/STEP 1\b/);
    const idx2 = p.search(/STEP 2\b/);
    const idx3 = p.search(/STEP 3\b/);
    const idx4 = p.search(/STEP 4\b/);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });

  it('cites the Anthropic planner methodology in the spec-expansion step', () => {
    expect(skill.systemPrompt).toMatch(/Anthropic('s)? (internal )?planner methodology/i);
  });

  it('includes the calibration table for asset complexity', () => {
    expect(skill.systemPrompt).toMatch(/CALIBRATION TABLE/i);
    expect(skill.systemPrompt).toMatch(/Quick.*1-2/);
    expect(skill.systemPrompt).toMatch(/Medium.*2-4/);
    expect(skill.systemPrompt).toMatch(/Complex.*4-7/);
  });

  it('includes the substance-vs-preferences test framing', () => {
    expect(skill.systemPrompt).toMatch(/substance.{0,30}preferences/i);
    expect(skill.systemPrompt).toMatch(/(if i removed this question|removed the question)/i);
  });

  it('lists explicit bad-question examples (preferences/inferrable)', () => {
    const p = skill.systemPrompt;
    expect(p).toMatch(/What tone\?/i);
    expect(p).toMatch(/Who's the audience\?/i);
    expect(p).toMatch(/What format\?/i);
  });

  it('lists explicit good-question examples (substance-extracting)', () => {
    expect(skill.systemPrompt).toMatch(/headline (number|metric)/i);
    expect(skill.systemPrompt).toMatch(/(post-incident RCA|corrective-action follow)/i);
  });
});

describe('interviewer prompt — maquiladora + shelter domain coverage (rc.99 explicit scope)', () => {
  const p = skill.systemPrompt;

  it('mentions maquiladora-domain assets in the calibration table', () => {
    expect(p).toMatch(/attendance digest/i);
    expect(p).toMatch(/OEE/);
    expect(p).toMatch(/RCA/);
    expect(p).toMatch(/FMEA/);
    expect(p).toMatch(/capacity plan/i);
  });

  it('mentions shelter-operations-domain assets', () => {
    expect(p).toMatch(/shelter billing/i);
    expect(p).toMatch(/IMMEX/);
    expect(p).toMatch(/(trade.compliance|compliance report)/i);
  });

  it('includes shelter-billing substance question (SAM hours vs actual)', () => {
    expect(p).toMatch(/SAM hours/i);
    expect(p).toMatch(/actual hours worked/i);
  });

  it('includes IMMEX classification substance question for trade-compliance docs', () => {
    expect(p).toMatch(/IMMEX classification/i);
  });

  it('includes manufacturing-engineering substance questions (failure mode, IE-vs-management framing)', () => {
    expect(p).toMatch(/(failure mode|modo de falla)/i);
    expect(p).toMatch(/IE team/);
    expect(p).toMatch(/(escalate|escalar)/i);
  });
});

describe('interviewer prompt — bilingual EN/ES support (rc.99)', () => {
  const p = skill.systemPrompt;

  it('explicitly notes Spanish-primary handling', () => {
    expect(p).toMatch(/Spanish-primary/i);
  });

  it('provides Spanish-language equivalents of the good-question examples', () => {
    expect(p).toMatch(/¿Cuál es el número clave/);
    expect(p).toMatch(/¿Es este RCA/);
    expect(p).toMatch(/¿Lo facturamos/);
  });

  it('explicitly tells the model to follow the user\'s language switching', () => {
    expect(p).toMatch(/(switch language mid-conversation|follow their lead)/i);
  });

  it('lists Spanish approval signals alongside English ones', () => {
    expect(p).toMatch(/sí/);
    expect(p).toMatch(/adelante/);
    expect(p).toMatch(/perfecto/);
  });
});

describe('interviewer prompt — Luna runtime adaptations (rc.99)', () => {
  const p = skill.systemPrompt;

  it('explicitly notes the absence of AskUserQuestion tool', () => {
    expect(p).toMatch(/No AskUserQuestion tool/);
  });

  it('specifies plain-text letter-prefixed multiple choice as the workaround', () => {
    expect(p).toMatch(/letter-prefixed/i);
  });

  it('notes the Telegram-driven UX time budget (1-3 minutes)', () => {
    expect(p).toMatch(/1-3 minute/);
  });

  it('flags the suggest-mode contract — calibrate, do not over-ask', () => {
    expect(p).toMatch(/(suggest. mode|opted into|don't run a full interview)/i);
  });

  it('describes handoff to specialized Luna skills/tools', () => {
    expect(p).toMatch(/handoff/i);
    expect(p).toMatch(/specialized (Luna )?skill/i);
  });
});

describe('interviewer prompt — clean-room attribution (rc.99)', () => {
  const p = skill.systemPrompt;

  it('credits Lehmann\'s the-interviewer as the pattern source', () => {
    expect(p).toMatch(/the-interviewer/);
    expect(p).toMatch(/Ole Lehmann/);
    expect(p).toMatch(/github\.com\/olelehmann1337\/interview-skill/);
  });

  it('honestly notes the upstream license situation (no license declared)', () => {
    expect(p).toMatch(/no license declared/i);
  });

  it('explicitly says "clean-room" / "no verbatim copying"', () => {
    expect(p).toMatch(/clean-room/i);
    expect(p).toMatch(/no verbatim copying/i);
  });

  it('cites Anthropic planner methodology', () => {
    expect(p).toMatch(/Anthropic planner methodology/i);
  });

  it('declares Luna implementation as independently authored', () => {
    expect(p).toMatch(/independently authored/i);
  });
});

describe('interviewer auto-trigger — registration (rc.99)', () => {
  it('is mode "suggest" — user opts in, not silent activation', () => {
    expect(trigger.mode).toBe('suggest');
  });

  it('has at least 6 patterns to cover EN + ES + clarification signals', () => {
    expect(trigger.patterns.length).toBeGreaterThanOrEqual(6);
  });
});

describe('interviewer auto-trigger — EN positive cases (rc.99)', () => {
  const positives = [
    'help me draft a report for the supervisor about cell 4 yields',
    'build me a presentation about Q1 OEE trends',
    'I need a proposal for the RFQ from supplier X',
    'Create a one-pager about the new IMMEX requirements',
    'put together a control plan for the new SKU',
    'draft an attendance digest for the morning',
    'we need a compliance summary for the customer audit',
    'write me a memo about the cell 4 RCA findings',
    "I'm not sure where to start with this customer audit response",
    'help me prepare a capacity plan for line 3',
    'can you help me write a brief on the supplier RFQ',
  ];
  for (const msg of positives) {
    it(`fires on EN positive: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected at least one pattern to match "${msg}"`).toBe(true);
    });
  }
});

describe('interviewer auto-trigger — ES positive cases (rc.99)', () => {
  const positives = [
    'necesito un reporte para el supervisor sobre la celda 4',
    'ayúdame a redactar un análisis de capacidad para la línea 3',
    'quiero una propuesta para responder al RFQ del proveedor',
    'haz un resumen de cumplimiento para la auditoría',
    'crea un brief sobre los nuevos requisitos IMMEX',
    'prepárame una presentación del OEE del primer trimestre',
    'redacta un memo sobre los hallazgos del RCA',
    'no sé por dónde empezar con esto',
    'ayudame a preparar el informe',  // sin tilde — common typing
  ];
  for (const msg of positives) {
    it(`fires on ES positive: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected at least one pattern to match "${msg}"`).toBe(true);
    });
  }
});

describe('interviewer auto-trigger — negative cases (rc.99)', () => {
  // Specific, already-scoped requests should NOT fire — the user has given
  // enough info to execute. The interviewer is for vague briefs, not for
  // when the user already knows what they want.
  const negatives = [
    "what's the takt time for line 3",                                   // factual lookup
    "show me yesterday's attendance",                                    // lookup
    "/skill list",                                                       // command
    'add "review FMEA" to the kanban',                                   // specific kanban action
    'run /capacity for line 5',                                          // specific command
    'hola buenos días',                                                  // greeting
    "what's the capital of France",                                      // factual
    'multiply 17 by 23',                                                 // calculation
    'translate "good morning" to spanish',                               // simple translation
    'send hello to chat 12345',                                          // specific action
  ];
  for (const msg of negatives) {
    it(`does NOT fire on negative: "${msg}"`, () => {
      const matched = trigger.patterns.some((p) => p.test(msg));
      expect(matched, `expected NO pattern to match "${msg}"`).toBe(false);
    });
  }
});

describe('interviewer auto-trigger — boundary cases (rc.99)', () => {
  // Cases that test the asset-noun list — generic creation verbs alone
  // shouldn't fire if the noun isn't in the asset list.
  it('does NOT fire on "create a CSV with 3 rows" (specific data, not vague)', () => {
    // "create a CSV" — CSV is not in the asset-noun list intentionally;
    // CSV requests are usually accompanied by enough specifics to skip
    // the interview.
    const msg = 'create a CSV with these 3 rows: a, b, c';
    const matched = trigger.patterns.some((p) => p.test(msg));
    expect(matched).toBe(false);
  });

  it('does fire on "create a report" (vague noun, ambiguous spec)', () => {
    const msg = 'create a report';
    const matched = trigger.patterns.some((p) => p.test(msg));
    expect(matched).toBe(true);
  });

  it('does NOT fire on "send the report to the boss" (action, not creation)', () => {
    const msg = 'send the report to the boss';
    const matched = trigger.patterns.some((p) => p.test(msg));
    expect(matched).toBe(false);
  });
});

describe('rc.99 — skill name uniqueness sanity check', () => {
  // Adding `interviewer` shouldn't collide with any of the existing 13
  // builtins. Same check the antislop+council tests do.
  it('all builtin skill names are unique after rc.99', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all auto-trigger skillNames map to a real builtin skill (still true after rc.99)', () => {
    const builtinNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
    for (const t of SKILL_TRIGGERS) {
      expect(
        builtinNames.has(t.skillName),
        `auto-trigger references missing skill "${t.skillName}"`,
      ).toBe(true);
    }
  });

  it('builtin skill count is 14 after rc.99', () => {
    // 11 pre-rc.97 + 2 rc.97 (antislop, council) + 1 rc.99 (interviewer) = 14
    expect(BUILTIN_SKILLS.length).toBe(14);
  });
});
