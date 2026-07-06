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
