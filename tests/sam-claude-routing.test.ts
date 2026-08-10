import { describe, it, expect, afterEach } from 'vitest';
import {
  isSamDataTurn,
  resolveSamTurnRoute,
  isNovalinkDataTurn,
  SAM_ABORT_MESSAGE,
  SAM_CLAUDE_FOOTER,
  SAM_LOCAL_FOOTER,
  SAM_UNVERIFIED_BANNER,
  isClaudeFailureResponse,
  finalizeSamClaudeTurn,
  finalizeSamLocalTurn,
  finalizeUnpinnedSamLocalTurn,
  SAM_LOCAL_UNPINNED_FOOTER,
  sendWithSamAbortGuard,
  FALLBACK_DISCLOSURE,
} from '../src/providers/router.js';
import { buildClaudeTimeoutError } from '../src/circuit-breaker.js';
import { buildClaudeSubprocessEnv } from '../src/providers/claude.js';
import type { AIResponse } from '../src/providers/types.js';

// spec 2026-07-13 §3 — SAM turns must not be answered by the local model by
// default (Task 9 live smoke 2026-07-10: qwen3.5:4b fabricated complete
// analyses tables on 2 of 3 sam-bucket turns). Vocabulary is the rc.135
// adversarially-probed bucket regex, re-exported — these cases mirror
// tests/local-buckets.test.ts so a vocabulary drift breaks both suites.
describe('isSamDataTurn', () => {
  it('detects EN SAM asks', () => {
    expect(isSamDataTurn('what are the standard allowed minutes for the assault pant?')).toBe(true);
    expect(isSamDataTurn('draft a sam analysis from this tech pack')).toBe(true);
    expect(isSamDataTurn('show me the measured times for bastillar')).toBe(true);
    expect(isSamDataTurn('run a sam health check')).toBe(true);
  });
  it('detects ES SAM asks', () => {
    expect(isSamDataTurn('dame los minutos estándar del análisis de sam')).toBe(true);
    expect(isSamDataTurn('cuál es el costo por pieza de este producto')).toBe(true);
  });
  it('does not fire on bare "Sam" as a person name or general chat', () => {
    expect(isSamDataTurn('Sam said hi about the meeting')).toBe(false);
    expect(isSamDataTurn('write me a poem about the ocean')).toBe(false);
  });
  // rc.137 — live-evidence re-smoke (2026-07-13): the exact miss from the
  // spec addendum, now caught via the acronym co-occurrence vocabulary.
  it('detects the rc.137 live-miss phrase via the acronym co-occurrence pattern', () => {
    expect(isSamDataTurn('What analyses are stored in SAM right now?')).toBe(true);
  });
});

describe('resolveSamTurnRoute', () => {
  const samAsk = 'draft a sam analysis from this tech pack';

  it('returns null when SAM env is not configured (gate)', () => {
    expect(resolveSamTurnRoute({ samConfigured: false, message: samAsk, samRoute: 'auto' })).toBeNull();
  });
  it('returns null for non-SAM messages', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: 'hello there', samRoute: 'auto' })).toBeNull();
  });
  it('auto (default, incl. missing/unknown column values) and claude → claude', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'auto' })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: undefined })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: null })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'garbage' })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'claude' })).toBe('claude');
  });
  it('local → local (explicit opt-in, LAN-only reads)', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'local' })).toBe('local');
  });

  // Precedence (spec §3): a turn matching BOTH the SAM vocabulary and
  // NOVALINK_DATA_PATTERNS is a SAM turn — data-quality wins. Enforced by
  // call order in getProviderForChat (SAM pin runs before the auto-route
  // block that hosts the novalink pin); this test pins the both-match input.
  it('a message matching both SAM and NovaLink vocabularies resolves as a SAM turn', () => {
    const both = 'necesito el análisis de sam para los faltantes de la compañía 1054';
    expect(isSamDataTurn(both)).toBe(true);
    expect(isNovalinkDataTurn(both)).toBe(true);
    expect(resolveSamTurnRoute({ samConfigured: true, message: both, samRoute: 'auto' })).toBe('claude');
  });
});

