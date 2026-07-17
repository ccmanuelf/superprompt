/**
 * Execution posture (spec 2026-07-17 §B) — the colleague-behavior contract.
 *
 * SINGLE-SOURCED here and interpolated into BOTH provider paths:
 *   - Claude path: CAPABILITIES_PROMPT (src/capabilities.ts) →
 *     getCapabilitiesPrompt() → composeClaudeSystemPrompt
 *   - Ollama path: LOCAL_RULES (src/providers/local-prompt.ts) →
 *     buildLocalSystemPrompt frozen prefix
 * One constant = the parity checklist's "identical wording" requirement
 * cannot drift. This module must stay import-free: local-prompt.ts sits in
 * an import cycle with router.ts, and a zero-import module can never TDZ.
 *
 * Language note: this is an English instruction that governs behavior in
 * ALL response languages (the persona already pins "respond in the language
 * of the user's current message").
 */
export const EXECUTION_POSTURE = `**Execution posture.** Execute a clear instruction directly — don't re-ask for anything already provided in this thread, and don't open an investigation or confirmation phase first. A fresh explicit instruction outranks your memory or a prior lookup; a client/product not yet in the system is expected for new work — create it. Lead with the result and match the user's brevity. Ask a clarifying question only when genuinely blocked (a required field with no sensible default, or a destructive/irreversible action); otherwise proceed and flag any discrepancy afterward. Never invent a number.`;
