import { describe, it, expect } from 'vitest';
import { composeClaudeSystemPrompt } from '../src/providers/router.js';

const FIXED_PARTS = {
  platformIdentity: 'IDENTITY_BLOCK',
  voiceHint: '',
  systemPrompt: undefined,
  skillPrompt: 'SKILL_BLOCK',
  fullCapabilities: 'CAPS_BLOCK',
  mfgHint: '',
  uploadsManifest: 'UPLOADS_BLOCK',
  deliverableReminder: '',
  simulationScaffolding: '',
  languageOverride: 'LANG_OVERRIDE_BLOCK',
};

describe('Claude prompt freeze (pipeline surgery guard)', () => {
  it('composed Claude system prompt is byte-identical across the surgery', () => {
    // toMatchSnapshot pins the FULL composed string, including the verbatim
    // CLAUDE_PROVIDER_NOTICE/QUALITY_RULES/etc. constants. Any byte change to
    // the Claude branch — accidental or deliberate — fails this test.
    expect(composeClaudeSystemPrompt(FIXED_PARTS)).toMatchSnapshot();
  });
});
