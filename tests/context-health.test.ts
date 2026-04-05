/**
 * Context Health Monitoring — Real Execution Tests
 *
 * No mocks. Tests real health tracking, status transitions,
 * bilingual suggestions, and provider-agnostic behavior.
 */

import { describe, it, expect } from 'vitest';
import { ContextHealthMonitor } from '../src/context-health.js';

describe('context-health — real execution', () => {

  // ── Status transitions ─────────────────────────────────────

  describe('health status transitions', () => {
    it('starts green with no messages', () => {
      const monitor = new ContextHealthMonitor();
      const report = monitor.getHealth('chat-1');
      expect(report.status).toBe('green');
      expect(report.messageCount).toBe(0);
    });

    it('stays green under yellow threshold', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 10 });
      for (let i = 0; i < 9; i++) {
        monitor.recordMessage('chat-1', `Message ${i}`);
      }
      expect(monitor.getHealth('chat-1').status).toBe('green');
    });

    it('transitions to yellow at threshold', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 10, redThreshold: 20 });
      for (let i = 0; i < 10; i++) {
        monitor.recordMessage('chat-1', `Message ${i}`);
      }
      expect(monitor.getHealth('chat-1').status).toBe('yellow');
    });

    it('transitions to red at threshold', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 5, redThreshold: 10 });
      for (let i = 0; i < 10; i++) {
        monitor.recordMessage('chat-1', `Message ${i}`);
      }
      expect(monitor.getHealth('chat-1').status).toBe('red');
    });

    it('resets to green on resetChat', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 5 });
      for (let i = 0; i < 10; i++) {
        monitor.recordMessage('chat-1', `Message ${i}`);
      }
      expect(monitor.getHealth('chat-1').status).not.toBe('green');

      monitor.resetChat('chat-1');
      expect(monitor.getHealth('chat-1').status).toBe('green');
    });
  });

  // ── Error tracking ─────────────────────────────────────────

  describe('error tracking', () => {
    it('errors upgrade status to yellow', () => {
      const monitor = new ContextHealthMonitor({ errorYellowThreshold: 3, yellowThreshold: 100 });
      for (let i = 0; i < 5; i++) monitor.recordMessage('chat-1', `msg ${i}`);
      for (let i = 0; i < 3; i++) monitor.recordError('chat-1');
      expect(monitor.getHealth('chat-1').status).toBe('yellow');
    });

    it('many errors upgrade to red', () => {
      const monitor = new ContextHealthMonitor({ errorRedThreshold: 5, redThreshold: 100 });
      for (let i = 0; i < 5; i++) monitor.recordMessage('chat-1', `msg ${i}`);
      for (let i = 0; i < 5; i++) monitor.recordError('chat-1');
      expect(monitor.getHealth('chat-1').status).toBe('red');
    });
  });

  // ── Repetition detection ───────────────────────────────────

  describe('repetition detection', () => {
    it('detects repeated identical queries', () => {
      const monitor = new ContextHealthMonitor({ minMessagesForCheck: 1, yellowThreshold: 100 });
      monitor.recordMessage('chat-1', 'what is the weather');
      monitor.recordMessage('chat-1', 'what is the weather');
      monitor.recordMessage('chat-1', 'what is the weather');
      monitor.recordMessage('chat-1', 'what is the weather');

      const report = monitor.getHealth('chat-1');
      expect(report.repetitionCount).toBeGreaterThan(0);
    });

    it('does not flag different queries as repetitions', () => {
      const monitor = new ContextHealthMonitor();
      monitor.recordMessage('chat-1', 'what is the weather');
      monitor.recordMessage('chat-1', 'calculate my budget');
      monitor.recordMessage('chat-1', 'show production report');

      expect(monitor.getHealth('chat-1').repetitionCount).toBe(0);
    });
  });

  // ── Quality tracking ───────────────────────────────────────

  describe('quality tracking', () => {
    it('tracks average quality score', () => {
      const monitor = new ContextHealthMonitor();
      monitor.recordMessage('chat-1', 'msg 1', 80);
      monitor.recordMessage('chat-1', 'msg 2', 60);
      monitor.recordMessage('chat-1', 'msg 3', 100);

      const report = monitor.getHealth('chat-1');
      expect(report.avgQualityScore).toBe(80); // (80+60+100)/3
    });

    it('defaults to 100 when no quality scores', () => {
      const monitor = new ContextHealthMonitor();
      monitor.recordMessage('chat-1', 'msg without score');
      expect(monitor.getHealth('chat-1').avgQualityScore).toBe(100);
    });
  });

  // ── Suggestions (bilingual) ────────────────────────────────

  describe('health suggestions', () => {
    it('returns null when healthy', () => {
      const monitor = new ContextHealthMonitor({ minMessagesForCheck: 5 });
      for (let i = 0; i < 6; i++) monitor.recordMessage('chat-1', `msg ${i}`);
      expect(monitor.checkAndSuggest('chat-1')).toBeNull();
    });

    it('returns bilingual yellow suggestion at threshold', () => {
      const monitor = new ContextHealthMonitor({
        yellowThreshold: 5, redThreshold: 20, minMessagesForCheck: 1,
      });
      for (let i = 0; i < 5; i++) monitor.recordMessage('chat-1', `msg ${i}`);

      const suggestion = monitor.checkAndSuggest('chat-1');
      expect(suggestion).not.toBeNull();
      expect(suggestion).toContain('[EN]');
      expect(suggestion).toContain('[ES]');
      expect(suggestion).toContain('/newchat');
    });

    it('returns bilingual red suggestion at threshold', () => {
      const monitor = new ContextHealthMonitor({
        yellowThreshold: 3, redThreshold: 5, minMessagesForCheck: 1,
      });
      for (let i = 0; i < 5; i++) monitor.recordMessage('chat-1', `msg ${i}`);

      const suggestion = monitor.checkAndSuggest('chat-1');
      expect(suggestion).toContain('⚠️');
      expect(suggestion).toContain('degraded');
      expect(suggestion).toContain('degradada');
    });

    it('respects cooldown — no repeated suggestions', () => {
      const monitor = new ContextHealthMonitor({
        yellowThreshold: 3, minMessagesForCheck: 1, suggestionCooldownMs: 60000,
      });
      for (let i = 0; i < 5; i++) monitor.recordMessage('chat-1', `msg ${i}`);

      const first = monitor.checkAndSuggest('chat-1');
      expect(first).not.toBeNull();

      const second = monitor.checkAndSuggest('chat-1');
      expect(second).toBeNull(); // cooldown active
    });
  });

  // ── Per-chat isolation (both providers) ────────────────────

  describe('per-chat isolation — both providers', () => {
    it('different chats have independent health', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 5 });

      for (let i = 0; i < 10; i++) monitor.recordMessage('chat-a', `msg ${i}`);
      monitor.recordMessage('chat-b', 'single message');

      expect(monitor.getHealth('chat-a').status).not.toBe('green');
      expect(monitor.getHealth('chat-b').status).toBe('green');
    });

    it('health tracking is provider-agnostic', () => {
      // Same monitor works regardless of which provider handles the chat
      const monitor = new ContextHealthMonitor();

      // Simulate Claude chat
      monitor.recordMessage('claude-chat', 'Claude message 1');
      monitor.recordMessage('claude-chat', 'Claude message 2');

      // Simulate Ollama chat
      monitor.recordMessage('ollama-chat', 'Ollama message 1');

      // Both tracked independently
      expect(monitor.getHealth('claude-chat').messageCount).toBe(2);
      expect(monitor.getHealth('ollama-chat').messageCount).toBe(1);
    });
  });

  // ── Formatting ─────────────────────────────────────────────

  describe('formatting', () => {
    it('formatHealth returns bilingual status', () => {
      const monitor = new ContextHealthMonitor();
      monitor.recordMessage('chat-1', 'test', 90);

      const msg = monitor.formatHealth('chat-1');
      expect(msg).toContain('[EN]');
      expect(msg).toContain('[ES]');
      expect(msg).toContain('🟢');
      expect(msg).toContain('GREEN');
    });

    it('formatHealth shows yellow when degraded', () => {
      const monitor = new ContextHealthMonitor({ yellowThreshold: 3 });
      for (let i = 0; i < 3; i++) monitor.recordMessage('chat-1', `msg ${i}`);

      const msg = monitor.formatHealth('chat-1');
      expect(msg).toContain('🟡');
      expect(msg).toContain('YELLOW');
    });
  });
});
