#!/usr/bin/env node
// Phase 0 spike for pipeline surgery (spec 2026-07-06).
// Measures whether Ollama KV prefix reuse engages for our request shape, and
// the prompt-eval cost of tool schemas. Run on the target box:
//   OLLAMA_HOST=http://127.0.0.1:11434 MODEL=ministral-3:3b node scripts/bench-local-pipeline.mjs
// Prints one JSON line per scenario: {scenario, prompt_eval_count, prompt_eval_ms, total_ms}

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.MODEL || 'ministral-3:3b';

const STATIC_PREFIX = 'You are Luna, a helpful assistant. '.repeat(200); // ~1.4k tok stable block
const TOOL = (n) => ({
  type: 'function',
  function: {
    name: `bench_tool_${n}`,
    description: `Benchmark tool number ${n}. Does nothing useful but occupies schema space like a real tool definition with parameters.`,
    parameters: {
      type: 'object',
      properties: {
        alpha: { type: 'string', description: 'first parameter, a string input' },
        beta: { type: 'number', description: 'second parameter, a numeric input' },
      },
      required: ['alpha'],
    },
  },
});

async function chat(messages, tools) {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, messages, tools, stream: false, think: false,
      options: { num_ctx: 32768, temperature: 0.2, num_predict: 32 },
      keep_alive: '30m',
    }),
  });
  const body = await res.json();
  return {
    prompt_eval_count: body.prompt_eval_count,
    prompt_eval_ms: Math.round((body.prompt_eval_duration ?? 0) / 1e6),
    total_ms: Date.now() - t0,
  };
}

function report(scenario, r) {
  console.log(JSON.stringify({ scenario, ...r }));
}

const sys = { role: 'system', content: STATIC_PREFIX };
const tools20 = Array.from({ length: 20 }, (_, i) => TOOL(i));
const tools48 = Array.from({ length: 48 }, (_, i) => TOOL(i));

// 1. Cold turn (first eval of prefix + 48 schemas)
report('cold_48_tools', await chat([sys, { role: 'user', content: 'Say OK.' }], tools48));
// 2. Warm turn, identical prefix + same tools, new tail → KV reuse should show
//    prompt_eval_count << cold count if prefix caching engages.
report('warm_same_prefix', await chat([sys, { role: 'user', content: 'Say OK.' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Say OK again.' }], tools48));
// 3. Warm turn, one tool swapped (simulates bucket switch) → expect near-cold eval
const swapped = [...tools48.slice(0, 47), TOOL(99)];
report('warm_tool_set_changed', await chat([sys, { role: 'user', content: 'Say OK.' }], swapped));
// 4. Warm turn, prefix byte-mutated (simulates volatile block early in prompt)
report('warm_prefix_mutated', await chat([{ role: 'system', content: `note ${Date.now()}\n` + STATIC_PREFIX }, { role: 'user', content: 'Say OK.' }], tools48));
// 5. Schema cost: 20 tools vs 48 tools, cold-equivalent (different prefix to avoid cache)
report('cold_20_tools', await chat([{ role: 'system', content: STATIC_PREFIX + ' variant-20' }, { role: 'user', content: 'Say OK.' }], tools20));
