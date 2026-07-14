import { describe, it, expect } from 'vitest';
import {
  selectBucket, toolNamesForBucket, bucketForTool, CORE_TOOLS, BUCKET_TOOLS, SAM_TRIGGER_PATTERN,
  SAM_ACRONYM_PATTERN, matchesSamVocabulary,
} from '../src/providers/local-buckets.js';

describe('bucket selection', () => {
  it('routes manufacturing vocabulary (EN) to manufacturing', () => {
    expect(selectBucket('show me the bom shortage for company 1054', undefined)).toBe('manufacturing');
  });
  it('routes manufacturing vocabulary (ES) to manufacturing', () => {
    expect(selectBucket('análisis de causa raíz del cuello de botella', undefined)).toBe('manufacturing');
  });
  it('routes simulation asks to simulation', () => {
    expect(selectBucket('run a production simulation with 3 cells', undefined)).toBe('simulation');
  });
  it('routes document asks (EN+ES) to docs', () => {
    expect(selectBucket('generate a PDF report of the results', undefined)).toBe('docs');
    expect(selectBucket('genera un reporte en xlsx', undefined)).toBe('docs');
  });
  it('routes github/render asks to devops', () => {
    expect(selectBucket('list my repos and open PRs', undefined)).toBe('devops');
  });
  it('hysteresis: no bucket match keeps the current bucket', () => {
    expect(selectBucket('ok thanks, continue', 'manufacturing')).toBe('manufacturing');
  });
  it('no match and no current bucket falls back to core', () => {
    expect(selectBucket('hola, buenos días', undefined)).toBe('core');
  });
  it('explicit different-bucket match switches buckets', () => {
    expect(selectBucket('now generate the docx summary', 'manufacturing')).toBe('docs');
  });
  it('specific-vocabulary buckets win over generic docs vocabulary after reorder', () => {
    expect(selectBucket('genera un reporte de capacidad', undefined)).toBe('manufacturing');
    expect(selectBucket('read this file from the repo and diff it', undefined)).toBe('devops');
  });
  it('bare "company" without plural/numeric/data context does not false-positive to manufacturing', () => {
    expect(selectBucket("let's start a company selling shoes", undefined)).toBe('core');
  });
  it('bare singular "issue" without verb/plural context does not false-positive to devops', () => {
    expect(selectBucket('I have an issue with my order', undefined)).toBe('core');
  });
  it('routes SAM vocabulary (EN) to sam, beating generic manufacturing words', () => {
    expect(selectBucket('what are the standard allowed minutes for the assault pant?', undefined)).toBe('sam');
    expect(selectBucket('draft a sam analysis from this tech pack', undefined)).toBe('sam');
  });
  it('routes SAM vocabulary (ES) to sam', () => {
    expect(selectBucket('dame los minutos estándar del análisis de sam', undefined)).toBe('sam');
    expect(selectBucket('cuál es el costo por pieza de este producto', undefined)).toBe('sam');
  });
  it('bare "Sam" as a person name does not false-positive to sam', () => {
    expect(selectBucket('Sam said hi about the meeting', undefined)).toBe('core');
  });
});

