/**
 * Design of Experiments — Analysis Engine
 *
 * Matrix generation, ANOVA, main effects, interactions, desirability.
 */

import type {
  DOEConfig,
  DOEAnalysis,
  ExperimentMatrix,
  ExperimentRun,
  ANOVATable,
  ANOVARow,
  MainEffect,
  InteractionEffect,
  ResidualEntry,
  ConfirmationRun,
  DesirabilityResult,
  Factor,
  ResponseVar,
} from './models.js';
import { DESIGN_LABELS, TAGUCHI_ARRAYS } from './models.js';

// ── Public API ───────────────────────────────────────────────

export function generateMatrix(config: DOEConfig): ExperimentMatrix {
  let runs: ExperimentRun[];

  switch (config.design_type) {
    case 'full_factorial':
      runs = generateFullFactorial(config);
      break;
    case 'fractional':
      runs = generateFractionalFactorial(config);
      break;
    case 'taguchi':
      runs = generateTaguchi(config);
      break;
    case 'box_behnken':
      runs = generateBoxBehnken(config);
      break;
    case 'central_composite':
      runs = generateCentralComposite(config);
      break;
    default:
      runs = generateFullFactorial(config);
  }

  // Replicate
  const replicates = config.replicates ?? 1;
  if (replicates > 1) {
    const base = [...runs];
    for (let r = 1; r < replicates; r++) {
      for (const run of base) {
        runs.push({ ...run, run_order: runs.length + 1, standard_order: runs.length + 1, block: r + 1 });
      }
    }
  }

  // Randomize
  if (config.randomize !== false) {
    for (let i = runs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmpOrder = runs[i].run_order;
      runs[i].run_order = runs[j].run_order;
      runs[j].run_order = tmpOrder;
    }
  }

  const designLabel = DESIGN_LABELS[config.design_type] +
    (config.design_type === 'full_factorial' ? ` (2^${config.factors.length})` : '');

  return {
    runs,
    total_runs: runs.length,
    factors: config.factors.map((f) => f.name),
    responses: config.responses.map((r) => r.name),
    design_type: config.design_type,
    design_label: designLabel,
  };
}

export function analyzeDOE(config: DOEConfig, matrix: ExperimentMatrix): DOEAnalysis {
  const anova: ANOVATable[] = [];
  const mainEffects: MainEffect[] = [];
  const interactions: InteractionEffect[] = [];
  const warnings: string[] = [];

  // Warn about 1-level factors
  for (const f of config.factors) {
    if (f.levels.length < 2) {
      warnings.push(`Factor "${f.name}" has only ${f.levels.length} level(s) — it will be excluded from ANOVA. A factor needs at least 2 levels.`);
    }
  }

  // Warn about partial response data
  const totalRuns = matrix.runs.length;
  for (const resp of config.responses) {
    const filled = matrix.runs.filter((r) => r.responses[resp.id] != null).length;
    if (filled > 0 && filled < totalRuns) {
      warnings.push(`Response "${resp.name}" has ${filled}/${totalRuns} runs completed — analysis is preliminary.`);
    }
  }

  for (const resp of config.responses) {
    const responseValues = matrix.runs.map((r) => r.responses[resp.id]).filter((v): v is number => v != null);
    if (responseValues.length === 0) continue;

    anova.push(computeANOVA(config.factors, resp, matrix.runs));

    for (const factor of config.factors) {
      mainEffects.push(computeMainEffect(factor, resp, matrix.runs));
    }

    for (let i = 0; i < config.factors.length; i++) {
      for (let j = i + 1; j < config.factors.length; j++) {
        interactions.push(computeInteraction(config.factors[i], config.factors[j], resp, matrix.runs));
      }
    }
  }

  const desirability = config.responses.length > 0 && matrix.runs.some((r) => Object.values(r.responses).some((v) => v != null))
    ? computeDesirability(config, matrix)
    : undefined;

  // Compute residuals (predicted vs actual) for each response
  const residuals = computeResiduals(config, matrix);

  return {
    config_name: config.name,
    matrix,
    anova,
    main_effects: mainEffects,
    interactions,
    residuals,
    desirability,
    confirmation_runs: [],
    warnings,
  };
}

// ── Matrix Generators ────────────────────────────────────────

