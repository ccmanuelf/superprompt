# Calculation Modules Audit — Phase 0

**Spec:** `Luna_kpi_files/02_luna_dual-view_architecture.md` (Manuel Campos, 2026-04-30)
**Scope:** Luna-internal manufacturing engineering calculations only. Out of scope: `kpi-operations`, NovaLink BOM bridge, cross-system reconciliation.
**Status:** Phase 0 deliverable — refactoring scope assessment, not a design document.
**Audit date:** 2026-04-30
**Repo state at audit:** main @ `02d4095` (rc.99), 181 src `.ts` files.

---

## Locked decisions from spec-owner Q&A (2026-04-30)

These materially scope what the implementation has to deliver and override the spec where they conflict:

1. **Web UI only for assumption registry CRUD.** The four `/assumptions list/show/set/reset` Telegram commands in spec § Phase 2 are dropped. Calculations themselves still run from any platform; only registry *management* is Web-UI-only.
2. **First-match-wins by pack activation order** for multi-pack assumption resolution. No explicit precedence configuration.
3. **`site_adjusted` mode affects input distributions only.** Random seed policy stays standard; `simulation_random_seed_policy` is removed from the v1 catalog.
4. **`luna_calculation_history` table is dropped.** Persistence of calculation results is deferred to the future kpi-operations integration. Reproducibility in v1 is satisfied by inline snapshots in the response (Telegram message / Web UI render), not by stored history.
5. **Phase 4 (conversational lineage) is dropped from Telegram entirely.** The `/explain` capability survives as a **Web UI only** structured panel for the most-recent calculation in the active session, fully ephemeral.
6. **Definition of Done relaxes:** "auditable from the response Luna returns" replaces "reproduce from stored snapshot." Snapshot is in the response, not the DB.
7. **Phase 5 default-folding policy:** existing hardcoded constants get folded into the assumption registry where they qualify. Catalog-bloat risk is real and tracked below.

---

## Module count discrepancy

Spec § "Explicitly out of scope" line 238 mentions "the existing 15 manufacturing module algorithms." This audit finds **14**, matching spec line 12's enumeration: `/sim`, `/capacity`, `/sequence`, `/sigma`, `/balance`, `/inventory`, `/spc`, `/fmea`, `/rca`, `/doe`, `/vsm`, `/toc`, `/conwip`, `/fsm`. `/spc` maps to `src/control-plan.ts` (planning surface) — actual SPC math lives inside `/sigma` (`src/sigma.ts`). No 15th module found. Either the spec author counted `control-plan` and `sigma` separately for SPC, or there is a 15th module not yet implemented. **Action:** confirm with spec owner; treat as 14 for now.

---

## Module inventory

| # | Command | Calc surface | Numeric algorithm? | Telegram handler | Web route |
|---|---|---|---|---|---|
| 1 | `/balance` | `src/balance.ts` (1106L) | Yes — RPW line balancing | `platforms/telegram.ts:3369` | shared `web/capacity-api.ts` |
| 2 | `/sigma` | `src/sigma.ts` (1885L) | Yes — Cpk/Ppk/DPMO/control charts | `platforms/telegram.ts:3306` | shared via `sim-api.ts` |
| 3 | `/fmea` | `src/fmea.ts` (700L) | Yes — RPN = S×O×D, AP matrix | `platforms/telegram.ts:3130` | main UI |
| 4 | `/inventory` | `src/inventory.ts` (725L) | Yes — EOQ, safety stock, ABC, forecast | `platforms/telegram.ts:3243` | TBD |
| 5 | `/rca` | `src/rca.ts` (1048L) | **No — qualitative only** | `platforms/telegram.ts:3073` | main UI |
| 6 | `/spc` | `src/control-plan.ts` (436L) | **No — planning surface only** | `platforms/telegram.ts:3187` | main UI |
| 7 | `/sim` | `src/simulation/` (8 files) | Yes — DES + Monte Carlo + MiniZinc | `platforms/telegram.ts:3028` | `web/sim-api.ts` |
| 8 | `/capacity` | `src/capacity/` (5 files) | Yes — utilization, scenarios, ROI | `platforms/telegram.ts:4031` | `web/capacity-api.ts` |
| 9 | `/sequence` | `src/sequencer/` (6 files) | Yes — dispatching rules + GA | `platforms/telegram.ts:4299` | `web/sequencer-api.ts` |
| 10 | `/doe` | `src/doe/` (4 files) | Yes — design generation + ANOVA | `platforms/telegram.ts:4133` | `web/doe-api.ts` |
| 11 | `/fsm` | `src/fsm/` (8 files) | Yes — state machine sim, residence stats | `platforms/telegram.ts:4101` | `web/fsm-api.ts` |
| 12 | `/toc` | `src/toc/` (5 files) | Yes — DBR, throughput accounting | `platforms/telegram.ts:4184` | `web/toc-api.ts` |
| 13 | `/conwip` | `src/conwip/` (4 files) | Yes — token flow, Heijunka | `platforms/telegram.ts:4159` | `web/conwip-api.ts` |
| 14 | `/vsm` | `src/vsm/` (5 files) | **Mostly qualitative** — TIMWOOD + delta | `platforms/telegram.ts:4233` | `web/vsm-api.ts` |

