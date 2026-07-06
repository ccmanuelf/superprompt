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
