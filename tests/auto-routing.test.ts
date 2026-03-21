import { describe, it, expect } from 'vitest';
import {
  classifyMessage,
  CLAUDE_PATTERNS,
  SHORT_MESSAGE_THRESHOLD,
  LONG_MESSAGE_THRESHOLD,
} from '../src/providers/router.js';

/**
 * Tests the actual classifyMessage function exported from router.ts.
 * No duplication — if the source changes, tests test the real behavior.
 */

describe('auto-routing classifier (real function)', () => {
  describe('exports are accessible', () => {
    it('exports classifyMessage function', () => {
      expect(typeof classifyMessage).toBe('function');
    });

    it('exports CLAUDE_PATTERNS array', () => {
      expect(Array.isArray(CLAUDE_PATTERNS)).toBe(true);
      expect(CLAUDE_PATTERNS.length).toBeGreaterThan(0);
    });

    it('exports thresholds as numbers', () => {
      expect(typeof SHORT_MESSAGE_THRESHOLD).toBe('number');
      expect(typeof LONG_MESSAGE_THRESHOLD).toBe('number');
      expect(LONG_MESSAGE_THRESHOLD).toBeGreaterThan(SHORT_MESSAGE_THRESHOLD);
    });
  });

  describe('routes to Ollama (short/simple)', () => {
    it('routes short greetings', () => {
      expect(classifyMessage('hello')).toBe('ollama');
      expect(classifyMessage('hi there')).toBe('ollama');
      expect(classifyMessage('how are you?')).toBe('ollama');
    });

    it('routes simple questions', () => {
      expect(classifyMessage('what time is it?')).toBe('ollama');
      expect(classifyMessage('what is 2+2?')).toBe('ollama');
      expect(classifyMessage('tell me a joke')).toBe('ollama');
    });

    it('routes medium-length non-analytical messages', () => {
      expect(classifyMessage(
        'I was thinking about what to have for dinner tonight, maybe pizza or pasta would be good',
      )).toBe('ollama');
    });
  });

  describe('routes to Claude (complex/analytical)', () => {
    it('routes analysis requests', () => {
      expect(classifyMessage('analyze this data for trends')).toBe('claude');
      expect(classifyMessage('can you review my code?')).toBe('claude');
      expect(classifyMessage('evaluate the pros and cons of this approach')).toBe('claude');
      expect(classifyMessage('compare React vs Vue for this project')).toBe('claude');
    });

    it('routes document generation requests', () => {
      expect(classifyMessage('write a report on quarterly sales')).toBe('claude');
      expect(classifyMessage('draft an email to my manager')).toBe('claude');
      expect(classifyMessage('create a proposal for the new project')).toBe('claude');
      expect(classifyMessage('compose a story about a dragon')).toBe('claude');
    });

    it('routes code-related requests', () => {
      expect(classifyMessage('refactor this function to be more efficient')).toBe('claude');
      expect(classifyMessage('debug this issue with the login flow')).toBe('claude');
      expect(classifyMessage('do a code review of the pull request')).toBe('claude');
    });

    it('routes file format requests', () => {
      expect(classifyMessage('format this as xlsx')).toBe('claude');
      expect(classifyMessage('generate a report in pdf format')).toBe('claude');
      expect(classifyMessage('export the data to csv format')).toBe('claude');
    });

    it('routes long messages', () => {
      const longMessage = 'a'.repeat(LONG_MESSAGE_THRESHOLD + 1);
      expect(classifyMessage(longMessage)).toBe('claude');
    });

    it('routes messages with long code blocks', () => {
      const codeMessage = '```\n' + 'const x = 1;\n'.repeat(20) + '```';
      expect(classifyMessage(codeMessage)).toBe('claude');
    });
  });

  describe('edge cases', () => {
    it('handles empty messages', () => {
      expect(classifyMessage('')).toBe('ollama');
    });

    it('is case insensitive for patterns', () => {
      expect(classifyMessage('ANALYZE this problem')).toBe('claude');
      expect(classifyMessage('Write A Report')).toBe('claude');
    });

    it('does not false-trigger on irrelevant words', () => {
      expect(classifyMessage('nice weather')).toBe('ollama');
    });

    it('handles messages at threshold boundaries', () => {
      // Exactly at short threshold — no Claude patterns → ollama
      const msgAtShort = 'x'.repeat(SHORT_MESSAGE_THRESHOLD);
      expect(classifyMessage(msgAtShort)).toBe('ollama');

      // Exactly at long threshold — no Claude patterns → ollama
      const msgAtLong = 'x'.repeat(LONG_MESSAGE_THRESHOLD);
      expect(classifyMessage(msgAtLong)).toBe('ollama');

      // Just over long threshold → claude
      const msgOverLong = 'x'.repeat(LONG_MESSAGE_THRESHOLD + 1);
      expect(classifyMessage(msgOverLong)).toBe('claude');
    });
  });
});