**Three modules have no numeric algorithm to dual-view:**
- `/rca` — only renders 5-Whys / Fishbone / FTA / PDCA / MindMap (qualitative).
- `/spc` — control-plan authoring surface; chart math lives in `/sigma`.
- `/vsm` — TIMWOOD classification + waterfall delta; no real assumptions.

These modules can opt out of the dual-view machinery in v1, or get a no-op `mode` parameter that always returns the same result. **Recommendation:** mark them as "dual-view-trivial" — they accept the parameter for API consistency but don't branch on it. Phase 3's three-calculation test set should pull from the 11 numeric modules.

---

## Per-module input sources & side effects

The interesting picture is what the calc functions *consume* and what they *do beyond returning a value*. This determines how invasive Phase 1's pure-function extraction is.

### `/balance` (`src/balance.ts`)
- **Pure math:** `assignStations()` (greedy), `calculateEfficiency()` (line 548), `calculateSmoothness()` (line 563), `detectCycle()` (line 322).
- **Orchestrator with side effects:** `runBalance()` — writes to `balance_projects`, `balance_tasks`, `balance_results`.
- **Inputs:** typed `BalanceTask[]`, `taktTime` number, optional precedence DAG. CSV ingest path `parseBalanceCsv()`.
- **Constants:** `CHART_PALETTE` (lines 700-705) — visualization, not algorithm. No assumption-grade constants in math.
- **Phase 1 friction:** low. Math is already pure; just need to peel out a non-DB-coupled function.

### `/sigma` (`src/sigma.ts`)
- **Pure math:** `calculateCapability()` (line 325), `calculateDpmo()` (414), `dpmoToSigma()` (438), `rolledThroughputYield()` (452), `detectWesternElectricRules()` (732), the chart generators.
- **Constants requiring assumption decisions:**
  - `d2 = 1.128` (line 528) — average-range-to-σ conversion factor (subgroup size 2). Standard textbook.
  - `D4 = 3.267` (line 529) — control-limit multiplier (subgroup size 2). Standard textbook.
  - `pLow = 0.02425` (line 487) — normal-distribution tail constant.
  - Western Electric zone thresholds at 1σ/2σ/3σ (lines 738-747) — standard.
- **Phase 1 friction:** moderate. The chart generators interleave math with chart-rendering side effects. Pure-math separation is doable but requires care.

### `/fmea` (`src/fmea.ts`)
- **Pure math:** `calculateActionPriority()` (line 275), `buildRiskMatrix()` (296).
- **Inputs:** S/O/D triples, 1-10 scale.
- **Constants:** none in algorithm. AP table is a fixed AIAG mapping.
- **Phase 1 friction:** trivial.

