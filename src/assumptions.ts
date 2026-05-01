/**
 * Luna assumption registry — Phase 2 of the dual-view calculation
 * architecture (rc.100, see docs/audit/calculation-modules-audit.md).
 *
 * Stores calculation assumptions in three tables:
 *   - luna_assumptions: scoped (global / pack / user) values, append-only
 *     via status transitions (active → retired) rather than hard delete.
 *   - luna_assumption_changes: full change audit log.
 *   - luna_metric_assumption_dependencies: which metrics depend on which
 *     assumption names (informational).
 *
 * Resolution precedence (first match wins):
 *   user → pack (in activation order) → global → built-in default
 *
 * Phase 2 scope: schema + resolver + CRUD primitives + built-in catalog.
 * The Phase 1 calculation wrappers do NOT yet call resolveAssumption — that
 * wiring is Phase 3 work.
 *
 * Locked spec-owner decisions (rc.100):
 *   - No Telegram CRUD commands. Web UI only — built in a later sub-rc.
 *   - First-match-wins by pack activation order; no precedence config.
 *   - simulation_random_seed_policy is OUT of v1 (Q3: site_adjusted affects
 *     input distributions only, not stochastic-control parameters).
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Types ────────────────────────────────────────────────────

export type AssumptionScope = 'global' | 'pack' | 'user';
export type AssumptionStatus = 'active' | 'retired';

export interface LunaAssumption {
  id: string;
  scope_type: AssumptionScope;
  scope_id: string | null;
  assumption_name: string;
  value: unknown;
  rationale: string;
  effective_date: number | null;
  expiration_date: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  status: AssumptionStatus;
}

export interface AssumptionChangeRow {
  id: string;
  assumption_id: string;
  changed_by: string;
  changed_at: number;
  previous_value: unknown;
  new_value: unknown;
  change_reason: string;
}

export interface MetricAssumptionDependency {
  metric_name: string;
  assumption_name: string;
  usage_notes: string;
}

export interface ResolveContext {
  userId?: string;
  activePacks?: string[]; // ordered: first match wins
}

export interface ResolvedAssumption {
  name: string;
  value: unknown;
  sourceScope: AssumptionScope | 'default';
  rationale: string;
  scopeId: string | null;
}

export interface SetAssumptionInput {
  scope_type: AssumptionScope;
  scope_id: string | null;
  assumption_name: string;
  value: unknown;
  rationale: string;
  created_by: string;
  effective_date?: number | null;
  expiration_date?: number | null;
  change_reason?: string;
}

// ── Built-in Default Catalog (v1) ────────────────────────────

/**
 * Built-in defaults that callers fall back to when no scoped record exists.
 *
 * Keep this catalog ≤ 15 entries per spec. Currently 6 — adding new
 * assumptions requires an audit-tracked decision (don't bloat).
 */
export const ASSUMPTION_DEFAULTS: Record<string, { value: unknown; rationale: string }> = {
  ideal_cycle_time_source: {
    value: 'engineered_standard',
    rationale: 'Use engineered (textbook) cycle time as baseline. Measured drift is captured separately in efficiency, not blended into the ideal.',
  },
  setup_treatment: {
    value: 'include_in_capacity',
    rationale: 'Setup time counts against available capacity by default. Override per pack if your shop amortizes setups across batches.',
  },
  scrap_classification_rule: {
    value: 'rework_excluded',
    rationale: 'Rework is excluded from scrap totals — only items rejected outright count as scrap. Override if your accounting treats rework as scrap.',
  },
  yield_baseline_source: {
    value: 'first_pass_yield',
    rationale: 'Yield baseline is first-pass (FPY) — items good without any rework. Override to rolled or final yield per pack policy.',
  },
  availability_calculation_basis: {
    value: 'scheduled_uptime',
    rationale: 'Availability is computed against scheduled uptime (planned production hours), not total uptime. Override if your KPI uses calendar-based availability.',
  },
  monte_carlo_default_iterations: {
    value: 1000,
    rationale: 'Default Monte Carlo replication count balances statistical convergence with response time. Increase for tighter confidence intervals.',
  },
};

/**
 * Built-in metric → assumption dependency seed. Populated into
 * luna_metric_assumption_dependencies on first init. Informational —
 * does not drive resolution; documents which calc cares about which name.
 */