function generateFullFactorial(config: DOEConfig): ExperimentRun[] {
  const factors = config.factors;
  const levelCounts = factors.map((f) => f.levels.length);
  const totalRuns = levelCounts.reduce((p, c) => p * c, 1);
  const runs: ExperimentRun[] = [];

  for (let i = 0; i < totalRuns; i++) {
    const factorLevels: Record<string, number> = {};
    const factorCoded: Record<string, number> = {};
    let idx = i;

    for (let f = factors.length - 1; f >= 0; f--) {
      const levelIdx = idx % levelCounts[f];
      idx = Math.floor(idx / levelCounts[f]);
      factorLevels[factors[f].id] = factors[f].levels[levelIdx];
      factorCoded[factors[f].id] = codedValue(levelIdx, levelCounts[f]);
    }

    runs.push({
      run_order: i + 1,
      standard_order: i + 1,
      block: 1,
      factor_levels: factorLevels,
      factor_coded: factorCoded,
      responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
      is_center_point: false,
      is_axial_point: false,
    });
  }

  return runs;
}

function generateFractionalFactorial(config: DOEConfig): ExperimentRun[] {
  // Half-fraction: 2^(k-1), use highest-order interaction as generator
  // Only valid for 2-level factors. If any factor has >2 levels, fall back to Taguchi.
  const k = config.factors.length;
  const has3PlusLevels = config.factors.some((f) => f.levels.length > 2);

  if (has3PlusLevels) {
    // Fractional factorial defining relation requires exactly 2 levels per factor.
    // Fall back to Taguchi L-array for 3+ level designs.
    return generateTaguchi(config);
  }

  if (k <= 2) return generateFullFactorial(config); // Can't fractionate 2 factors

  const fullRuns = generateFullFactorial(config);

  // Select half using the sign of the product of all coded factors
  // Coded values are exactly -1 or +1 for 2-level designs (no zeros)
  return fullRuns.filter((run) => {
    const product = Object.values(run.factor_coded).reduce((p, v) => p * v, 1);
    return product > 0;
  }).map((run, i) => ({ ...run, run_order: i + 1, standard_order: i + 1 }));
}

function generateTaguchi(config: DOEConfig): ExperimentRun[] {
  const k = config.factors.length;
  const numLevels = config.factors[0]?.levels.length ?? 2;

  // Find best matching L-array based on factor count and levels
  let arrayKey: string;
  if (numLevels === 3) arrayKey = 'L9';
  else if (k <= 3) arrayKey = 'L4';
  else if (k <= 7) arrayKey = 'L8';
  else arrayKey = 'L16';

  const tArray = TAGUCHI_ARRAYS[arrayKey];
  if (!tArray || tArray.matrix.length === 0) {
    return generateFullFactorial(config);
  }

  const runs: ExperimentRun[] = [];
  for (let i = 0; i < tArray.matrix.length; i++) {
    const row = tArray.matrix[i];
    const factorLevels: Record<string, number> = {};
    const factorCoded: Record<string, number> = {};

    for (let f = 0; f < Math.min(config.factors.length, row.length); f++) {
      const levelIdx = row[f] - 1; // 1-based to 0-based
      const factor = config.factors[f];
      const actualIdx = Math.min(levelIdx, factor.levels.length - 1);
      factorLevels[factor.id] = factor.levels[actualIdx];
      factorCoded[factor.id] = codedValue(actualIdx, factor.levels.length);
    }

    runs.push({
      run_order: i + 1, standard_order: i + 1, block: 1,
      factor_levels: factorLevels, factor_coded: factorCoded,
      responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
      is_center_point: false, is_axial_point: false,
    });
  }

  return runs;
}

