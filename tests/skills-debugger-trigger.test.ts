/**
 * Debugger auto-trigger tightening (spec 2026-07-17 §A) — the trigger now
 * requires a SOFTWARE/SYSTEM ANCHOR (code/script/config/server/database/api/
 * deploy/container/log/app/bot/luna…) so everyday manufacturing-ops problem
 * language never flips Luna into a debugging interview, and it is BILINGUAL
 * (EN+ES) with the same anchor requirement in both languages.
 *
 * The skillPrompt this trigger activates is injected on BOTH provider paths
 * (composeClaudeSystemPrompt AND buildLocalSystemPrompt), so this one file
 * covers the parity checklist's row A for the trigger half.
 *
 * Deviations from the spec's example lists (probed 2026-07-17, all green):
 * - `[45]\d\d` joins the EN problem tokens (spec MUST-case "the API returns
 *   500 every time" matches no other problem word).
 * - "app"/"website" join the EN anchors (pre-existing regression cases
 *   are genuine software reports).
 * - The two ordered problem↔temporal patterns are now ONE order-free
 *   lookahead pattern; the anchor requirement makes it net-narrower.
 *
 * Post-review adversarial fixes (2026-07-17):
 * - EN problem list gains `timing ?out` (present participle) so "the database
 *   keeps timing out" — a real software failure — fires.
 * - "bot" is scoped to `(chat|telegram|matrix|discord|slack)[- ]?bots?`: on a
 *   shop floor a bare "bot" is an industrial robot (assembly/packing/
 *   pick-and-place), so those must NOT fire; qualified software bots DO.
 * - New ES anchor-only pattern (`por qué … <anchor> … falla/no responde`)
 *   mirrors the EN "why doesn't X work" recall path so ES software problems
 *   with no temporal marker still fire, while ops ES stays quiet.
 */
import { describe, it, expect } from 'vitest';
import { SKILL_TRIGGERS, type SkillTrigger } from '../src/skills.js';

const trigger = SKILL_TRIGGERS.find((t) => t.skillName === 'debugger') as SkillTrigger;
const fires = (message: string): boolean => trigger.patterns.some((p) => p.test(message));

describe('debugger trigger — spec 2026-07-17 §A adversarial sets', () => {
  it('exists and stays auto-mode', () => {
    expect(trigger).toBeDefined();
    expect(trigger.mode).toBe('auto');
  });

  it('has no /g flags (shared RegExp objects — sticky lastIndex would corrupt .test())', () => {
    for (const p of trigger.patterns) expect(p.global).toBe(false);
  });

  it('must NOT fire on EN ops problem-language (no software anchor)', () => {
    const cases = [
      "the line isn't working",
      'fix the shortage on line 3',
      "inventory isn't updating",
      'the BOM fails to load',
      'the line is broken, it keeps stopping',
      'production keeps failing every shift',
      "why doesn't the packing line work?",
      'the machine keeps jamming every shift',
      'we produce 500 units every time the shift changes',
      // Industrial-robot "bot" — a shop-floor robot, NOT a software bot.
      'the assembly bot keeps failing every shift',
      'fix the packing bot on line 3',
      'the pick-and-place bot stopped working',
    ];
    for (const m of cases) expect(fires(m), `should NOT fire: ${m}`).toBe(false);
  });

  it('must NOT fire on ES ops problem-language (no software anchor)', () => {
    const cases = [
      'la línea no funciona',
      'arregla el faltante de la línea 3',
      'el inventario no cuadra',
      'el BOM no carga bien',
      'arregla la máquina de coser de la estación 4',
    ];
    for (const m of cases) expect(fires(m), `should NOT fire: ${m}`).toBe(false);
  });

  it('MUST fire on real EN software problems', () => {
    const cases = [
      'the API returns 500 every time',
      'debug this script',
      'why does the container keep crashing',
      'I get an error when I try to run the server',
      'The app crashes every time I click submit',
      'This bug keeps happening after I update the config',
      'Why does the API not respond?',
      "Why won't my Docker container start?",
      // Software bot requires a chat/telegram/… qualifier (see bot scoping).
      'My telegram bot stopped working after the last update',
      'the chat bot keeps failing every time I deploy',
      'Can you fix this error in the database query?',
      'I need to fix the API endpoint',
      // Present-participle "timing out" (real software failure).
      'the database keeps timing out',
    ];
    for (const m of cases) expect(fires(m), `should fire: ${m}`).toBe(true);
  });

  it('MUST fire on real ES software problems (same anchor requirement)', () => {
    const cases = [
      '¿por qué la API se cae cada vez?',
      'depura este script',
      'el servidor se reinicia solo',
      'el bot de telegram no responde',
      'la aplicación truena cuando subo un archivo',
      // ES anchor-only recall path (no temporal marker).
      'revisa por qué el script falla',
      'por qué el servidor no responde',
    ];
    for (const m of cases) expect(fires(m), `should fire: ${m}`).toBe(true);
  });

  it('keeps firing on explicit debug/troubleshoot verbs without an anchor', () => {
    expect(fires('Can you help me debug this function?')).toBe(true);
    expect(fires('I need to troubleshoot my network connection')).toBe(true);
  });

  it('knowledge questions never fire', () => {
    expect(fires('What is an error?')).toBe(false);
    expect(fires('Define the word error')).toBe(false);
    expect(fires('¿qué es un stack trace?')).toBe(false);
  });
});