### `/inventory` (`src/inventory.ts`)
- **Pure math:** `calculateEOQ()` (line 291, signature includes `serviceLevel`), `calculateReorderPoint()` (305), `calculateSafetyStock()`, `abcClassification()` (356), forecasting (`forecastDemand()` with α grid search [0.1, 0.2, ..., 0.9] at line 406).
- **Constants requiring assumption decisions:**
  - `service_level` default 0.95 (lines 99, 250, 261) — DB column default + CSV parse default.
  - `service_level` clamp range [0.50, 0.9999] (line 261).
  - `service_level` stockout-risk threshold 0.90 (line 651) — warning trigger.
  - α grid for exponential smoothing: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] (line 406).
  - **No fixed ABC thresholds** — uses dynamic Pareto curve. Confirmed.
- **Phase 1 friction:** low. Already pure; service_level is already a parameter, just needs to draw from the registry.

### `/rca` (`src/rca.ts`)
- **No numeric algorithm.** Functions: `build5Whys()`, `buildFishbone()`, `buildPdca()`, `buildFaultTree()`, `buildMindMap()`, render-PNG functions, `generateA3Pdf()`.
- All async, DB-backed. No constants requiring assumption registry.
- **Phase 1 action:** mark as dual-view-trivial; skip Phase 1 extraction for now.

### `/spc` (`src/control-plan.ts`)
- **No numeric algorithm.** Authors VOC → CTQ → control plan documents.
- Hardcoded enum: chart recommendations `'xbar_r' | 'i_mr' | 'p' | 'np' | 'c' | 'u' | 'none'` (line 37). S/O/D scales 1-10 (28-30) — same as FMEA, presentation only.
- **Phase 1 action:** dual-view-trivial.

### `/sim` (`src/simulation/`)
- **Pure math:** `runSimulation()` (engine), `calculateAllBlocks()`, `runMonteCarlo()`, `computeStats()`. MiniZinc bridge via `src/minizinc.ts`.
- **Constants in `src/simulation/constants.ts`:** queue disciplines (FIFO/SPT/EDD), Monte Carlo trial defaults — needs verification.
- **Phase 1 friction:** moderate. Monte Carlo trial count is the leading assumption candidate; per spec-owner Q3, the random seed policy stays out.

### `/capacity` (`src/capacity/`)
- **Pure math:** `analyzeCapacity()`, `runScenario()`, `runCapacityMonteCarlo()`, `calculateROI()`.
- **Constants:** ROI horizon defaults, demand variability defaults — needs verification in `roi.ts` and `scenarios.ts`.
- **Phase 1 friction:** low. Already pure; orchestrator persistence layer is the only side effect.

### `/sequence` (`src/sequencer/`)
- **Pure math:** `dispatch()`, `compareAllRules()`, `runGA()`, `evaluateSchedule()`.
- **Constants:** GA population size, generation count, mutation rate — likely in `genetic.ts`. Strong assumption candidates.
- **Phase 1 friction:** moderate. GA is stochastic — same Q3 caveat applies (input distributions only, seed stays).

### `/doe` (`src/doe/`)
- **Pure math:** `generateMatrix()`, `analyzeDOE()`, `createConfirmationRun()`.
- **Constants:** ANOVA significance level (likely p < 0.05), design-selection thresholds (2-3 → 2^k full, 4-7 → fractional, 8+ → Taguchi). All assumption candidates.
- **Phase 1 friction:** low.

### `/fsm` (`src/fsm/`)
- **Pure logic:** `initSimulation()`, `processEvent()`, `stepSimulation()`, `runUntil()`, `runToCompletion()`, `analyzeSimulation()`.
- **No numeric assumptions** — deterministic state machine. State residence times are computed, not parameterized.
- **Phase 1 action:** treat residence-time histogram bin width as the only candidate; otherwise dual-view-trivial.