function generateBoxBehnken(config: DOEConfig): ExperimentRun[] {
  const factors = config.factors;
  const k = factors.length;
  if (k < 3) return generateFullFactorial(config);

  const runs: ExperimentRun[] = [];
  let runNum = 0;

  // Edge midpoints: for each pair of factors, vary them while keeping others at center
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      for (const li of [-1, 1]) {
        for (const lj of [-1, 1]) {
          runNum++;
          const factorLevels: Record<string, number> = {};
          const factorCoded: Record<string, number> = {};
          for (let f = 0; f < k; f++) {
            const factor = factors[f];
            let coded: number;
            if (f === i) coded = li;
            else if (f === j) coded = lj;
            else coded = 0;
            factorCoded[factor.id] = coded;
            factorLevels[factor.id] = decodedValue(coded, factor);
          }
          runs.push({
            run_order: runNum, standard_order: runNum, block: 1,
            factor_levels: factorLevels, factor_coded: factorCoded,
            responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
            is_center_point: false, is_axial_point: false,
          });
        }
      }
    }
  }

  // Center points
  const centerPoints = config.center_points ?? 3;
  for (let c = 0; c < centerPoints; c++) {
    runNum++;
    const factorLevels: Record<string, number> = {};
    const factorCoded: Record<string, number> = {};
    for (const factor of factors) {
      factorCoded[factor.id] = 0;
      factorLevels[factor.id] = decodedValue(0, factor);
    }
    runs.push({
      run_order: runNum, standard_order: runNum, block: 1,
      factor_levels: factorLevels, factor_coded: factorCoded,
      responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
      is_center_point: true, is_axial_point: false,
    });
  }

  return runs;
}

function generateCentralComposite(config: DOEConfig): ExperimentRun[] {
  const factors = config.factors;
  const k = factors.length;
  const alpha = config.alpha ?? Math.pow(Math.pow(2, k), 0.25); // Rotatable
  const runs: ExperimentRun[] = [];
  let runNum = 0;

  // Factorial part (full 2^k)
  const factorialRuns = generateFullFactorial(config);
  for (const fr of factorialRuns) {
    runNum++;
    runs.push({ ...fr, run_order: runNum, standard_order: runNum });
  }

  // Axial (star) points: ±alpha on each factor
  for (let f = 0; f < k; f++) {
    for (const sign of [-1, 1]) {
      runNum++;
      const factorLevels: Record<string, number> = {};
      const factorCoded: Record<string, number> = {};
      for (let fi = 0; fi < k; fi++) {
        const factor = factors[fi];
        const coded = fi === f ? sign * alpha : 0;
        factorCoded[factor.id] = round4(coded);
        factorLevels[factor.id] = decodedValue(coded, factor);
      }
      runs.push({
        run_order: runNum, standard_order: runNum, block: 1,
        factor_levels: factorLevels, factor_coded: factorCoded,
        responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
        is_center_point: false, is_axial_point: true,
      });
    }
  }

  // Center points
  const centerPoints = config.center_points ?? Math.max(3, k);
  for (let c = 0; c < centerPoints; c++) {
    runNum++;
    const factorLevels: Record<string, number> = {};
    const factorCoded: Record<string, number> = {};
    for (const factor of factors) {
      factorCoded[factor.id] = 0;
      factorLevels[factor.id] = decodedValue(0, factor);
    }
    runs.push({
      run_order: runNum, standard_order: runNum, block: 1,
      factor_levels: factorLevels, factor_coded: factorCoded,
      responses: Object.fromEntries(config.responses.map((r) => [r.id, null])),
      is_center_point: true, is_axial_point: false,
    });
  }

  return runs;
}

// ── ANOVA ────────────────────────────────────────────────────

