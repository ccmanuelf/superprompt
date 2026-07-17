import { describe, it, expect } from 'vitest';
import { buildLocalSystemPrompt, LOCAL_PERSONA, LOCAL_RULES } from '../src/providers/local-prompt.js';
import { estimateTokens } from '../src/context-budget.js';
import { EXECUTION_POSTURE } from '../src/execution-posture.js';
import { CAPABILITIES_PROMPT } from '../src/capabilities.js';

const VOLATILES = {
  sessionPrompt: '', platformNote: 'via Telegram Bot', voiceHint: '', mfgHint: 'MFG_HINT',
  uploadsManifest: 'UPLOADS', deliverableReminder: '', simulationScaffolding: '',
  languageHint: 'LANG_HINT', languageOverride: 'LANG_OVERRIDE', continuityAppend: '',
};

describe('LocalPromptAssembler', () => {
  it('frozen prefix is byte-identical across turns with different volatiles', () => {
    const a = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: 'CAPS', volatiles: VOLATILES });
    const b = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: 'CAPS', volatiles: { ...VOLATILES, uploadsManifest: 'DIFFERENT', mfgHint: 'OTHER' } });
    // Everything before the volatile marker must match byte-for-byte.
    const cut = (s: string) => s.slice(0, s.indexOf('## This turn'));
    expect(cut(a)).toBe(cut(b));
    expect(a.indexOf('## This turn')).toBeGreaterThan(0);
  });

  it('volatile blocks appear AFTER all static content', () => {
    const out = buildLocalSystemPrompt({ bucket: 'core', skillPrompt: 'SKILL', fullCapabilities: 'CAPS', volatiles: VOLATILES });
    expect(out.indexOf('UPLOADS')).toBeGreaterThan(out.indexOf('CAPS'));
    expect(out.indexOf('LANG_OVERRIDE')).toBeGreaterThan(out.indexOf('UPLOADS'));
  });

  it('caller systemPrompt (learning-session prompt) is threaded into the assembled prompt, after the This turn marker', () => {
    const out = buildLocalSystemPrompt({
      bucket: 'core', skillPrompt: '', fullCapabilities: 'CAPS',
      volatiles: { ...VOLATILES, sessionPrompt: 'LEARNING_SESSION_BLOCK' },
    });
    expect(out).toContain('LEARNING_SESSION_BLOCK');
    expect(out.indexOf('LEARNING_SESSION_BLOCK')).toBeGreaterThan(out.indexOf('## This turn'));
  });

  it('doc-schema prose ships only in the docs bucket', () => {
    const docs = buildLocalSystemPrompt({ bucket: 'docs', skillPrompt: '', fullCapabilities: '', volatiles: VOLATILES });
    const mfg = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: '', volatiles: VOLATILES });
    expect(docs).toContain('generate_document');
    expect(mfg.length).toBeLessThan(docs.length);
  });

  it('persona has no hardcoded tool-name dump', () => {
    expect(LOCAL_PERSONA).not.toContain('github_list_repos');
    expect(LOCAL_PERSONA).not.toContain('Available tools include');
  });

  it('static prose diet: persona+rules ≤ 1200 estimated tokens', () => {
    expect(estimateTokens(`${LOCAL_PERSONA}\n\n${LOCAL_RULES}`)).toBeLessThanOrEqual(1200);
  });

  it('frozen prefix snapshot (regression guard for KV stability)', () => {
    const out = buildLocalSystemPrompt({ bucket: 'core', skillPrompt: '', fullCapabilities: '', volatiles: { ...VOLATILES, mfgHint: '', uploadsManifest: '', languageHint: '', languageOverride: '', platformNote: '' } });
    expect(out).toMatchSnapshot();
  });

  // spec 2026-07-17 §B — the execution-posture block must be present on BOTH
  // provider paths with byte-identical wording. Single-sourced from
  // src/execution-posture.ts so drift is structurally impossible: this test
  // proves both prompt strings actually interpolate the shared constant.
  it('execution posture is present on BOTH paths, byte-identical (parity checklist row B)', () => {
    expect(EXECUTION_POSTURE).toContain('**Execution posture.**');
    expect(EXECUTION_POSTURE).toContain('Execute a clear instruction directly');
    expect(EXECUTION_POSTURE).toContain('A fresh explicit instruction outranks your memory');
    expect(EXECUTION_POSTURE).toContain('expected for new work — create it');
    expect(EXECUTION_POSTURE).toContain('only when genuinely blocked');
    expect(EXECUTION_POSTURE).toContain('Never invent a number.');
    expect(CAPABILITIES_PROMPT).toContain(EXECUTION_POSTURE);   // Claude path
    expect(LOCAL_RULES).toContain(EXECUTION_POSTURE);           // Ollama path
  });
});