export const METRIC_DEPENDENCIES: MetricAssumptionDependency[] = [
  { metric_name: 'oee', assumption_name: 'availability_calculation_basis', usage_notes: 'A in OEE = uptime / basis' },
  { metric_name: 'oee', assumption_name: 'ideal_cycle_time_source', usage_notes: 'P denominator in OEE' },
  { metric_name: 'oee', assumption_name: 'yield_baseline_source', usage_notes: 'Q in OEE' },
  { metric_name: 'capacity', assumption_name: 'setup_treatment', usage_notes: 'How setups are charged against gross hours' },
  { metric_name: 'sigma_capability', assumption_name: 'scrap_classification_rule', usage_notes: 'What counts as a defect for DPMO' },
  { metric_name: 'sigma_yield', assumption_name: 'yield_baseline_source', usage_notes: 'Which yield definition feeds RTY' },
  { metric_name: 'simulation', assumption_name: 'monte_carlo_default_iterations', usage_notes: 'Default replication count when caller omits' },
  { metric_name: 'inventory', assumption_name: 'scrap_classification_rule', usage_notes: 'How rejected stock affects safety stock' },
];

// ── Schema ───────────────────────────────────────────────────

export async function initAssumptionTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('luna_assumptions'))) {
    await db.schema.createTable('luna_assumptions', (t) => {
      t.text('id').primary();
      t.text('scope_type').notNullable();
      t.text('scope_id'); // nullable for global
      t.text('assumption_name').notNullable();
      t.text('value').notNullable(); // JSON-encoded
      t.text('rationale').notNullable().defaultTo('');
      t.integer('effective_date');
      t.integer('expiration_date');
      t.text('created_by').notNullable().defaultTo('');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
      t.text('status').notNullable().defaultTo('active');
    });
    await db.schema.raw(
      'CREATE INDEX IF NOT EXISTS idx_luna_assumptions_lookup ON luna_assumptions(assumption_name, scope_type, status)',
    );
    await db.schema.raw(
      'CREATE INDEX IF NOT EXISTS idx_luna_assumptions_scope ON luna_assumptions(scope_type, scope_id, status)',
    );
  }

  if (!(await db.schema.hasTable('luna_assumption_changes'))) {
    await db.schema.createTable('luna_assumption_changes', (t) => {
      t.text('id').primary();
      t.text('assumption_id').notNullable().references('id').inTable('luna_assumptions').onDelete('CASCADE');
      t.text('changed_by').notNullable().defaultTo('');
      t.integer('changed_at').notNullable();
      t.text('previous_value');
      t.text('new_value').notNullable();
      t.text('change_reason').notNullable().defaultTo('');
    });
    await db.schema.raw(
      'CREATE INDEX IF NOT EXISTS idx_luna_assumption_changes_assumption ON luna_assumption_changes(assumption_id, changed_at)',
    );
  }

  if (!(await db.schema.hasTable('luna_metric_assumption_dependencies'))) {
    await db.schema.createTable('luna_metric_assumption_dependencies', (t) => {
      t.text('metric_name').notNullable();
      t.text('assumption_name').notNullable();
      t.text('usage_notes').notNullable().defaultTo('');
      t.primary(['metric_name', 'assumption_name']);
    });

    // Seed the built-in dependency map. Idempotent: future starts find the
    // table populated and skip. Re-seeding (e.g., after schema reset) just
    // re-inserts the same rows.
    if (METRIC_DEPENDENCIES.length > 0) {
      await db('luna_metric_assumption_dependencies').insert(METRIC_DEPENDENCIES);
    }
  }
}

export const assumptionsTableInit: TableInitializer = {
  name: 'assumptions',
  initTables: initAssumptionTables,
};

// ── ID + JSON helpers ────────────────────────────────────────

function genId(): string {
  return randomBytes(16).toString('hex');
}

function encodeValue(v: unknown): string {
  return JSON.stringify(v);
}

function decodeValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function rowToAssumption(row: Record<string, unknown>): LunaAssumption {
  return {
    id: row.id as string,
    scope_type: row.scope_type as AssumptionScope,
    scope_id: (row.scope_id as string | null) ?? null,
    assumption_name: row.assumption_name as string,
    value: decodeValue(row.value),
    rationale: (row.rationale as string) ?? '',
    effective_date: (row.effective_date as number | null) ?? null,
    expiration_date: (row.expiration_date as number | null) ?? null,
    created_by: (row.created_by as string) ?? '',
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    status: row.status as AssumptionStatus,
  };
}

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Set or update an assumption at a given scope. If a record exists with
 * the same (scope_type, scope_id, assumption_name), update it and append
 * a change-log row. Otherwise, insert a new active record.
 *
 * Note: catalog-name validation is intentionally NOT enforced here —
 * assumption names live in ASSUMPTION_DEFAULTS but custom names are
 * permitted (a pack might introduce its own). Catalog discipline is a
 * review concern, not a runtime guard.
 */