### `/toc` (`src/toc/`)
- **Pure math:** `analyzeTOC()`, `identifyConstraint()`, `calculateThroughputAccounting()` (T = Price - TVC), `buildDBRSchedule()`, `computeBufferStatus()`, `computeWIPGauges()`.
- **Constants:** buffer zone thresholds (likely green/yellow/red percentages) — needs verification in `analysis.ts`. Strong assumption candidates.
- **Phase 1 friction:** low.

### `/conwip` (`src/conwip/`)
- **Pure math:** `analyzeCONWIP()`, `analyzeHeijunka()`, `simulateTokenFlow()`.
- **Constants:** WIP buffer rules, slot-allocation defaults — needs verification.
- **Phase 1 friction:** low.

### `/vsm` (`src/vsm/`)
- **Mostly qualitative:** `analyzeVSM()`, `compareStates()`, `classifyTimwoods()`. The "math" is delta arithmetic on user-supplied times.
- **No assumption candidates** beyond what the user explicitly enters.
- **Phase 1 action:** dual-view-trivial.

---

## Constants-as-assumption candidates — for Phase 5 fold-in decision

Spec-owner answer #5: fold existing constants into the registry. The realistic v1 candidates and their pre-fold count:

| Source module | Candidate | Suggested registry name | Notes |
|---|---|---|---|
| inventory | `service_level` default 0.95 | `default_service_level` | Already a parameter; just default-source change. |
| inventory | stockout-risk warning at 0.90 | `service_level_warning_threshold` | Could collapse with above as `{ default, warning }` shape. |
| inventory | α grid `[0.1...0.9]` | `forecast_alpha_grid` | Or split into `forecast_alpha_min/max/step`. |
| sigma | d2, D4 control-chart constants | (DO NOT FOLD) | Standard AIAG values. Folding invites errors. |
| sigma | Western Electric thresholds | (DO NOT FOLD) | Standard rule definitions. |
| sim | Monte Carlo default trial count | `monte_carlo_default_iterations` | Already in spec catalog. |
| sequencer | GA population size | `ga_population_size` | |
| sequencer | GA generations | `ga_generations` | |
| doe | ANOVA significance | `anova_alpha` | Default 0.05. |
| doe | Factor count → design type thresholds | `doe_design_selection_policy` | Single named policy with embedded thresholds. |
| toc | Buffer zone red threshold | `buffer_red_threshold` | TBD percentage. |
| toc | Buffer zone yellow threshold | `buffer_yellow_threshold` | TBD percentage. |
| capacity | ROI default horizon | `roi_default_horizon_months` | TBD value. |
| (cross-cutting) | `ideal_cycle_time_source` | `ideal_cycle_time_source` | Spec-mandated. |
| (cross-cutting) | `setup_treatment` | `setup_treatment` | Spec-mandated. |
| (cross-cutting) | `scrap_classification_rule` | `scrap_classification_rule` | Spec-mandated. |
| (cross-cutting) | `yield_baseline_source` | `yield_baseline_source` | Spec-mandated. |
| (cross-cutting) | `availability_calculation_basis` | `availability_calculation_basis` | Spec-mandated. |

**Pre-fold count: ~17.** Spec catalog limit: ≤15. Two over.

**Catalog-bloat mitigations to choose from:**
- Drop `forecast_alpha_grid` (let it stay hardcoded — uncommon override).
- Collapse `service_level_warning_threshold` into `default_service_level`'s shape.
- Collapse buffer red/yellow into one `buffer_zone_thresholds` policy assumption.
- Defer `ga_population_size` / `ga_generations` to a single `sequencer_ga_policy` assumption.

With those, count drops to ~13. Recommend deferring less-impactful folds out of v1. **The catalog is tighter than the spec author may have realized once existing constants are surveyed** — Phase 5's "fold existing" must be selective, not blanket.

---

## Shared infrastructure observations

