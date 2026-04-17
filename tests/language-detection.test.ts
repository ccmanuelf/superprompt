/**
 * rc.76 — per-turn language detection for the hard language override.
 *
 * Guards the fix for an observed bug where the continuity bridge
 * seeded Spanish-heavy history and qwen3.5:latest drew a Spanish
 * reply to a plain English request. The detector + override together
 * force language parity with the CURRENT message, not the history.
 */
import { describe, it, expect } from 'vitest';
import { detectMessageLanguage } from '../src/providers/router.js';

describe('detectMessageLanguage (rc.76)', () => {
  describe('English detection', () => {
    const cases = [
      'Please generate the final PDF report in English',
      'Run the Monte Carlo simulation based on the Excel data',
      'I need a comprehensive analysis of the bottleneck',
      'Can you create a spreadsheet with the results for me?',
      'Use the parsed data and do not ask clarifying questions',
    ];
    it.each(cases)('classifies as "en": %s', (msg) => {
      expect(detectMessageLanguage(msg)).toBe('en');
    });
  });

  describe('Spanish detection', () => {
    const cases = [
      'Por favor genera el reporte PDF final en inglés',
      'Corre la simulación Monte Carlo basada en los datos del Excel',
      'Necesito un análisis completo del cuello de botella',
      '¿Puedes crear una hoja de cálculo con los resultados?',
      'Usa los datos y no hagas preguntas innecesarias',
    ];
    it.each(cases)('classifies as "es": %s', (msg) => {
      expect(detectMessageLanguage(msg)).toBe('es');
    });
  });

  describe('unknown for ambiguous / empty', () => {
    it('returns unknown for undefined', () => {
      expect(detectMessageLanguage(undefined)).toBe('unknown');
    });
    it('returns unknown for empty string', () => {
      expect(detectMessageLanguage('')).toBe('unknown');
    });
    it('returns unknown for messages with no stopwords', () => {
      expect(detectMessageLanguage('PDF')).toBe('unknown');
      expect(detectMessageLanguage('Monte Carlo simulation')).toBe('unknown');
    });
    it('returns unknown when a single stopword match could be incidental (short message)', () => {
      // "proceed" alone shouldn't force EN — one stopword match is below
      // the ≥2 threshold.
      expect(detectMessageLanguage('Proceed')).toBe('unknown');
    });
  });

  describe('resilience to mixed-language and code-like content', () => {
    it('prefers the dominant language when mixed (EN majority)', () => {
      // User quotes a Spanish fragment but writes in English
      expect(
        detectMessageLanguage(
          'Generate a PDF report that covers the "Datos Base CT" sheet and the bottleneck analysis',
        ),
      ).toBe('en');
    });
    it('prefers the dominant language when mixed (ES majority)', () => {
      expect(
        detectMessageLanguage(
          'Genera el reporte PDF que cubra la hoja "Datos Base CT" y el análisis de bottleneck',
        ),
      ).toBe('es');
    });
    it('ignores file paths and code-like tokens', () => {
      expect(
        detectMessageLanguage(
          '/app/workspace/uploads/file.xlsx please generate a pdf report with the results',
        ),
      ).toBe('en');
    });
  });
});