export async function setAssumption(input: SetAssumptionInput): Promise<LunaAssumption> {
  const db = getKnex();
  const now = Date.now();
  const newValueJson = encodeValue(input.value);

  const existing = await db('luna_assumptions')
    .where({
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      assumption_name: input.assumption_name,
      status: 'active',
    })
    .first() as Record<string, unknown> | undefined;

  if (existing) {
    const previousValueJson = existing.value as string;
    await db('luna_assumptions').where({ id: existing.id as string }).update({
      value: newValueJson,
      rationale: input.rationale,
      effective_date: input.effective_date ?? null,
      expiration_date: input.expiration_date ?? null,
      created_by: input.created_by,
      updated_at: now,
    });
    await db('luna_assumption_changes').insert({
      id: genId(),
      assumption_id: existing.id as string,
      changed_by: input.created_by,
      changed_at: now,
      previous_value: previousValueJson,
      new_value: newValueJson,
      change_reason: input.change_reason ?? 'updated',
    });
    return rowToAssumption({ ...existing, value: newValueJson, rationale: input.rationale, updated_at: now });
  }

  const id = genId();
  await db('luna_assumptions').insert({
    id,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    assumption_name: input.assumption_name,
    value: newValueJson,
    rationale: input.rationale,
    effective_date: input.effective_date ?? null,
    expiration_date: input.expiration_date ?? null,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
  await db('luna_assumption_changes').insert({
    id: genId(),
    assumption_id: id,
    changed_by: input.created_by,
    changed_at: now,
    previous_value: null,
    new_value: newValueJson,
    change_reason: input.change_reason ?? 'created',
  });
  return {
    id,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    assumption_name: input.assumption_name,
    value: input.value,
    rationale: input.rationale,
    effective_date: input.effective_date ?? null,
    expiration_date: input.expiration_date ?? null,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    status: 'active',
  };
}

/**
 * Retire an active assumption record (soft delete). The row remains for
 * audit but is no longer returned by resolveAssumption.
 */
export async function retireAssumption(
  id: string,
  retiredBy: string,
  reason: string = 'retired',
): Promise<boolean> {
  const db = getKnex();
  const now = Date.now();
  const existing = await db('luna_assumptions').where({ id, status: 'active' }).first() as Record<string, unknown> | undefined;
  if (!existing) return false;

  await db('luna_assumptions').where({ id }).update({ status: 'retired', updated_at: now });
  await db('luna_assumption_changes').insert({
    id: genId(),
    assumption_id: id,
    changed_by: retiredBy,
    changed_at: now,
    previous_value: existing.value as string,
    new_value: existing.value as string,
    change_reason: reason,
  });
  return true;
}

export async function getAssumptionById(id: string): Promise<LunaAssumption | undefined> {
  const row = await getKnex()('luna_assumptions').where({ id }).first() as Record<string, unknown> | undefined;
  return row ? rowToAssumption(row) : undefined;
}

export async function listAssumptions(filter: {
  scope_type?: AssumptionScope;
  scope_id?: string | null;
  status?: AssumptionStatus;
} = {}): Promise<LunaAssumption[]> {
  const q = getKnex()('luna_assumptions').orderBy([
    { column: 'assumption_name', order: 'asc' },
    { column: 'updated_at', order: 'desc' },
  ]);
  if (filter.scope_type) q.where('scope_type', filter.scope_type);
  if (filter.scope_id !== undefined) q.where('scope_id', filter.scope_id);
  if (filter.status) q.where('status', filter.status);
  const rows = await q as Array<Record<string, unknown>>;
  return rows.map(rowToAssumption);
}

export async function listMetricDependencies(metricName?: string): Promise<MetricAssumptionDependency[]> {
  const q = getKnex()('luna_metric_assumption_dependencies').orderBy([
    { column: 'metric_name', order: 'asc' },
    { column: 'assumption_name', order: 'asc' },
  ]);
  if (metricName) q.where('metric_name', metricName);
  const rows = await q as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    metric_name: r.metric_name as string,
    assumption_name: r.assumption_name as string,
    usage_notes: (r.usage_notes as string) ?? '',
  }));
}

// ── Resolution ───────────────────────────────────────────────

