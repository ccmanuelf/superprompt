/**
 * Pipeline surgery Phase 1 — tool buckets for the local (Ollama) path.
 * Per turn the model receives core + ONE intent bucket (~15-20 schemas of ~48).
 * Selection uses cheap regexes with hysteresis: a conversation stays in its
 * bucket until a different bucket matches explicitly, protecting KV-cache
 * prefix stability (spec 2026-07-06-pipeline-surgery-design.md).
 *
 * IMPORTANT: name lists must track the registry. `tests/local-buckets-registry.test.ts`
 * (Task 5) asserts every name here exists in the registry and every registered
 * builtin tool is assigned to exactly one bucket.
 */

export type BucketId = 'core' | 'docs' | 'manufacturing' | 'simulation' | 'devops' | 'sam';

export const CORE_TOOLS: string[] = [
  'web_search', 'summarize_url', 'query_memory', 'save_memory',
  'get_time', 'system_info', 'kanban_manage', 'create_reminder',
  'read_bot_logs', 'take_screenshot',
];

export const BUCKET_TOOLS: Record<Exclude<BucketId, 'core'>, string[]> = {
  docs: [
    'parse_file', 'read_file', 'generate_document', 'review_report',
    'search_papers', 'manage_citations', 'read_documentation', 'search_documentation',
  ],
  manufacturing: [
    'capacity_planning', 'value_stream_map', 'toc_analysis', 'line_balance',
    'sigma_analysis', 'inventory_plan', 'spc_setup', 'fmea_manage', 'rca_manage',
    'novalink_list_queries', 'novalink_query', 'novalink_health',
  ],
  simulation: [
    'production_simulation', 'state_machine_simulator', 'design_of_experiments',
    'minizinc_optimize', 'conwip_heijunka', 'job_sequencer',
  ],
  devops: [
    'run_command',
    'github_list_repos', 'github_read_file', 'github_list_issues', 'github_list_prs',
    'github_clone_repo', 'github_diff', 'github_commit_push', 'github_create_pr',
    'render_list_services', 'render_deploy_status', 'render_get_logs',
  ],
  sam: [
    'sam_search', 'sam_get_analysis', 'sam_create', 'sam_generate',
    'sam_set_status', 'sam_export', 'sam_health',
  ],
};

/**
 * SAM trigger vocabulary — the SINGLE source consumed by BOTH the bucket
 * table below and the router's Claude-path SAM pin (spec 2026-07-13 §3).
 * Adversarially probed in rc.135; precision-first (mirrors
 * packs/sam/pack.yaml intent_patterns): bare "sam" is a person-name magnet,
 * so only SAM-specific phrases match. Deliberately NOT matched: "line
 * balance"/"balanceo" (stays manufacturing — line_balance lives there) and
 * bare "quote"/"cotización" (too generic). No /g flag: this object is shared
 * across callers, and a sticky lastIndex would corrupt .test() results.
 */
export const SAM_TRIGGER_PATTERN = /\b(standard allowed minutes?|minutos? est[aá]ndar|sam analys\w*|an[aá]lisis (de )?sam|sam (health|status|connection)|measured times?|stopwatch times?|tiempos? (medidos?|cronometrados?)|tech ?packs?|gsd|modapts|per.?piece (billing|cost|price)|(costo|precio) por pieza)\b/i;

/**
 * Bucket trigger regexes, EN+ES, checked in declaration order. Specific-vocabulary
 * buckets (simulation, manufacturing, devops) are checked before the generic
 * docs bucket, so domain-specific phrases containing generic doc words (e.g.
 * "genera un reporte de capacidad") route to the domain bucket, not docs.
 */
const BUCKET_PATTERNS: Array<[Exclude<BucketId, 'core'>, RegExp]> = [
  ['simulation', /\b(simulat\w*|simulaci[oó]n|doe\b|design of experiments|experiment\w*|state machine|m[aá]quina de estados|minizinc|conwip|heijunka|sequenc\w* (the )?jobs?|secuencia\w* (de )?trabajos?)\b/i],
  // sam before manufacturing: SAM asks often carry generic mfg words ("capacity",
  // "production") that would otherwise capture them. Vocabulary lives in the
  // exported SAM_TRIGGER_PATTERN above (shared with the router's Claude pin).
  ['sam', SAM_TRIGGER_PATTERN],
  ['manufacturing', /\b(bom|shortage|faltante|compan(y|ies)\s+\d+|companies\b|compa[ñn][ií]as?\s+\d+|capacity|capacidad|value stream|flujo de valor|toc\b|bottleneck|cuello de botella|balance|sigma|cpk|spc|control chart|carta de control|fmea|rca|root cause|causa ra[ií]z|inventory|inventario|novalink|producci[oó]n|production data)\b/i],
  ['devops', /\b(github|repo|repos|branch|commit|push|pull request|prs?\b|issues\b|(open|creat\w*|file|list|clos\w*|track\w*)\s+(an?\s+)?issues?\b|render|deploy|deployment|clone|run command|ejecuta\w* (el )?comando)\b/i],
  ['docs', /\b(pdf|docx|xlsx|pptx|csv|report|reporte|informe|document|documento|archivo|file|spreadsheet|hoja de c[aá]lculo|citation|cita|papers?|art[ií]culos?)\b/i],
];

export function selectBucket(message: string, currentBucket: BucketId | undefined): BucketId {
  for (const [bucket, pattern] of BUCKET_PATTERNS) {
    if (pattern.test(message)) return bucket;
  }
  return currentBucket ?? 'core';
}

export function toolNamesForBucket(bucket: BucketId): string[] {
  if (bucket === 'core') return [...CORE_TOOLS];
  return [...new Set([...CORE_TOOLS, ...BUCKET_TOOLS[bucket]])];
}

export function bucketForTool(toolName: string): BucketId | undefined {
  if (CORE_TOOLS.includes(toolName)) return 'core';
  for (const [bucket, names] of Object.entries(BUCKET_TOOLS)) {
    if (names.includes(toolName)) return bucket as BucketId;
  }
  return undefined;
}