describe('bucket tool lists', () => {
  it('toolNamesForBucket returns core ∪ bucket with no duplicates', () => {
    const names = toolNamesForBucket('manufacturing');
    expect(names).toEqual([...new Set(names)]);
    for (const t of CORE_TOOLS) expect(names).toContain(t);
    for (const t of BUCKET_TOOLS.manufacturing) expect(names).toContain(t);
  });
  it('core bucket returns only core tools', () => {
    expect(toolNamesForBucket('core')).toEqual(CORE_TOOLS);
  });
  it('bucketForTool reverse lookup works and core tools map to core', () => {
    expect(bucketForTool('production_simulation')).toBe('simulation');
    expect(bucketForTool('web_search')).toBe('core');
    expect(bucketForTool('nonexistent_tool')).toBeUndefined();
  });
  it('per-turn schema count target: core + largest bucket ≤ 22', () => {
    const counts = Object.keys(BUCKET_TOOLS).map((b) => toolNamesForBucket(b as never).length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(22);
  });
});

// spec 2026-07-13 — the sam trigger vocabulary is exported so the router's
// Claude-path pin and the bucket table share ONE source (no drift).
describe('SAM_TRIGGER_PATTERN export (single vocabulary source)', () => {
  it('matches exactly what the sam bucket matches', () => {
    const samAsk = 'draft a sam analysis from this tech pack';
    expect(SAM_TRIGGER_PATTERN.test(samAsk)).toBe(true);
    expect(selectBucket(samAsk, undefined)).toBe('sam');
    const personName = 'Sam said hi about the meeting';
    expect(SAM_TRIGGER_PATTERN.test(personName)).toBe(false);
    expect(selectBucket(personName, undefined)).toBe('core');
  });
  it('has no global flag (shared RegExp object — no lastIndex statefulness across the two consumers)', () => {
    expect(SAM_TRIGGER_PATTERN.global).toBe(false);
    expect(SAM_TRIGGER_PATTERN.flags).toBe('i');
  });
});

// rc.137 — live-evidence re-smoke (2026-07-13) showed "What analyses are
// stored in SAM right now?" dodges SAM_TRIGGER_PATTERN's phrase-adjacency
// requirement. SAM_ACRONYM_PATTERN adds a case-SENSITIVE uppercase-"SAM" +
// anchor-word co-occurrence net; matchesSamVocabulary is the combined,
// single entry point the router's pin consumes.
describe('SAM_ACRONYM_PATTERN + matchesSamVocabulary (rc.137 pin recall)', () => {
  it('matches uppercase SAM co-occurring with a data/analysis anchor, either order', () => {
    expect(matchesSamVocabulary('What analyses are stored in SAM right now?')).toBe(true);
    expect(matchesSamVocabulary('Give me the SAM data for last week')).toBe(true);
    expect(matchesSamVocabulary('qué análisis hay en SAM')).toBe(true);
    expect(matchesSamVocabulary('export the SAM workbook')).toBe(true);
    expect(matchesSamVocabulary('SAM measured times list')).toBe(true);
    expect(matchesSamVocabulary('how many minutes in SAM for the hoodie')).toBe(true);
  });
  it('never matches lowercase/titlecase "Sam" — the person-name guard', () => {
    expect(matchesSamVocabulary('Sam said the data looks fine')).toBe(false);
    expect(matchesSamVocabulary('ask Sam for the list')).toBe(false);
    expect(matchesSamVocabulary('sam gave me his analysis')).toBe(false);
  });
  it('respects the \\bSAM\\b boundary — "samples" does not match', () => {
    expect(matchesSamVocabulary('the samples data look wrong')).toBe(false);
  });
  it('requires an anchor word in the window — bare SAM does not match', () => {
    expect(matchesSamVocabulary('SAM is a nice guy')).toBe(false);
  });
  it('SAM_ACRONYM_PATTERN is case-sensitive (no /i flag)', () => {
    expect(SAM_ACRONYM_PATTERN.flags).toBe('');
  });
  it('selectBucket is unaffected — the live-miss phrase still falls through to core (bucket vocabulary untouched)', () => {
    expect(selectBucket('What analyses are stored in SAM right now?', undefined)).toBe('core');
  });
  // rc.138 (spec 2026-07-14 §4) — Phase-2 analytics anchor words, added to
  // BOTH alternation halves; the uppercase-SAM window requirement is
  // preserved so precision holds (probed standalone before this test).
  it('matches Phase-2 analytics anchors co-occurring with uppercase SAM', () => {
    expect(matchesSamVocabulary('run the SAM line balance')).toBe(true);
    expect(matchesSamVocabulary('SAM cell viability')).toBe(true);
    expect(matchesSamVocabulary('takt time in SAM')).toBe(true);
    expect(matchesSamVocabulary('what staffing does SAM compute for 1200/day')).toBe(true);
    expect(matchesSamVocabulary('total headcount from SAM')).toBe(true);
    expect(matchesSamVocabulary('SAM estimate for these three steps')).toBe(true);
    expect(matchesSamVocabulary('guarda el escenario en SAM')).toBe(true);
    expect(matchesSamVocabulary('viabilidad de la celda según SAM')).toBe(true);
  });
  it('adversarial set: person-name/brand phrases with analytics words still never match', () => {
    expect(matchesSamVocabulary('Sam balanced the books')).toBe(false);
    expect(matchesSamVocabulary("sam's cell phone")).toBe(false);
    expect(matchesSamVocabulary('SAMSUNG cell')).toBe(false);
    expect(matchesSamVocabulary('Sam has a good scenario')).toBe(false);
    expect(matchesSamVocabulary('ask Sam for a headcount estimate')).toBe(false);
  });
  it('rc.138 pattern remains case-sensitive (no flags)', () => {
    expect(SAM_ACRONYM_PATTERN.flags).toBe('');
  });
});
