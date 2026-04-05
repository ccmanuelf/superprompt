/**
 * Circuit Breaker — Dual-Provider Tests (Ollama + Claude)
 *
 * Real execution tests for the circuit breaker pattern.
 * Validates detection patterns, state transitions, and bilingual messages
 * for both AI providers.
 */

import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  getClaudeTimeoutMs,
  buildClaudeTimeoutError,
} from '../src/circuit-breaker.js';

describe('circuit-breaker', () => {

  // ── Ollama: Tool Repetition Detection ──────────────────────

  describe('Ollama — tool repetition', () => {
    it('allows first 2 calls with same args', () => {
      const breaker = new CircuitBreaker({ maxRepetitions: 3 });
      const args = { query: 'test' };

      expect(breaker.shouldAllowExecution('web_search', args).allow).toBe(true);
      breaker.recordResult('web_search', args, { results: [] });

      expect(breaker.shouldAllowExecution('web_search', args).allow).toBe(true);
      breaker.recordResult('web_search', args, { results: [] });

      expect(breaker.state).toBe('closed');
    });

    it('trips to HALF_OPEN on 3rd identical call', () => {
      const breaker = new CircuitBreaker({ maxRepetitions: 3 });
      const args = { query: 'test' };

      for (let i = 0; i < 3; i++) {
        breaker.shouldAllowExecution('web_search', args);
        breaker.recordResult('web_search', args, { results: [] });
      }

      const check = breaker.shouldAllowExecution('web_search', args);
      expect(check.allow).toBe(false);
      expect(check.reason).toContain('[EN]');
      expect(check.reason).toContain('[ES]');
      expect(check.reason).toContain('web_search');
      expect(check.reason).toContain('identical arguments');
    });

    it('allows different args for same tool', () => {
      const breaker = new CircuitBreaker({ maxRepetitions: 3 });

      for (let i = 0; i < 5; i++) {
        const args = { query: `test-${i}` };
        expect(breaker.shouldAllowExecution('web_search', args).allow).toBe(true);
        breaker.recordResult('web_search', args, { results: [] });
      }
      expect(breaker.state).toBe('closed');
    });

    it('allows different tools with same args', () => {
      const breaker = new CircuitBreaker({ maxRepetitions: 3 });
      const args = { input: 'test' };

      for (let i = 0; i < 5; i++) {
        expect(breaker.shouldAllowExecution(`tool_${i}`, args).allow).toBe(true);
        breaker.recordResult(`tool_${i}`, args, { ok: true });
      }
      expect(breaker.state).toBe('closed');
    });
  });

  // ── Ollama: Consecutive Error Detection ────────────────────

  describe('Ollama — consecutive errors', () => {
    it('allows after 2 consecutive errors', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 3 });

      breaker.recordResult('tool_a', {}, { error: 'fail 1' });
      breaker.recordResult('tool_b', {}, { error: 'fail 2' });

      expect(breaker.state).toBe('closed');
      expect(breaker.shouldAllowExecution('tool_c', {}).allow).toBe(true);
    });

    it('trips on 3rd consecutive error', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 3 });

      breaker.recordResult('tool_a', {}, { error: 'fail 1' });
      breaker.recordResult('tool_b', {}, { error: 'fail 2' });
      breaker.recordResult('tool_c', {}, { error: 'fail 3' });

      expect(breaker.state).not.toBe('closed');
    });

    it('resets error count on success', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 3 });

      breaker.recordResult('tool_a', {}, { error: 'fail 1' });
      breaker.recordResult('tool_b', {}, { error: 'fail 2' });
      breaker.recordResult('tool_c', {}, { result: 'success' }); // resets

      expect(breaker.state).toBe('closed');

      breaker.recordResult('tool_d', {}, { error: 'fail again 1' });
      breaker.recordResult('tool_e', {}, { error: 'fail again 2' });

      expect(breaker.state).toBe('closed'); // only 2, not 3
    });

    it('bilingual error message on consecutive failures', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 3 });

      breaker.recordResult('t1', {}, { error: 'e1' });
      breaker.recordResult('t2', {}, { error: 'e2' });
      breaker.recordResult('t3', {}, { error: 'e3' });

      // 3 errors trips to HALF_OPEN, then next error trips to OPEN
      breaker.recordResult('t4', {}, { error: 'e4' });

      expect(breaker.state).toBe('open');
      expect(breaker.reason).toContain('[EN]');
      expect(breaker.reason).toContain('[ES]');
      expect(breaker.reason).toContain('consecutive');
      expect(breaker.reason).toContain('consecutivos');
    });
  });

  // ── Ollama: Stagnation Detection ───────────────────────────

  describe('Ollama — no-progress stagnation', () => {
    it('detects output stagnation after 3 stable iterations', () => {
      const breaker = new CircuitBreaker({ maxStaleIterations: 3 });

      breaker.recordIterationEnd(500);
      breaker.recordIterationEnd(505); // within 10% → stale
      breaker.recordIterationEnd(503); // stale
      breaker.recordIterationEnd(501); // 3rd stale → trips

      expect(breaker.state).not.toBe('closed');
    });

    it('resets stale count on significant output change', () => {
      const breaker = new CircuitBreaker({ maxStaleIterations: 3 });

      breaker.recordIterationEnd(500);
      breaker.recordIterationEnd(505); // stale
      breaker.recordIterationEnd(800); // significant change → reset
      breaker.recordIterationEnd(805); // 1st stale after reset

      expect(breaker.state).toBe('closed');
    });

    it('bilingual stagnation message', () => {
      const breaker = new CircuitBreaker({ maxStaleIterations: 2 });

      breaker.recordIterationEnd(100);
      breaker.recordIterationEnd(102);
      breaker.recordIterationEnd(101); // 2nd stale → trips

      expect(breaker.reason).toContain('[EN]');
      expect(breaker.reason).toContain('[ES]');
      expect(breaker.reason).toContain('progress');
      expect(breaker.reason).toContain('progreso');
    });
  });

  // ── State Transitions ──────────────────────────────────────

  describe('state transitions', () => {
    it('CLOSED → HALF_OPEN on first trip', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 2 });

      breaker.recordResult('t1', {}, { error: 'e1' });
      breaker.recordResult('t2', {}, { error: 'e2' });

      expect(breaker.state).toBe('half_open');
    });

    it('HALF_OPEN → CLOSED on success', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 2 });

      breaker.recordResult('t1', {}, { error: 'e1' });
      breaker.recordResult('t2', {}, { error: 'e2' });
      expect(breaker.state).toBe('half_open');

      breaker.recordResult('t3', {}, { result: 'recovered' });
      expect(breaker.state).toBe('closed');
    });

    it('HALF_OPEN → OPEN on second trip', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 1 });

      breaker.recordResult('t1', {}, { error: 'e1' }); // HALF_OPEN
      expect(breaker.state).toBe('half_open');

      breaker.recordResult('t2', {}, { error: 'e2' }); // OPEN
      expect(breaker.state).toBe('open');
    });

    it('reset() returns to CLOSED from any state', () => {
      const breaker = new CircuitBreaker({ maxConsecutiveErrors: 1 });

      breaker.recordResult('t1', {}, { error: 'e1' });
      breaker.recordResult('t2', {}, { error: 'e2' });
      expect(breaker.state).toBe('open');

      breaker.reset();
      expect(breaker.state).toBe('closed');
      expect(breaker.shouldAllowExecution('t3', {}).allow).toBe(true);
    });
  });

  // ── Normal Execution (transparent) ─────────────────────────

  describe('normal execution transparency', () => {
    it('does not interfere with normal tool calls', () => {
      const breaker = new CircuitBreaker();

      // 10 different tool calls — all should pass
      for (let i = 0; i < 10; i++) {
        expect(breaker.shouldAllowExecution(`tool_${i}`, { i }).allow).toBe(true);
        breaker.recordResult(`tool_${i}`, { i }, { result: `ok_${i}` });
      }

      expect(breaker.state).toBe('closed');
    });

    it('handles growing output without false stagnation', () => {
      const breaker = new CircuitBreaker({ maxStaleIterations: 3 });

      breaker.recordIterationEnd(100);
      breaker.recordIterationEnd(200);
      breaker.recordIterationEnd(350);
      breaker.recordIterationEnd(500);
      breaker.recordIterationEnd(800);

      expect(breaker.state).toBe('closed');
    });
  });

  // ── Claude: Subprocess Timeout ─────────────────────────────

  describe('Claude — subprocess timeout', () => {
    it('getClaudeTimeoutMs returns default 120000', () => {
      expect(getClaudeTimeoutMs()).toBe(120000);
    });

    it('getClaudeTimeoutMs respects CLAUDE_TIMEOUT_MS env', () => {
      process.env.CLAUDE_TIMEOUT_MS = '60000';
      expect(getClaudeTimeoutMs()).toBe(60000);
      delete process.env.CLAUDE_TIMEOUT_MS;
    });

    it('buildClaudeTimeoutError is bilingual', () => {
      const msg = buildClaudeTimeoutError(120000);
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('120s');
      expect(msg).toContain('/ollama');
    });
  });

  // ── Cross-Provider: Per-Chat Isolation ─────────────────────

  describe('cross-provider — per-chat isolation', () => {
    it('separate breakers for different chats do not interfere', () => {
      const breakerA = new CircuitBreaker({ maxConsecutiveErrors: 2 });
      const breakerB = new CircuitBreaker({ maxConsecutiveErrors: 2 });

      // Chat A fails
      breakerA.recordResult('t1', {}, { error: 'e1' });
      breakerA.recordResult('t2', {}, { error: 'e2' });

      // Chat B is unaffected
      expect(breakerB.state).toBe('closed');
      expect(breakerB.shouldAllowExecution('t1', {}).allow).toBe(true);
    });
  });
});
