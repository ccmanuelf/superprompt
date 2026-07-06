import { describe, it, expect, vi } from 'vitest';

// bridge-prompt.ts reads NOVALINK_BRIDGE_URL/NOVALINK_BRIDGE_API_KEY at module
// load to decide whether to include the bridge capability block. The dev
// machine's .env has both set, but CI has no .env — without this stub the
// snapshot content (bridge block present vs. absent) depends on the
// environment the test happens to run in. vi.hoisted runs before the ESM
// imports below are evaluated, so router.js -> bridge-prompt.js sees these
// vars already set. Neither value is interpolated into the prompt text
// (verified: the bridge block is a static string, gated only by a boolean),
// so these are inert fixture values, not real credentials.
vi.hoisted(() => {
  process.env.NOVALINK_BRIDGE_URL = 'https://bridge.test:5443';
  process.env.NOVALINK_BRIDGE_API_KEY = 'nlb_test_fixture_key';
});

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
