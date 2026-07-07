import { describe, it, expect } from 'vitest';
import { isNovalinkDataTurn } from '../src/providers/router.js';

describe('novalink-data classification', () => {
  it('detects EN prod-data asks', () => {
    expect(isNovalinkDataTurn('how many open shortages does company 1054 have?')).toBe(true);
    expect(isNovalinkDataTurn('query the bom status for the AS line')).toBe(true);
  });
  it('detects ES prod-data asks', () => {
    expect(isNovalinkDataTurn('cuántos faltantes tiene la compañía este mes')).toBe(true);
  });
  it('detects explicit novalink/bridge mentions', () => {
    expect(isNovalinkDataTurn('check novalink for the latest PO receipts')).toBe(true);
  });
  it('does NOT match general chat or generic analysis', () => {
    expect(isNovalinkDataTurn('write me a poem about the ocean')).toBe(false);
    expect(isNovalinkDataTurn('analyze this essay for tone')).toBe(false);
  });
});

// Task 8 review fix pass (2026-07-06) — every case below was verified with a
// standalone node regex probe against the candidate pattern set BEFORE the
// fix landed in router.ts. See .superpowers/sdd/task-8-report.md § Fix pass
// for the probe transcript.
describe('novalink-data classification — regex precision (Task 8 fix pass)', () => {
  describe('false-positive guards (must NOT pin to local)', () => {
    it('does not fire on a bare "shortage" with no business context', () => {
      expect(isNovalinkDataTurn('there is an egg shortage at the store this week')).toBe(false);
    });
    it('does not fire on "company <small number>" used as a duration, not an id', () => {
      expect(isNovalinkDataTurn('I have worked at this company 5 years and I love it')).toBe(false);
    });
    it('does not fire on "bridge" as a landmark, even with a distant "check"', () => {
      expect(isNovalinkDataTurn('we watched the golden gate bridge today, check this photo')).toBe(false);
    });
    it('does not fire on bare "wip" (dev/PR jargon, not manufacturing WIP)', () => {
      expect(isNovalinkDataTurn('this branch is still wip, please do not merge yet')).toBe(false);
    });
    it('does not fire on generic "production status" with no line/order/plant anchor', () => {
      expect(isNovalinkDataTurn('can you check my production status update for the album release')).toBe(false);
    });
  });

  describe('false-negative fixes (must pin to local)', () => {
    it('detects ES word-order "estado de producción"', () => {
      expect(isNovalinkDataTurn('cuál es el estado de producción de la línea AS')).toBe(true);
    });
    it('detects ES verb-first "consultar el bridge"', () => {
      expect(isNovalinkDataTurn('quiero consultar el bridge para ver los datos')).toBe(true);
    });
    it('detects plural accented "órdenes de compra"', () => {
      expect(isNovalinkDataTurn('cuántas órdenes de compra están pendientes')).toBe(true);
    });
    it('detects EN plural "work orders"', () => {
      expect(isNovalinkDataTurn('how many open work orders are there')).toBe(true);
    });
    it('detects EN plural "purchase orders"', () => {
      expect(isNovalinkDataTurn('list my purchase orders from last week')).toBe(true);
    });
    it('detects ES plural "órdenes de trabajo"', () => {
      expect(isNovalinkDataTurn('cuántas órdenes de trabajo están abiertas')).toBe(true);
    });
  });

  describe('sanity set (must keep matching after the fix)', () => {
    it('keeps matching "shortages" + id-bearing company', () => {
      expect(isNovalinkDataTurn('how many open shortages does company 1054 have?')).toBe(true);
    });
    it('keeps matching "bom status" for a line', () => {
      expect(isNovalinkDataTurn('query the bom status for the AS line')).toBe(true);
    });
    it('keeps matching bare "faltantes" with compañía context', () => {
      expect(isNovalinkDataTurn('cuántos faltantes tiene la compañía este mes')).toBe(true);
    });
    it('keeps matching explicit "novalink" + "PO receipts"', () => {
      expect(isNovalinkDataTurn('check novalink for the latest PO receipts')).toBe(true);
    });
  });
});