function computeANOVA(factors: Factor[], response: ResponseVar, runs: ExperimentRun[]): ANOVATable {
  const values = runs.map((r) => r.responses[response.id]).filter((v): v is number => v != null);
  if (values.length < 2) {
    return { response_name: response.name, rows: [], total_ss: 0, residual_ss: 0, residual_df: 0, r_squared: 0, adj_r_squared: 0, model_significant: false };
  }

  const grandMean = values.reduce((s, v) => s + v, 0) / values.length;
  const totalSS = values.reduce((s, v) => s + (v - grandMean) ** 2, 0);

  const rows: ANOVARow[] = [];
  let modelSS = 0;

  // Main effects
  for (const factor of factors) {
    const levelGroups = new Map<number, number[]>();
    for (const run of runs) {
      const val = run.responses[response.id];
      if (val == null) continue;
      const level = run.factor_levels[factor.id];
      const group = levelGroups.get(level) ?? [];
      group.push(val);
      levelGroups.set(level, group);
    }

    const groups = Array.from(levelGroups.values());
    if (groups.length < 2) continue;

    const groupMeans = groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
    const ss = groups.reduce((s, g, i) => s + g.length * (groupMeans[i] - grandMean) ** 2, 0);
    const df = groups.length - 1;
    const ms = df > 0 ? ss / df : 0;

    modelSS += ss;

    rows.push({
      source: factor.name,
      sum_of_squares: round4(ss),
      df,
      mean_square: round4(ms),
      f_value: 0, // Computed after residual
      p_value: 0,
      contribution_pct: totalSS > 0 ? round2((ss / totalSS) * 100) : 0,
      significant: false,
    });
  }

  // 2-factor interactions
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const combGroups = new Map<string, number[]>();
      for (const run of runs) {
        const val = run.responses[response.id];
        if (val == null) continue;
        const key = `${run.factor_coded[factors[i].id]}_${run.factor_coded[factors[j].id]}`;
        const group = combGroups.get(key) ?? [];
        group.push(val);
        combGroups.set(key, group);
      }

      const groups = Array.from(combGroups.values());
      if (groups.length < 2) continue;

      const combMeans = groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
      const ssComb = groups.reduce((s, g, idx) => s + g.length * (combMeans[idx] - grandMean) ** 2, 0);
      // Interaction SS = combination SS - main effects SS
      const ssA = rows.find((r) => r.source === factors[i].name)?.sum_of_squares ?? 0;
      const ssB = rows.find((r) => r.source === factors[j].name)?.sum_of_squares ?? 0;
      const ssInteraction = Math.max(0, ssComb - ssA - ssB);

      if (ssInteraction > 0.001) {
        modelSS += ssInteraction;
        rows.push({
          source: `${factors[i].name} × ${factors[j].name}`,
          sum_of_squares: round4(ssInteraction),
          df: 1,
          mean_square: round4(ssInteraction),
          f_value: 0,
          p_value: 0,
          contribution_pct: totalSS > 0 ? round2((ssInteraction / totalSS) * 100) : 0,
          significant: false,
        });
      }
    }
  }

  // Residual
  const residualSS = Math.max(0, totalSS - modelSS);
  const modelDF = rows.reduce((s, r) => s + r.df, 0);
  const residualDF = Math.max(1, values.length - 1 - modelDF);
  const residualMS = residualDF > 0 ? residualSS / residualDF : 1;

  // Compute F and p-values
  for (const row of rows) {
    row.f_value = residualMS > 0 ? round4(row.mean_square / residualMS) : 0;
    row.p_value = round4(fDistPValue(row.f_value, row.df, residualDF));
    row.significant = row.p_value < 0.05;
  }

  const rSquared = totalSS > 0 ? modelSS / totalSS : 0;
  const adjRSquared = values.length > modelDF + 1
    ? 1 - ((1 - rSquared) * (values.length - 1) / (values.length - modelDF - 1))
    : rSquared;

  return {
    response_name: response.name,
    rows,
    total_ss: round4(totalSS),
    residual_ss: round4(residualSS),
    residual_df: residualDF,
    r_squared: round4(rSquared),
    adj_r_squared: round4(adjRSquared),
    model_significant: rows.some((r) => r.significant),
  };
}

// ── Effects ──────────────────────────────────────────────────

function computeMainEffect(factor: Factor, response: ResponseVar, runs: ExperimentRun[]): MainEffect {
  const levelMap = new Map<number, number[]>();
  for (const run of runs) {
    const val = run.responses[response.id];
    if (val == null) continue;
    const level = run.factor_levels[factor.id];
    const arr = levelMap.get(level) ?? [];
    arr.push(val);
    levelMap.set(level, arr);
  }

  const levels = Array.from(levelMap.keys()).sort((a, b) => a - b);
  const meanResponses = levels.map((l) => {
    const vals = levelMap.get(l) ?? [];
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  });

  const effectSize = meanResponses.length >= 2
    ? meanResponses[meanResponses.length - 1] - meanResponses[0]
    : 0;

  return {
    factor_id: factor.id,
    factor_name: factor.name,
    levels,
    mean_responses: meanResponses.map(round4),
    effect_size: round4(effectSize),
  };
}