// Abort beats fabricate (spec 2026-07-13 §3). ClaudeProvider.sendMessage
// never sets `failed` — it RESOLVES with error text on exit≠0
// (claude.ts: "Claude CLI error (exit N): …") and on timeout kill
// (buildClaudeTimeoutError), and only rejects on spawn failure (handled
// separately in the router's try/catch). These tests mock a Claude failure
// with those exact response shapes.
describe('isClaudeFailureResponse', () => {
  it('detects the exit-code error shape', () => {
    expect(isClaudeFailureResponse({
      provider: 'claude',
      text: 'Claude CLI error (exit 1): fetch failed',
    })).toBe(true);
  });
  it('detects the timeout shape (via the REAL builder — pins the substring coupling)', () => {
    expect(isClaudeFailureResponse({
      provider: 'claude',
      text: buildClaudeTimeoutError(600_000),
    })).toBe(true);
  });
  it('detects an empty (null-text) Claude response as failure', () => {
    expect(isClaudeFailureResponse({ provider: 'claude', text: null })).toBe(true);
  });
  it('does not fire on a normal Claude answer or on Ollama responses', () => {
    expect(isClaudeFailureResponse({ provider: 'claude', text: 'Analysis 3 is Hoodie+Tank, 51.148 min.' })).toBe(false);
    expect(isClaudeFailureResponse({ provider: 'ollama', text: null })).toBe(false);
  });
});

describe('finalizeSamClaudeTurn (abort + provenance footer)', () => {
  it('replaces a failed Claude response with the bilingual abort message', () => {
    const out = finalizeSamClaudeTurn({ provider: 'claude', text: 'Claude CLI error (exit 1): boom' });
    expect(out.text).toBe(SAM_ABORT_MESSAGE);
    expect(out.failed).toBe(true);
  });
  it('appends the exact footer to a successful reply', () => {
    const out = finalizeSamClaudeTurn({ provider: 'claude', text: 'ID 3: 51.148 min (draft).' });
    expect(out.text).toBe('ID 3: 51.148 min (draft).\n\n— via Claude + SAM API');
    expect(out.text!.endsWith(SAM_CLAUDE_FOOTER)).toBe(true);
  });
  it('is idempotent — footer never doubles', () => {
    const once = finalizeSamClaudeTurn({ provider: 'claude', text: 'x' });
    expect(finalizeSamClaudeTurn(once).text).toBe(once.text);
  });
});

describe('finalizeSamLocalTurn (forced footer + UNVERIFIED banner)', () => {
  const base: AIResponse = { provider: 'ollama', text: 'the SAM for that product is 12.4 min' };

  it('zero sam_* executions (samToolStats absent) → banner prepended AND footer appended', () => {
    const out = finalizeSamLocalTurn({ ...base });
    expect(out.text!.startsWith(SAM_UNVERIFIED_BANNER)).toBe(true);
    expect(out.text!.endsWith(SAM_LOCAL_FOOTER)).toBe(true);
    expect(out.text).toBe(`${SAM_UNVERIFIED_BANNER}the SAM for that product is 12.4 min${SAM_LOCAL_FOOTER}`);
  });
  it('with sam_* executions this turn → footer only, no banner', () => {
    const out = finalizeSamLocalTurn({ ...base, samToolStats: { calls: 2, errors: 0 } });
    expect(out.text!.startsWith(SAM_UNVERIFIED_BANNER)).toBe(false);
    expect(out.text!.endsWith(SAM_LOCAL_FOOTER)).toBe(true);
  });
  it('all-errored sam_* calls still count as "tools ran" (errors are visible to the model, not silence)', () => {
    const out = finalizeSamLocalTurn({ ...base, samToolStats: { calls: 2, errors: 2 } });
    expect(out.text!.startsWith(SAM_UNVERIFIED_BANNER)).toBe(false);
  });
  it('is idempotent — neither banner nor footer doubles', () => {
    const once = finalizeSamLocalTurn({ ...base });
    expect(finalizeSamLocalTurn(once).text).toBe(once.text);
  });
  // Review Minor (2026-07-13): a hysteresis-bucketed novalink-pinned turn
  // rescued by the Claude soft fallback reaches this finalizer with
  // respondedVia claude — the response object is the Claude fallback
  // wholesale (provider: 'claude', FALLBACK_DISCLOSURE-prefixed). Stamping
  // "via local model (forced)" on it would be contradictory provenance.
  it('cloud-fallback rescue (provider claude) → returned unchanged: no local footer, no banner', () => {
    const rescued: AIResponse = { provider: 'claude', text: `${FALLBACK_DISCLOSURE}real answer from the fallback` };
    const out = finalizeSamLocalTurn(rescued);
    expect(out.text).toBe(rescued.text);
    expect(out.text!.endsWith(SAM_LOCAL_FOOTER)).toBe(false);
    expect(out.text!.startsWith(SAM_UNVERIFIED_BANNER)).toBe(false);
  });
});

