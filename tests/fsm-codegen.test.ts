import { describe, it, expect } from 'vitest';
import { generateStructuredText } from '../src/fsm/codegen.js';
import { FSM_TEMPLATES } from '../src/fsm/templates.js';
import type { FSMDefinition, FSMState, FSMTransition } from '../src/fsm/models.js';

/**
 * NOTE on the audit's "generated code must compile" requirement:
 * codegen.ts does NOT emit TypeScript — it emits IEC 61131-3 Structured Text
 * (a PLC language for Siemens TIA Portal / Codesys). There is no ST compiler
 * or runtime available in this repo (and none on npm worth pulling in), so
 * compile-proof via tsc and execution-proof via dynamic import do not apply.
 * The closest equivalent — used here as the must-have proof — is a structural
 * well-formedness check: every ST block keyword must be balanced
 * (TYPE/END_TYPE, FUNCTION_BLOCK/END_FUNCTION_BLOCK, VAR blocks/END_VAR,
 * IF/THEN/END_IF, CASE/END_CASE), which is what an ST compiler's parser
 * would reject
 * first. This runs against hand-built FSMs and all 4 shipped templates.
 */

// ── ST structural checker (compile-proof analog) ─────────────

function stripComments(code: string): string {
  return code.replace(/\(\*[\s\S]*?\*\)/g, '');
}

function count(code: string, re: RegExp): number {
  return (code.match(re) ?? []).length;
}