function computeInteraction(
  factorA: Factor, factorB: Factor, response: ResponseVar, runs: ExperimentRun[],
): InteractionEffect {
  const combMap = new Map<string, number[]>();
  for (const run of runs) {
    const val = run.responses[response.id];
    if (val == null) continue;
    const key = `${run.factor_levels[factorA.id]}_${run.factor_levels[factorB.id]}`;
    const arr = combMap.get(key) ?? [];
    arr.push(val);
    combMap.set(key, arr);
  }

  const combinations: InteractionEffect['combinations'] = [];
  for (const [key, vals] of Array.from(combMap)) {
    const [a, b] = key.split('_').map(Number);
    combinations.push({ level_a: a, level_b: b, mean_response: round4(vals.reduce((s, v) => s + v, 0) / vals.length) });
  }

  // Interaction strength: range of differences
  const diffs = combinations.map((c) => c.mean_response);
  const strength = diffs.length > 1 ? Math.max(...diffs) - Math.min(...diffs) : 0;

  return {
    factor_a: factorA.id, factor_b: factorB.id,
    factor_a_name: factorA.name, factor_b_name: factorB.name,
    combinations, interaction_strength: round4(strength),
  };
}

// ── Desirability ─────────────────────────────────────────────

function computeDesirability(config: DOEConfig, matrix: ExperimentMatrix): DesirabilityResult {
  // Find the run with highest overall desirability
  let bestDesirability = -1;
  let bestRun: ExperimentRun | null = null;

  for (const run of matrix.runs) {
    const hasAllResponses = config.responses.every((r) => run.responses[r.id] != null);
    if (!hasAllResponses) continue;

    let overallD = 1;
    for (const resp of config.responses) {
      const val = run.responses[resp.id]!;
      const d = individualDesirability(val, resp, matrix.runs.map((r) => r.responses[resp.id]).filter((v): v is number => v != null));
      const weight = resp.weight ?? 1;
      overallD *= Math.pow(d, weight);
    }
    overallD = Math.pow(overallD, 1 / config.responses.reduce((s, r) => s + (r.weight ?? 1), 0));

    if (overallD > bestDesirability) {
      bestDesirability = overallD;
      bestRun = run;
    }
  }

  if (!bestRun) {
    return { overall_desirability: 0, per_response: [], optimal_factors: {} };
  }

  const perResponse = config.responses.map((resp) => {
    const val = bestRun!.responses[resp.id] ?? 0;
    const allVals = matrix.runs.map((r) => r.responses[resp.id]).filter((v): v is number => v != null);
    return {
      response_name: resp.name,
      desirability: round4(individualDesirability(val, resp, allVals)),
      predicted_value: round4(val),
      target: resp.target ?? val,
    };
  });

  return {
    overall_desirability: round4(bestDesirability),
    per_response: perResponse,
    optimal_factors: bestRun.factor_levels,
  };
}

function individualDesirability(value: number, resp: ResponseVar, allValues: number[]): number {
  if (allValues.length === 0) return 0;
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  if (maxVal === minVal) return 1;

  if (resp.target != null) {
    // Target desirability
    const diff = Math.abs(value - resp.target);
    const maxDiff = Math.max(Math.abs(maxVal - resp.target), Math.abs(minVal - resp.target));
    return maxDiff > 0 ? Math.max(0, 1 - diff / maxDiff) : 1;
  }

  if (resp.minimize) {
    return (maxVal - value) / (maxVal - minVal);
  }
  return (value - minVal) / (maxVal - minVal);
}

// ── Residuals ────────────────────────────────────────────────

/**
 * Compute predicted values and residuals for each run.
 * Prediction uses the group mean for the factor level combination (cell mean model).
 */
