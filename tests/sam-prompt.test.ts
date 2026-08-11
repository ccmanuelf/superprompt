/**
 * Tests for the NovaLink SAM system-prompt block (Claude provider path).
 *
 * The block must appear only when the deployment actually has SAM
 * (NOVALINK_SAM_URL + NOVALINK_SAM_API_KEY set) so SAM-less installs
 * don't carry a prompt for a wrapper they can't use. (spec 2026-07-13 §2)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('NOVALINK_SAM_PROMPT / SAM_CONFIGURED', () => {
  afterEach(() => {
    vi.doUnmock('../src/env.js');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is null / false when SAM is not configured', async () => {
    vi.resetModules();
    vi.stubEnv('NOVALINK_SAM_URL', '');
    vi.stubEnv('NOVALINK_SAM_API_KEY', '');
    vi.doMock('../src/env.js', () => ({ readEnvFile: () => ({}) }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.NOVALINK_SAM_PROMPT).toBeNull();
    expect(mod.SAM_CONFIGURED).toBe(false);
  });

  it('is null when only the URL is set (no key)', async () => {
    vi.resetModules();
    vi.stubEnv('NOVALINK_SAM_URL', '');
    vi.stubEnv('NOVALINK_SAM_API_KEY', '');
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ NOVALINK_SAM_URL: 'http://192.168.2.234:8080' }),
    }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.NOVALINK_SAM_PROMPT).toBeNull();
    expect(mod.SAM_CONFIGURED).toBe(false);
  });

  it('carries the contract essentials when configured', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({
        NOVALINK_SAM_URL: 'http://192.168.2.234:8080',
        NOVALINK_SAM_API_KEY: 'sam_test_fixture_key',
      }),
    }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.SAM_CONFIGURED).toBe(true);
    const p = mod.NOVALINK_SAM_PROMPT as string;
    // Wrapper contract — every subcommand from spec §1
    expect(p).toContain('sam health');
    expect(p).toContain('sam search <kind>');
    expect(p).toContain('measured_times');
    expect(p).toContain('sam get <id> [--full]');
    expect(p).toContain('sam create <client|product>');
    expect(p).toContain("sam generate '<json>'");
    expect(p).toContain('sam set-status <id> <status>');
    expect(p).toContain('sam export <id>');
    // Error convention
    expect(p).toContain('`detail`');
    // §3 methodology essentials
    expect(p).toContain('15% PFD');
    expect(p).toContain('machine dwell');
    expect(p).toContain('[VALIDATED]');
    expect(p).toContain('262 measured');
    expect(p).toContain('never invent figures');
    // Write posture (spec 2026-07-17 §C): ordinary writes execute directly;
    // generate keeps ONE heads-up; governed library writes keep per-item gates.
    expect(p).toContain('### Write posture (execute, then report)');
    expect(p).toContain('need NO confirmation: execute directly');
    expect(p).toContain('costs SAM-server credits, and the result will be stored');
    expect(p).not.toContain('Write confirmation rule (MANDATORY)');
    // generate cost/latency guidance
    expect(p).toContain('5–15 min');
    // rc.143 — a client timeout is NOT a failure: SAM stores the draft anyway
    // and the wrapper polls it back. The model must report the recovered
    // result instead of firing a second generate (duplicate-analysis guard).
    expect(p).toContain('_recovered_after_client_timeout');
    expect(p).toContain('never fire a second generate');
    expect(p).toContain('"persist": false');
    // rc.145 — the turn is ONE-SHOT. Live 2026-08-11 the model called
    // generate-mm with run_in_background:true (confirmed in the CLI session
    // transcript), replied "I'll report back as soon as it completes", and
    // ended the turn. SAM finished analysis 48 at 15:05:23 UTC and the user
    // was never told. Backgrounding also bypasses rc.143's curl+poll recovery
    // entirely, since the model never sees the wrapper's return value.
    expect(p).toContain('run_in_background');
    expect(p).toContain('ONE-SHOT');
    // rc.146 — SAM's own stop-the-line verdict. It rides at the TOP level of
    // every analysis (SAM projected it out of full_json on 2026-08-11), so it
    // survives `strip_full_json`; before that it sat at
    // full_json.recompute.quote_gate and our strip deleted it, which is why
    // analyses 45-49 were reported as clean results while SAM was refusing to
    // certify all five. Report it, never enforce it.
    expect(p).toContain('quote_gate');
    expect(p).toContain('"quotable": false');
    expect(p).toContain('reporting the gate, NOT enforcing it');
    // rc.146 — status semantics read backwards: `review` is the engine saying
    // it does NOT stand behind the analysis, not a workflow promotion. Writing
    // draft/review ourselves would forge an engine verdict.
    expect(p).toContain('draft is the GOOD state');
    expect(p).toContain('NOT a promotion from draft');
    expect(p).toContain('superseded');
    // File delivery marker
    expect(p).toContain('[send-file:');
    // rc.144 — the marker is an ACTION, not an illustration. Live 2026-08-10
    // 20:14:29 UTC the model wrote it as a placeholder while merely offering an
    // export it had not run (`(\`[send-file:...]\`)`); the platform strips every
    // occurrence, so the user saw "te exporto el Excel ahora mismo (``)." A
    // placeholder mangles the sentence; a copied stale path would ship the
    // wrong workbook — neither is catchable at the platform layer.
    expect(p).toContain('never as an example or placeholder');
    // Ingest redirect
    expect(p).toContain('web UI');
    // Never teach the raw key
    expect(p).not.toContain('sam_test_fixture_key');
  });

  it('carries the Phase-2 analytics contract (v1.1, spec 2026-07-14)', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({
        NOVALINK_SAM_URL: 'http://192.168.2.234:8080',
        NOVALINK_SAM_API_KEY: 'sam_test_fixture_key',
      }),
    }));
    const mod = await import('../src/providers/sam-prompt.js');
    const p = mod.NOVALINK_SAM_PROMPT as string;
    // New named subcommands — every entry from spec §1
    expect(p).toContain('sam update <id>');
    expect(p).toContain('sam review <id> [--no-ai]');
    expect(p).toContain('sam balance <id>');
    expect(p).toContain('sam balance-whatif <id>');
    expect(p).toContain('sam scenarios <id>');
    expect(p).toContain("sam scenario-save <id> '<json>'");
    expect(p).toContain("sam estimate '<json>'");
    expect(p).toContain('sam cells');
    expect(p).toContain('sam cell <id>');
    expect(p).toContain('cell-create');
    expect(p).toContain('cell-update');
    expect(p).toContain('cell-simulate');
    expect(p).toContain('cell-erv');
    expect(p).toContain('sam cell-export <id>');
    expect(p).toContain('sam calc <operation|sequence|line-balance>');
    expect(p).toContain('sam library');
    expect(p).toContain('candidates-scan');
    expect(p).toContain('sam candidates');
    expect(p).toContain('sam api <METHOD> <path>');
    expect(p).toContain('sam openapi');
    expect(p).toContain("sam generate-mm '<json>' --file <path>");
    // generate-mm has no persist field — it always stores (rc.139 live-verified)
    expect(p).toContain('generate-mm ALWAYS stores the analysis');
    // Analytics semantics (spec §2)
    expect(p).toContain('takt = available minutes ÷ daily target');
    expect(p).toContain('round UP');
    expect(p).toContain('decoupled from operators');
    expect(p).toContain('distinct from PFD');
    expect(p).toContain('total_headcount');
    expect(p).toContain('balance_defaults');
    expect(p).toContain('good / too strict / too relaxed / outlier');
    expect(p).toContain('min_score');
    expect(p).toContain('NEVER force-match');
    expect(p).toContain('use_ai_for_gaps');
    expect(p).toContain('unmatched_types');
    // Provenance rule
    expect(p).toContain('ALWAYS state both');
    expect(p).toContain('validated > provisional > reference');
    // Governance (Luna presents, user decides)
    expect(p).toContain('Luna presents, user decides');
    expect(p).toContain('explicit PER-ITEM user confirmation');
    expect(p).toContain('Match before create');
    expect(p).toContain('never auto-approve');
    expect(p).toContain('Approvals never enter tier validated');
    // Relaxed write gate (spec 2026-07-17 §C): the blanket mutating-api
    // confirm is gone; cell-erv apply and governed writes keep their gates.
    expect(p).not.toContain('ANY mutating');
    expect(p).toContain('"apply": true');
    expect(p).toContain('cell-simulate (read-like)');
    expect(p).toContain('per-item confirmation, unchanged');
    // generate-mm guidance
    expect(p).toContain('at most 8 files');
    expect(p).toContain('12 MB');
    expect(p).toContain('uploads manifest');
    // cell-export joins the send-file flow
    expect(p).toContain('or `sam cell-export <id>`');
    // v1.0 essentials must survive (regression against accidental deletion)
    expect(p).toContain('15% PFD');
    expect(p).toContain('never invent figures');
    expect(p).toContain('[send-file:');
    expect(p).not.toContain('sam_test_fixture_key');
  });
});