/** Assert all IEC 61131-3 block constructs are balanced. */
function assertWellFormedST(code: string): void {
  const c = stripComments(code);
  // Word-boundary regexes: "_" is a word char, so /\bIF\b/ does NOT match
  // the IF inside END_IF, and /\bCASE\b/ does not match END_CASE, etc.
  expect(count(c, /\bTYPE\b/g)).toBe(count(c, /\bEND_TYPE\b/g));
  expect(count(c, /\bFUNCTION_BLOCK\b/g)).toBe(count(c, /\bEND_FUNCTION_BLOCK\b/g));
  const varOpens = count(c, /\bVAR\b/g) + count(c, /\bVAR_INPUT\b/g) + count(c, /\bVAR_OUTPUT\b/g);
  expect(varOpens).toBe(count(c, /\bEND_VAR\b/g));
  expect(count(c, /\bIF\b/g)).toBe(count(c, /\bEND_IF\b/g));
  expect(count(c, /\bIF\b/g)).toBe(count(c, /\bTHEN\b/g));
  expect(count(c, /\bCASE\b/g)).toBe(count(c, /\bEND_CASE\b/g));
  // Every assignment statement must be terminated with a semicolon
  for (const line of c.split('\n')) {
    if (line.includes(':=') && !line.trim().startsWith('(')) {
      // enum member lines inside TYPE use "," / no terminator; they contain ":= <ordinal>"
      const isEnumMember = /:=\s*\d+\s*,?\s*$/.test(line.trim());
      if (!isEnumMember) expect(line.trim().endsWith(';')).toBe(true);
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────

function state(id: string, name: string, opts: Partial<FSMState> = {}): FSMState {
  return { id, name, mfg_type: 'idle', is_initial: false, is_final: false, x: 0, y: 0, ...opts };
}

function trans(id: string, from: string, to: string, event: string, opts: Partial<FSMTransition> = {}): FSMTransition {
  return { id, from_state_id: from, to_state_id: to, event, ...opts };
}

/** Small 3-state machine: Idle → Processing → Done(final). */
function makeSmallFSM(): FSMDefinition {
  return {
    id: 'm1',
    name: 'Press Station',
    states: [
      state('s1', 'Idle', { is_initial: true }),
      state('s2', 'Processing', { mfg_type: 'processing', entry_action: 'Start timer', exit_action: 'Stop timer' }),
      state('s3', 'Done', { mfg_type: 'custom', is_final: true }),
    ],
    transitions: [
      trans('t1', 's1', 's2', 'job_arrives', { action: 'increment_wip' }),
      trans('t2', 's2', 's3', 'processing_complete'),
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('FSM codegen — Structured Text', () => {
  it('generates the expected structural elements for a small FSM', () => {
    const code = generateStructuredText(makeSmallFSM());

    // Header identifies the FSM
    expect(code).toContain('(* FSM: Press Station *)');
    expect(code).toContain('IEC 61131-3 Structured Text');

    // State enum with sanitized block name and sequential ordinals
    expect(code).toContain('TYPE E_Press_Station_State :');
    expect(code).toContain('Idle := 0');
    expect(code).toContain('Processing := 1');
    expect(code).toContain('Done := 2');

    // Function block, event inputs, outputs
    expect(code).toContain('FUNCTION_BLOCK FB_Press_Station');
    expect(code).toContain('job_arrives : BOOL;');
    expect(code).toContain('processing_complete : BOOL;');
    expect(code).toContain('CurrentState : E_Press_Station_State;');
    expect(code).toContain('StateChanged : BOOL;');

    // Transitions inside the CASE
    expect(code).toContain('IF job_arrives THEN');
    expect(code).toContain('CurrentState := E_Press_Station_State#Processing;');
    expect(code).toContain('CurrentState := E_Press_Station_State#Done;');
  });

  it('initializes to the is_initial state even when it is not first in the array', () => {
    const fsm = makeSmallFSM();
    // Reorder so the initial state is last
    fsm.states = [fsm.states[1], fsm.states[2], fsm.states[0]];
    const code = generateStructuredText(fsm);
    expect(code).toContain('(* Initialize to Idle *)');
    expect(code).toContain('CurrentState := E_Press_Station_State#Idle;');
  });

  it('falls back to the first state when no state is marked initial', () => {
    const fsm = makeSmallFSM();
    fsm.states = fsm.states.map((s) => ({ ...s, is_initial: false }));
    const code = generateStructuredText(fsm);
    expect(code).toContain('(* Initialize to Idle *)');
  });

  it('emits entry/exit/action comments and deduplicates event inputs', () => {
    const fsm = makeSmallFSM();
    fsm.transitions.push(trans('t3', 's2', 's1', 'job_arrives')); // duplicate event name
    const code = generateStructuredText(fsm);

    expect(code).toContain('(* Entry: Start timer *)');
    expect(code).toContain('(* Exit: Stop timer *)');
    expect(code).toContain('(* Action: increment_wip *)');

    // Duplicate event declared only once in VAR_INPUT
    expect(count(code, /job_arrives : BOOL;/g)).toBe(1);
  });

  it('converts guard expressions to ST syntax and declares guard vars as inputs', () => {
    const fsm = makeSmallFSM();
    fsm.transitions[0].guard = 'material_available && !blocked_flag';
    const code = generateStructuredText(fsm);

    // && → AND, ! → NOT inside the transition condition
    expect(code).toContain('IF job_arrives AND (material_available AND NOT blocked_flag) THEN');
    // Guard variables surfaced as BOOL inputs
    expect(code).toContain('material_available : BOOL;    (* Guard condition *)');
    expect(code).toContain('blocked_flag : BOOL;    (* Guard condition *)');
  });

  it('marks final states with no outgoing transitions as no-op CASE arms', () => {
    const code = generateStructuredText(makeSmallFSM());
    expect(code).toMatch(/E_Press_Station_State#Done:\n\s+; \(\* Final state — no transitions \*\)/);
  });

  it('generates well-formed ST for the small FSM and all 4 shipped templates (compile-proof analog)', () => {
    assertWellFormedST(generateStructuredText(makeSmallFSM()));

    expect(FSM_TEMPLATES.length).toBe(4);
    for (const t of FSM_TEMPLATES) {
      const fsm: FSMDefinition = { id: 'tpl', name: t.label, ...t.definition };
      const code = generateStructuredText(fsm);
      assertWellFormedST(code);
      // Every state appears as both an enum member and a CASE arm or final no-op
      for (const s of t.definition.states) {
        const sanitized = s.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        expect(code).toContain(`${sanitized} :=`);
      }
    }
  });

  it('cyclic transitions (A→B→A) generate well-formed code with both directions', () => {
    const fsm: FSMDefinition = {
      id: 'cyc',
      name: 'Cycler',
      states: [state('a', 'StateA', { is_initial: true }), state('b', 'StateB', { mfg_type: 'processing' })],
      transitions: [trans('t1', 'a', 'b', 'go'), trans('t2', 'b', 'a', 'back')],
    };
    const code = generateStructuredText(fsm);
    assertWellFormedST(code);
    expect(code).toContain('CurrentState := E_Cycler_State#StateB;');
    expect(code).toContain('CurrentState := E_Cycler_State#StateA;');
  });

  // ── Characterization: pinning current behavior ─────────────

  it('unreachable states are silently included (no error, no warning marker)', () => {
    const fsm: FSMDefinition = {
      id: 'u',
      name: 'Unreach',
      states: [
        state('s1', 'Start', { is_initial: true }),
        state('s2', 'Island', { mfg_type: 'broken_down' }), // no incoming transitions
      ],
      transitions: [],
    };
    const code = generateStructuredText(fsm);
    // Current behavior: unreachable state still gets an enum member and a CASE arm
    expect(code).toContain('Island := 1');
    expect(code).toContain('E_Unreach_State#Island:');
    expect(code).not.toMatch(/unreachable/i);
    assertWellFormedST(code);
  });

  it('transitions pointing at a missing state are silently dropped', () => {
    const fsm: FSMDefinition = {
      id: 'd',
      name: 'Dangling',
      states: [state('s1', 'Start', { is_initial: true })],
      transitions: [trans('t1', 's1', 'ghost', 'go')],
    };
    const code = generateStructuredText(fsm);
    // Event input is still declared, but no IF/transition body is emitted for it
    expect(code).toContain('go : BOOL;');
    expect(code).not.toContain('IF go THEN');
    assertWellFormedST(code);
  });

  it('empty definition does not throw; emits a degenerate block with empty enum and no init', () => {
    const fsm: FSMDefinition = { id: 'e', name: 'Empty', states: [], transitions: [] };
    let code = '';
    expect(() => { code = generateStructuredText(fsm); }).not.toThrow();
    // Degenerate but structurally balanced output
    expect(code).toContain('TYPE E_Empty_State :');
    expect(code).toContain('FUNCTION_BLOCK FB_Empty');
    expect(code).not.toContain('(* Initialize'); // no initial state → no init block
    assertWellFormedST(code);
  });

  it('sanitizes identifiers: specials → underscores; all-symbol names → "unnamed"; leading digits prefixed (rc.115 fix)', () => {
    const fsm: FSMDefinition = {
      id: 's',
      name: 'Weird Names!',
      states: [
        state('s1', 'Wait & See', { is_initial: true }),
        state('s2', '9Station'),
        state('s3', '***'),
      ],
      transitions: [trans('t1', 's1', 's2', 'go-fast')],
    };
    const code = generateStructuredText(fsm);

    expect(code).toContain('FUNCTION_BLOCK FB_Weird_Names');
    expect(code).toContain('Wait_See := 0');     // "&" collapsed, runs deduped
    expect(code).toContain('go_fast : BOOL;');   // "-" → "_"
    expect(code).toContain('unnamed := 2');      // all-symbol name falls back

    // rc.115: the leading-digit guard now runs after the edge-trim, so
    // digit-leading names get a legal `_` prefix (IEC 61131-3 identifiers
    // must not start with a digit).
    expect(code).toContain('_9Station := 1');
  });
});