function computeResiduals(config: DOEConfig, matrix: ExperimentMatrix): ResidualEntry[] {
  const residuals: ResidualEntry[] = [];

  for (const resp of config.responses) {
    const values = matrix.runs.map((r) => r.responses[resp.id]).filter((v): v is number => v != null);
    if (values.length < 2) continue;

    const grandMean = values.reduce((s, v) => s + v, 0) / values.length;

    // Build predicted value per run using main effects model:
    // predicted = grandMean + Σ(factorEffect_i)
    // where factorEffect = (level_mean - grand_mean)
    const factorEffects = new Map<string, Map<number, number>>(); // factorId → level → effect
    for (const factor of config.factors) {
      const levelMeans = new Map<number, { sum: number; count: number }>();
      for (const run of matrix.runs) {
        const val = run.responses[resp.id];
        if (val == null) continue;
        const level = run.factor_levels[factor.id];
        const entry = levelMeans.get(level) ?? { sum: 0, count: 0 };
        entry.sum += val;
        entry.count++;
        levelMeans.set(level, entry);
      }
      const effects = new Map<number, number>();
      for (const [level, { sum, count }] of Array.from(levelMeans)) {
        effects.set(level, sum / count - grandMean);
      }
      factorEffects.set(factor.id, effects);
    }

    // Compute residuals
    const runResiduals: number[] = [];
    for (const run of matrix.runs) {
      const actual = run.responses[resp.id];
      if (actual == null) continue;

      let predicted = grandMean;
      for (const factor of config.factors) {
        const effects = factorEffects.get(factor.id);
        const level = run.factor_levels[factor.id];
        predicted += effects?.get(level) ?? 0;
      }

      runResiduals.push(actual - predicted);

      residuals.push({
        run_order: run.run_order,
        response_id: resp.id,
        actual: round4(actual),
        predicted: round4(predicted),
        residual: round4(actual - predicted),
        std_residual: 0, // filled below
      });
    }

    // Compute standardized residuals
    const resStddev = runResiduals.length > 1
      ? Math.sqrt(runResiduals.reduce((s, r) => s + r * r, 0) / (runResiduals.length - 1))
      : 1;

    for (const entry of residuals.filter((r) => r.response_id === resp.id)) {
      entry.std_residual = resStddev > 0 ? round4(entry.residual / resStddev) : 0;
    }
  }

  return residuals;
}

// ── Confirmation Runs ────────────────────────────────────────

/**
 * Create a confirmation run from optimal factor settings.
 */
export function createConfirmationRun(
  config: DOEConfig,
  factorLevels: Record<string, number>,
  analysis: DOEAnalysis,
): ConfirmationRun {
  // Predict responses using main effects
  const predicted: Record<string, number> = {};

  for (const resp of config.responses) {
    const mainEffect = analysis.main_effects.filter((e) =>
      config.factors.some((f) => f.id === e.factor_id) && e.mean_responses.length > 0);

    // Simple prediction: use closest level mean
    const values = analysis.matrix.runs
      .map((r) => r.responses[resp.id])
      .filter((v): v is number => v != null);
    predicted[resp.id] = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  return {
    id: `confirm_${Date.now()}`,
    factor_levels: factorLevels,
    predicted,
    actual: Object.fromEntries(config.responses.map((r) => [r.id, null])),
    status: 'pending',
  };
}

// ── Helpers ──────────────────────────────────────────────────

function codedValue(levelIdx: number, totalLevels: number): number {
  if (totalLevels <= 1) return 0;
  return -1 + (2 * levelIdx) / (totalLevels - 1);
}

function decodedValue(coded: number, factor: Factor): number {
  if (factor.levels.length < 2) return factor.levels[0] ?? 0;
  const lo = factor.levels[0];
  const hi = factor.levels[factor.levels.length - 1];
  const mid = (lo + hi) / 2;
  const halfRange = (hi - lo) / 2;
  return round4(mid + coded * halfRange);
}

/** Approximate F-distribution p-value using beta incomplete function approximation */
function fDistPValue(f: number, df1: number, df2: number): number {
  if (f <= 0 || df1 <= 0 || df2 <= 0) return 1;
  const x = df2 / (df2 + df1 * f);
  return betaInc(df2 / 2, df1 / 2, x);
}

/** Regularized incomplete beta function — simple approximation */
function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Use continued fraction approximation (Lentz's method, simplified)
  const maxIter = 100;
  const eps = 1e-8;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= maxIter; i++) {
    let m = i / 2;
    let numerator: number;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      m = (i - 1) / 2;
      numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < eps) d = eps;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < eps) c = eps;
    f *= c * d;
    if (Math.abs(c * d - 1) < eps) break;
  }

  return Math.min(1, Math.max(0, front * (f - 1)));
}

function lnGamma(z: number): number {
  // Stirling approximation
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