// rc.137 — unpinned-local safety net: mid-loop widening or a vocabulary miss
// can let sam_* tools execute on a turn that was never pinned to the SAM
// path (samKind null/undefined). Label such answers so provenance is never
// silently unattributed — but never touch pinned turns (already finalized
// above) or Claude-path responses.
describe('finalizeUnpinnedSamLocalTurn (rc.137 safety net)', () => {
  it('unpinned ollama turn with samToolStats → footer appended exactly once', () => {
    const resp: AIResponse = { provider: 'ollama', text: 'SAM analysis 3 is 51.148 min', samToolStats: { calls: 1, errors: 0 } };
    const out = finalizeUnpinnedSamLocalTurn(resp, null);
    expect(out.text).toBe(`SAM analysis 3 is 51.148 min${SAM_LOCAL_UNPINNED_FOOTER}`);
  });
  it('is idempotent — passed through twice, footer does not duplicate', () => {
    const resp: AIResponse = { provider: 'ollama', text: 'SAM analysis 3 is 51.148 min', samToolStats: { calls: 1, errors: 0 } };
    const once = finalizeUnpinnedSamLocalTurn(resp, null);
    const twice = finalizeUnpinnedSamLocalTurn(once, undefined);
    expect(twice.text).toBe(once.text);
  });
  it('Claude-path response with no samToolStats → untouched', () => {
    const resp: AIResponse = { provider: 'claude', text: 'a normal claude answer' };
    const out = finalizeUnpinnedSamLocalTurn(resp, null);
    expect(out.text).toBe(resp.text);
  });
  it('ollama response WITHOUT samToolStats → untouched', () => {
    const resp: AIResponse = { provider: 'ollama', text: 'just a normal chat reply' };
    const out = finalizeUnpinnedSamLocalTurn(resp, null);
    expect(out.text).toBe(resp.text);
  });
  it('never applies when samKind is set — pinned turns already finalize elsewhere', () => {
    const resp: AIResponse = { provider: 'ollama', text: 'x', samToolStats: { calls: 1, errors: 0 } };
    expect(finalizeUnpinnedSamLocalTurn(resp, 'local').text).toBe('x');
    expect(finalizeUnpinnedSamLocalTurn(resp, 'claude').text).toBe('x');
  });
});

// Review Minor (2026-07-13): the throw→abort conversion is shared transport
// logic for BOTH provider.sendMessage call sites — the primary send AND the
// stale-session retry. Extracted so one tested code path covers both; a
// SAM→Claude turn whose stale retry spawn-throws must surface
// SAM_ABORT_MESSAGE, not a generic propagated error.
describe('sendWithSamAbortGuard (spawn-throw abort — primary + stale-session retry)', () => {
  const ctx = { chatId: 'c1', site: 'stale-retry' as const };

  it('a thrown provider call on a SAM→Claude turn resolves to the abort response', async () => {
    const out = await sendWithSamAbortGuard(true, async () => { throw new Error('spawn claude ENOENT'); }, ctx);
    expect(out.aborted).toBe(true);
    expect(out.response.text).toBe(SAM_ABORT_MESSAGE);
    expect(out.response.failed).toBe(true);
    expect(out.response.provider).toBe('claude');
  });
  it('a thrown call on a non-SAM turn rethrows unchanged', async () => {
    await expect(
      sendWithSamAbortGuard(false, async () => { throw new Error('boom'); }, { chatId: 'c1', site: 'primary' }),
    ).rejects.toThrow('boom');
  });
  it('a successful call passes the response through un-aborted', async () => {
    const resp: AIResponse = { provider: 'claude', text: 'ok' };
    const out = await sendWithSamAbortGuard(true, async () => resp, { chatId: 'c1', site: 'primary' });
    expect(out.aborted).toBe(false);
    expect(out.response).toBe(resp);
  });
});

// rc.141 — the Claude route reaches SAM through the `sam` bash wrapper, so the
// CLI's own per-command bash budget is part of the timeout ladder: curl 420 s
// < bash 450 s < CLAUDE_TIMEOUT_MS 600 s. Without this the CLI's 120 s bash
// default killed every ~2–6 min generate no matter how high --max-time went.
describe('buildClaudeSubprocessEnv (bash budget)', () => {
  const original = process.env.CLAUDE_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_TIMEOUT_MS;
    else process.env.CLAUDE_TIMEOUT_MS = original;
  });

  it('grants 450 s per bash command under the deployed 600 s turn budget', () => {
    process.env.CLAUDE_TIMEOUT_MS = '600000';
    const env = buildClaudeSubprocessEnv();
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('450000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('450000');
  });

  it('clamps to the turn budget so a bash call cannot outlive the subprocess', () => {
    process.env.CLAUDE_TIMEOUT_MS = '90000';
    const env = buildClaudeSubprocessEnv();
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('90000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('90000');
  });

  it('still strips the API-key names that would switch billing off the subscription', () => {
    process.env.ANTHROPIC_API_KEY = 'billing-sentinel-key-DO-NOT-USE';
    const env = buildClaudeSubprocessEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TERM).toBe('dumb');
    delete process.env.ANTHROPIC_API_KEY;
  });
});
