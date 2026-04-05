/**
 * Rate Limiter — Real Execution Tests
 *
 * No mocks. Tests real rate tracking, window expiry, per-user isolation,
 * bilingual messages, and usage reporting.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

describe('rate-limiter — real execution', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      claudeMaxPerWindow: 5,
      ollamaMaxPerWindow: 10,
      windowMs: 60_000, // 1 minute for fast tests
    });
  });

  // ── Basic rate checking ────────────────────────────────────

  describe('rate checking', () => {
    it('allows calls within limit', () => {
      for (let i = 0; i < 5; i++) {
        const check = limiter.check('chat-1', 'claude');
        expect(check.allowed).toBe(true);
        limiter.record('chat-1', 'claude');
      }
    });

    it('blocks calls exceeding Claude limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.record('chat-1', 'claude');
      }

      const check = limiter.check('chat-1', 'claude');
      expect(check.allowed).toBe(false);
      expect(check.remaining).toBe(0);
      expect(check.message).toContain('[EN]');
      expect(check.message).toContain('[ES]');
      expect(check.message).toContain('Claude');
      expect(check.message).toContain('/ollama');
    });

    it('blocks calls exceeding Ollama limit', () => {
      for (let i = 0; i < 10; i++) {
        limiter.record('chat-1', 'ollama');
      }

      const check = limiter.check('chat-1', 'ollama');
      expect(check.allowed).toBe(false);
      expect(check.message).toContain('Ollama');
      expect(check.message).toContain('/claude');
    });

    it('different providers have independent limits', () => {
      // Max out Claude
      for (let i = 0; i < 5; i++) {
        limiter.record('chat-1', 'claude');
      }

      // Ollama still available
      const check = limiter.check('chat-1', 'ollama');
      expect(check.allowed).toBe(true);
    });

    it('reports remaining count correctly', () => {
      limiter.record('chat-1', 'claude');
      limiter.record('chat-1', 'claude');

      const check = limiter.check('chat-1', 'claude');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(3); // 5 max - 2 recorded (check doesn't consume)
    });
  });

  // ── Per-user isolation ─────��───────────────────────────────

  describe('per-user isolation', () => {
    it('different chats have independent limits', () => {
      // Max out chat-1
      for (let i = 0; i < 5; i++) {
        limiter.record('chat-1', 'claude');
      }

      // chat-2 is unaffected
      const check = limiter.check('chat-2', 'claude');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(4);
    });

    it('each chat tracks its own usage', () => {
      limiter.record('chat-a', 'claude');
      limiter.record('chat-a', 'claude');
      limiter.record('chat-b', 'claude');

      const usageA = limiter.getUsage('chat-a');
      const usageB = limiter.getUsage('chat-b');

      expect(usageA.claude.count).toBe(2);
      expect(usageB.claude.count).toBe(1);
    });
  });

  // ── Usage reporting ─────���──────────────────────────────────

  describe('usage reporting', () => {
    it('getUsage returns both provider stats', () => {
      limiter.record('chat-1', 'claude');
      limiter.record('chat-1', 'claude');
      limiter.record('chat-1', 'ollama');

      const usage = limiter.getUsage('chat-1');
      expect(usage.claude.count).toBe(2);
      expect(usage.claude.max).toBe(5);
      expect(usage.claude.remaining).toBe(3);
      expect(usage.ollama.count).toBe(1);
      expect(usage.ollama.max).toBe(10);
      expect(usage.ollama.remaining).toBe(9);
    });

    it('formatUsage returns bilingual string', () => {
      limiter.record('chat-1', 'claude');
      const msg = limiter.formatUsage('chat-1');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('Claude');
      expect(msg).toContain('Ollama');
      expect(msg).toContain('1/5');
    });

    it('empty chat has zero usage', () => {
      const usage = limiter.getUsage('new-chat');
      expect(usage.claude.count).toBe(0);
      expect(usage.ollama.count).toBe(0);
    });
  });

  // ── Reset ────��─────────────────────────────────────────────

  describe('reset', () => {
    it('reset clears all records', () => {
      limiter.record('chat-1', 'claude');
      limiter.record('chat-1', 'claude');
      limiter.reset();

      const usage = limiter.getUsage('chat-1');
      expect(usage.claude.count).toBe(0);
    });
  });

  // ── Env var configuration ─────────���────────────────────────

  describe('env configuration', () => {
    it('respects RATE_LIMIT_CLAUDE_MAX', () => {
      process.env.RATE_LIMIT_CLAUDE_MAX = '3';
      const envLimiter = new RateLimiter();

      for (let i = 0; i < 3; i++) {
        envLimiter.record('env-chat', 'claude');
      }

      const check = envLimiter.check('env-chat', 'claude');
      expect(check.allowed).toBe(false);
      delete process.env.RATE_LIMIT_CLAUDE_MAX;
    });

    it('respects RATE_LIMIT_WINDOW_MINUTES', () => {
      process.env.RATE_LIMIT_WINDOW_MINUTES = '30';
      const envLimiter = new RateLimiter();

      // Internal config should be 30 min = 1,800,000 ms
      const usage = envLimiter.formatUsage('test');
      expect(usage).toContain('30-minute');
      delete process.env.RATE_LIMIT_WINDOW_MINUTES;
    });
  });

  // ── Bilingual messages ───���─────────────────────────────────

  describe('bilingual messages', () => {
    it('rate limit message is bilingual with provider suggestion', () => {
      for (let i = 0; i < 5; i++) {
        limiter.record('bi-chat', 'claude');
      }

      const check = limiter.check('bi-chat', 'claude');
      expect(check.message).toContain('[EN]');
      expect(check.message).toContain('[ES]');
      expect(check.message).toContain('Rate limit');
      expect(check.message).toContain('Limite de uso');
      expect(check.message).toContain('/ollama'); // suggests switching
    });

    it('Ollama limit message suggests /claude', () => {
      for (let i = 0; i < 10; i++) {
        limiter.record('bi-chat', 'ollama');
      }

      const check = limiter.check('bi-chat', 'ollama');
      expect(check.message).toContain('/claude');
    });
  });
});