| Concern | Where it lives today |
|---|---|
| Telegram handler registration | `src/platforms/telegram.ts` lines 3028-4343 (single switch-on-command file). |
| Web API routes per module | `src/web/{module}-api.ts` — Express-style handlers. |
| DB persistence | Knex via `src/db-knex.ts`; each module owns its tables and `init*Tables()` function. |
| Chart generation | ChartJS NodeCanvas → PNG into `STORE_DIR`. |
| MiniZinc | `src/minizinc.ts` — used by `/sim` and `/sequence`. |
| Pack system | `src/packs/`, `src/packs.ts`, `src/pack-builder.ts`, `src/pack-tuner.ts`. Activation hooks exist; `assumptions.yaml` will plug in here. |
| Feature-awareness registry | per memory `project_feature_awareness_rc92.md` — every shipped feature must register. The dual-view layer counts as a feature; expect to add a registry entry per module that gets dual-view machinery. |

---

## Phase 1 readiness assessment

**Verdict: Phase 1 is feasible without major restructuring.** The pure-function math already exists in most modules; what's missing is a uniform calling convention and a typed `CalculationResult`.

**Per-module Phase 1 effort estimate:**

- **Trivial (no extraction needed, just wrapping):** `/fmea`, `/balance`, `/inventory`. 1 day each.
- **Moderate (math-vs-rendering separation):** `/sigma`, `/sim`, `/sequence`, `/doe`, `/toc`, `/conwip`, `/capacity`. 1-2 days each.
- **Skip in v1 (no numeric algorithm):** `/rca`, `/spc`, `/vsm`, `/fsm`. Zero work; document as dual-view-trivial.

**Total realistic Phase 1 estimate: 10-15 working days.** Multi-rc territory. Recommend one module per rc, starting with the trivial three to nail the `CalculationResult` shape, then moving to the moderate group.

---

## Phase 2 schema sketch (what the registry actually needs to look like)

Per spec § Phase 2 + locked decisions:

**Tables (Knex migration):**
```sql
luna_assumptions
  id              integer primary key
  scope_type      text check (scope_type in ('global', 'pack', 'user'))
  scope_id        text nullable          -- pack name | user_id | null
  assumption_name text not null
  value           text not null          -- JSON
  rationale       text
  effective_date  text                   -- ISO 8601
  expiration_date text nullable
  created_by      text
  created_at      text not null
  updated_at      text not null
  status          text check (status in ('active', 'retired')) default 'active'

luna_assumption_changes
  id              integer primary key
  assumption_id   integer references luna_assumptions(id)
  changed_by      text
  changed_at      text
  previous_value  text
  new_value       text
  change_reason   text

luna_metric_assumption_dependencies
  metric_name     text
  assumption_name text
  usage_notes     text
  primary key (metric_name, assumption_name)
```

**Resolution function (Phase 2 deliverable):**
```typescript
async function resolveAssumption(
  name: string,
  ctx: { userId: string; activePacks: string[] }
): Promise<{ value: unknown; sourceScope: 'user'|'pack'|'global'|'default'; rationale?: string }>
```

Pack ordering for first-match: read `activePacks` array in order. No precedence config.

**No Telegram commands per locked decision #1.** Web UI surfaces this as a CRUD page under the existing `/docs` web UI (`src/web/`).

---

## Phase 3 wiring strategy

Each calculation function in `site_adjusted` mode resolves assumptions at call time. Suggested signature:

```typescript
function calculateOEE(
  inputs: OEEInputs,
  assumptions: AssumptionSnapshot,    // pre-resolved at boundary
  mode: 'standard' | 'site_adjusted'
): CalculationResult<OEEMetrics>
```

`AssumptionSnapshot` is built once at the Telegram/Web handler boundary by calling `resolveAssumption()` for every assumption the metric declares it depends on (driven by `luna_metric_assumption_dependencies`). The pure function stays pure — it never touches the DB.

`CalculationResult.assumptionsApplied` is the snapshot itself (with source scope per entry). Per locked decision #4, this is the *only* persistence — it's in the response body, not in a history table.

**Three test-set candidates per spec:** OEE in `/sim`, capacity utilization in `/capacity`, line balancing efficiency in `/balance`. All three are in the trivial-or-moderate Phase 1 group.

---

## Phase 5 yaml schema sketch