function isWithinEffectiveWindow(
  row: Pick<LunaAssumption, 'effective_date' | 'expiration_date'>,
  now: number,
): boolean {
  if (row.effective_date != null && now < row.effective_date) return false;
  if (row.expiration_date != null && now > row.expiration_date) return false;
  return true;
}

/**
 * Resolve a single assumption by name with precedence:
 *   user (if userId given) → pack (in activation order) → global → default
 *
 * Returns sourceScope='default' with the built-in catalog value if no
 * record matches. Never throws — always returns something resolvable.
 *
 * Unknown names (no DB record AND no built-in default) return value=null,
 * sourceScope='default', and a flag-style rationale so callers can detect
 * the miss without exception handling.
 */
export async function resolveAssumption(
  name: string,
  ctx: ResolveContext = {},
): Promise<ResolvedAssumption> {
  const db = getKnex();
  const now = Date.now();

  // Pull every active candidate for this name in one query, then walk
  // the precedence in code (avoids N round-trips for typical contexts).
  const rows = await db('luna_assumptions')
    .where({ assumption_name: name, status: 'active' }) as Array<Record<string, unknown>>;
  const candidates = rows
    .map(rowToAssumption)
    .filter((r) => isWithinEffectiveWindow(r, now));

  // 1. user-scoped
  if (ctx.userId) {
    const userMatch = candidates.find(
      (r) => r.scope_type === 'user' && r.scope_id === ctx.userId,
    );
    if (userMatch) {
      return {
        name,
        value: userMatch.value,
        sourceScope: 'user',
        rationale: userMatch.rationale,
        scopeId: userMatch.scope_id,
      };
    }
  }

  // 2. pack-scoped (first match in activation order)
  const activePacks = ctx.activePacks ?? [];
  for (const pack of activePacks) {
    const packMatch = candidates.find(
      (r) => r.scope_type === 'pack' && r.scope_id === pack,
    );
    if (packMatch) {
      return {
        name,
        value: packMatch.value,
        sourceScope: 'pack',
        rationale: packMatch.rationale,
        scopeId: packMatch.scope_id,
      };
    }
  }

  // 3. global-scoped
  const globalMatch = candidates.find((r) => r.scope_type === 'global');
  if (globalMatch) {
    return {
      name,
      value: globalMatch.value,
      sourceScope: 'global',
      rationale: globalMatch.rationale,
      scopeId: null,
    };
  }

  // 4. built-in default
  const builtin = ASSUMPTION_DEFAULTS[name];
  if (builtin) {
    return {
      name,
      value: builtin.value,
      sourceScope: 'default',
      rationale: builtin.rationale,
      scopeId: null,
    };
  }

  logger.warn({ assumptionName: name }, 'resolveAssumption: unknown name (no DB record and no built-in default)');
  return {
    name,
    value: null,
    sourceScope: 'default',
    rationale: 'UNKNOWN ASSUMPTION — no DB record and no built-in default. Caller should treat as missing.',
    scopeId: null,
  };
}

/**
 * Convenience: resolve every assumption a metric is known to depend on,
 * returning a name → ResolvedAssumption map. Driven by
 * luna_metric_assumption_dependencies.
 */
export async function resolveAssumptionsForMetric(
  metricName: string,
  ctx: ResolveContext = {},
): Promise<Record<string, ResolvedAssumption>> {
  const deps = await listMetricDependencies(metricName);
  const out: Record<string, ResolvedAssumption> = {};
  for (const dep of deps) {
    out[dep.assumption_name] = await resolveAssumption(dep.assumption_name, ctx);
  }
  return out;
}

/**
 * Build the AssumptionSet bag a calculation wrapper expects, based on the
 * calculation mode. In standard mode returns `{}`; in site_adjusted mode
 * resolves every assumption the metric depends on and shapes the result
 * for direct passing to the wrapper as its second argument.
 *
 * Phase 3 boundary helper. Handler code should call this between
 * receiving a request and invoking the wrapper:
 *
 *   const snapshot = await buildAssumptionSnapshot('simulation', mode, ctx);
 *   const result = await calculateMonteCarloMetrics(inputs, snapshot, mode);
 */
export async function buildAssumptionSnapshot(
  metricName: string,
  mode: 'standard' | 'site_adjusted',
  ctx: ResolveContext = {},
): Promise<Record<string, ResolvedAssumption>> {
  if (mode === 'standard') return {};
  return resolveAssumptionsForMetric(metricName, ctx);
}