// Live-verified gap: "what is the inventory status for part WSCS150-US?" hit
// the real bridge (inventory-* / part-master-trade / part-locations
// endpoints, per bridge-prompt.ts's 29-endpoint catalog) but never pinned —
// NOVALINK_DATA_PATTERNS had no coverage for inventory/part-SKU/movements/
// visa-transactions vocabulary. Patterns below were probed standalone in
// node (bare regex, no router deps) before landing here — see the sanity
// probes for the precision-first bare-word traps this catalog vocabulary
// creates ("part" of a movie, "inventory" of life choices, "movements" of a
// symphony), the same lesson as the Task 8 fix pass above.
describe('novalink-data classification — catalog vocabulary (inventory/part/movements/visa)', () => {
  describe('must-match set (RED until patterns land)', () => {
    it('detects the live-verified EN example: inventory status for a part SKU', () => {
      expect(isNovalinkDataTurn('what is the inventory status for part WSCS150-US?')).toBe(true);
    });
    it('detects ES "inventario de la parte <SKU>"', () => {
      expect(isNovalinkDataTurn('inventario de la parte WSCS150-US')).toBe(true);
    });
    it('detects "part locations" for a company', () => {
      expect(isNovalinkDataTurn('show me part locations for ACME')).toBe(true);
    });
    it('detects warehouse movements anchored to a part', () => {
      expect(isNovalinkDataTurn('recent warehouse movements for part 4711-A')).toBe(true);
    });
  });

  describe('false-positive guards — bare catalog words used in everyday speech', () => {
    it('does not fire on "take inventory of my life choices"', () => {
      expect(isNovalinkDataTurn('take inventory of my life choices')).toBe(false);
    });
    it('does not fire on "the best part of the movie"', () => {
      expect(isNovalinkDataTurn('the best part of the movie')).toBe(false);
    });
    it('does not fire on "she played her part well"', () => {
      expect(isNovalinkDataTurn('she played her part well')).toBe(false);
    });
    it('does not fire on "movements of the symphony"', () => {
      expect(isNovalinkDataTurn('movements of the symphony')).toBe(false);
    });
  });
});

// Fix pass (2026-07-07) — reviewer-verified false positives found in the
// catalog-vocabulary patterns above. Each case here was probed standalone in
// node against the pre-fix patterns (all failed as RED, confirming the bug)
// and against the fixed patterns (all passed as GREEN) before landing.
describe('novalink-data classification — catalog vocabulary fix pass (reviewer-verified FPs)', () => {
  describe('part+SKU pattern requires a digit in the token', () => {
    it('does not fire on "part IMHO" (pure-letter jargon)', () => {
      expect(isNovalinkDataTurn('honestly the best part IMHO was the ending')).toBe(false);
    });
    it('does not fire on "part WELL" (pure-letter word)', () => {
      expect(isNovalinkDataTurn('she played her part WELL in the meeting')).toBe(false);
    });
    it('does not fire on "part URGENT" (pure-letter word)', () => {
      expect(isNovalinkDataTurn('mark this part URGENT before you leave')).toBe(false);
    });
    it('does not fire on ES "parte URGENTE" (pure-letter word)', () => {
      expect(isNovalinkDataTurn('marca esta parte URGENTE antes de irte')).toBe(false);
    });
    it('does not fire on "part TIME-OFF" (pure-letter hyphenated word)', () => {
      expect(isNovalinkDataTurn('part TIME-OFF')).toBe(false);
    });
    it('does not fire on "part NUMBER-ONE-FAN" (pure-letter hyphenated phrase)', () => {
      expect(isNovalinkDataTurn('part NUMBER-ONE-FAN')).toBe(false);
    });
    it('keeps matching a real digit-bearing SKU (EN)', () => {
      expect(isNovalinkDataTurn('what is the inventory status for part WSCS150-US?')).toBe(true);
    });
    it('keeps matching a real digit-bearing SKU (numeric)', () => {
      expect(isNovalinkDataTurn('recent warehouse movements for part 4711-A')).toBe(true);
    });
    it('keeps matching a real digit-bearing SKU (ES)', () => {
      expect(isNovalinkDataTurn('parte WSCS150-US')).toBe(true);
    });
  });

  describe('inventario/movements co-occurrence anchors no longer accept bare part/parte', () => {
    it('does not fire on "el inventario es parte de la auditoría anual"', () => {
      expect(isNovalinkDataTurn('el inventario es parte de la auditoría anual')).toBe(false);
    });
    it('does not fire on "hacer inventario es parte de mi trabajo"', () => {
      expect(isNovalinkDataTurn('hacer inventario es parte de mi trabajo')).toBe(false);
    });
    it('does not fire on "movements ... part of a larger symphony cycle"', () => {
      expect(isNovalinkDataTurn('the piece has three movements, part of a larger symphony cycle')).toBe(false);
    });
    it('keeps matching "inventario de la parte <SKU>"', () => {
      expect(isNovalinkDataTurn('inventario de la parte WSCS150-US')).toBe(true);
    });
  });

  describe('visa transactions require bounded business-context co-occurrence', () => {
    it('does not fire on a personal credit-card question', () => {
      expect(isNovalinkDataTurn('why was my visa transaction declined at the store')).toBe(false);
    });
    it('keeps matching a company visa-transactions report request', () => {
      expect(isNovalinkDataTurn('show me the visa transactions report for the company')).toBe(true);
    });
  });
});
