/**
 * Opportunity B — proven static harness edits for the local qwen3.5 path
 * (from Self-Harness's retained Qwen3.5 edits, 2606.09498).
 *
 * B1: the tool-model system prompt must tell the model to verify a required
 *     deliverable actually exists before concluding (artifact-verify).
 * B2: on a tool error the loop injects recovery guidance that steers the model
 *     away from blindly repeating the same failing call.
 */

import { describe, it, expect } from 'vitest';
import { buildToolErrorRecoveryNote, TOOL_MODEL_SYSTEM_PROMPT } from '../src/providers/ollama.js';

describe('B2: tool-error recovery note', () => {
  it('names the failing tool and steers away from a blind retry', () => {
    const note = buildToolErrorRecoveryNote('web_search');
    expect(note).toContain('web_search');
    expect(note).toMatch(/same (tool|arguments)|change your approach|do not (repeat|call the same)/i);
  });
});

describe('B1: artifact-verify-before-conclude', () => {
  it('instructs the model to verify the deliverable exists before concluding', () => {
    expect(TOOL_MODEL_SYSTEM_PROMPT).toMatch(/verify|confirm/i);
    expect(TOOL_MODEL_SYSTEM_PROMPT).toMatch(/exist|was created|was written|file was/i);
  });
});