```yaml
# packs/<pack>/assumptions.yaml
assumptions:
  - name: default_service_level
    value: 0.95
    rationale: "Industry-standard 95% service level for non-critical SKUs"
  - name: ideal_cycle_time_source
    value: engineered_standard
    rationale: "Use engineered cycle time, not measured average"
  # ...
```

Loader: idempotent insert into `luna_assumptions` with `scope_type='pack'`, `scope_id=<pack_name>`. Re-installation diffs and updates `value` + appends a `luna_assumption_changes` entry.

**Conversational pack builder integration:** `src/pack-builder.ts` needs a new step — after the existing pack metadata prompts, ask for assumption values. Each assumption prompt: "Should `<assumption_name>` differ from the global default for this pack? (y/N)" → if y, prompt for value + rationale.

---

## Open questions for spec owner

1. **Module count.** Spec § "out of scope" cites 15 modules; this audit finds 14. Confirm: 14 is correct, OR identify the 15th.
2. **Catalog limit collision.** Folding existing constants per locked decision #7 yields ~17 names before mitigation. The spec's ≤15 hard cap requires either dropping low-value folds or collapsing related ones (see "Catalog-bloat mitigations" above). Pick which mitigations apply, or relax the cap to ~18.
3. **Web UI registry CRUD location.** Should the registry page mount under the existing `/docs` web UI, or get its own top-level Web UI surface (e.g., `/assumptions`)? Affects the existing web routing in `src/web/`.
4. **`/explain` Web UI surface.** Where in the Web UI does it appear — a side panel on the calculation result page, or its own route? Per locked decision #5 it's ephemeral (most-recent in session); confirm "session" means the user's Web UI tab session (browser-state), not the Telegram conversation thread.
5. **Trivial-module opt-out.** Confirm `/rca`, `/spc`, `/vsm`, `/fsm` can skip Phase 1 entirely (mark dual-view-trivial), since they have no numeric assumptions.
6. **Constants in `sigma.ts` (d2, D4, Western Electric).** Recommend NOT folding (they're standard AIAG values; user override invites silent miscalibration). Confirm.
7. **Existing pack count.** Per `CLAUDE.md` there are 10 existing packs. Phase 5's `assumptions.yaml` shipping policy: do all 10 packs need a YAML in v1, or only `manufacturing` (the level-3 pack from SA5)?

---

## Recommended sequencing

Following spec's "do not parallelize" rule:

1. **Resolve open questions** above (estimated: one round-trip with spec owner).
2. **Phase 1 — three rcs:**
   - rc.X: `CalculationResult` type + extract trivial trio (`/fmea`, `/balance`, `/inventory`). Both-mode tests for all three.
   - rc.X+1: Extract moderate group A (`/sigma`, `/sim`, `/capacity`).
   - rc.X+2: Extract moderate group B (`/sequence`, `/doe`, `/toc`, `/conwip`).
   - Skip `/rca`, `/spc`, `/vsm`, `/fsm` (dual-view-trivial).
3. **Phase 2 — one rc:** Knex migration + resolver + Web UI registry CRUD page.
4. **Phase 3 — one rc:** Wire all 11 numeric modules to the registry. Snapshot in `CalculationResult.assumptionsApplied`. Three-calculation regression test set per spec.
5. **Phase 4 — one rc:** Web-UI-only `/explain` panel showing most-recent calc snapshot in current Web UI session.
6. **Phase 5 — one rc:** `assumptions.yaml` loader + pack-builder integration + `manufacturing` pack YAML.

**Total: 7 rcs.** Realistic across multiple weeks given other workstreams (attendance reconciliation Phase B, skill-creator-v2 Phase 2+).

---

## What this audit does NOT do

- Specify the `CalculationResult` type's exact field shape — that's Phase 1's first decision.
- Specify the Web UI route layout — open question #3.
- Specify the assumption value JSON shape per assumption — done case-by-case in Phase 2.
- Cover any `kpi-operations` integration concerns — out of scope.
- Cover the NovaLink BOM bridge — covered by spec #3.
