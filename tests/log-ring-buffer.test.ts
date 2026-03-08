import { describe, it, expect, beforeEach } from 'vitest';
import { getRecentLogs, clearLogBuffer, logger } from '../src/logger.js';

describe('LogRingBuffer', () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  it('captures log entries', () => {
    logger.info('test message 1');
    logger.info('test message 2');

    const logs = getRecentLogs(10);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const msgs = logs.map((l) => l.msg);
    expect(msgs).toContain('test message 1');
    expect(msgs).toContain('test message 2');
  });

  it('filters by level', () => {
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const warnAndAbove = getRecentLogs(100, 'warn');
    const levels = warnAndAbove.map((l) => l.level);
    expect(levels.every((l) => l === 'warn' || l === 'error' || l === 'fatal')).toBe(true);
  });

  it('limits number of entries returned', () => {
    for (let i = 0; i < 10; i++) {
      logger.info(`message ${i}`);
    }

    const logs = getRecentLogs(3);
    expect(logs.length).toBe(3);
  });

  it('returns entries in chronological order', () => {
    logger.info('first');
    logger.info('second');
    logger.info('third');

    const logs = getRecentLogs(10);
    const infoLogs = logs.filter((l) => ['first', 'second', 'third'].includes(l.msg));
    expect(infoLogs[0].msg).toBe('first');
    expect(infoLogs[infoLogs.length - 1].msg).toBe('third');
  });

  it('handles clear', () => {
    logger.info('before clear');
    clearLogBuffer();
    const logs = getRecentLogs(10);
    expect(logs.length).toBe(0);
  });

  it('captures metadata from log objects', () => {
    logger.info({ tool: 'web_search', chatId: 'test123' }, 'executing tool');

    const logs = getRecentLogs(10);
    const toolLog = logs.find((l) => l.msg === 'executing tool');
    expect(toolLog).toBeDefined();
    expect(toolLog!.tool).toBe('web_search');
    expect(toolLog!.chatId).toBe('test123');
  });
});
