/**
 * Capacity Planning HTTP API — REST endpoints for the capacity web UI.
 *
 * Mounted on the existing web server at /api/capacity/*.
 * Handles JSON request/response for capacity planning operations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  analyzeCapacity,
  runScenario,
  compareScenarios,
  getScenarioDefaults,
  runCapacityMonteCarlo,
  calculateROI,
  compareROIs,
  savePlan,
  getPlan,
  listPlans,
  deletePlan,
  saveResult,
  getResults,
  generateCapacityUtilizationChart,
  generateScenarioComparisonChart,
  generateMonteCarloHistogram,
  generateUtilizationHeatmap,
  type CapacityPlanConfig,
  type ScenarioParams,
  type MonteCarloCapacityConfig,
  type ROIInput,
  SCENARIO_DEFAULTS,
  BOTTLENECK_THRESHOLD_CRITICAL,
  BOTTLENECK_THRESHOLD_WARNING,
  DEFAULT_REPLICATIONS,
} from '../capacity/index.js';

/**
 * Handle capacity API requests.
 * Returns true if the request was handled, false if not a capacity API route.
 */
export async function handleCapacityApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/capacity')) return false;

  // CORS
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const route = urlPath.replace('/api/capacity', '') || '/';

  try {
    if (req.method === 'GET') {
      return handleGet(route, res);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res);
    }
    if (req.method === 'DELETE') {
      return handleDelete(route, res);
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, route }, 'Capacity API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

// ── GET Routes ───────────────────────────────────────────────

function handleGet(route: string, res: ServerResponse): boolean {
  switch (route) {
    case '/':
    case '/info': {
      jsonResponse(res, 200, {
        engine: 'Capacity Planning v1.0',
        methodology: '12-step capacity calculation',
        scenario_types: Object.keys(SCENARIO_DEFAULTS),
        thresholds: {
          critical: BOTTLENECK_THRESHOLD_CRITICAL,
          warning: BOTTLENECK_THRESHOLD_WARNING,
        },
        default_replications: DEFAULT_REPLICATIONS,
      });
      return true;
    }

    case '/plans': {
      const plans = listPlans();
      jsonResponse(res, 200, {
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          has_result: !!p.result_json,
          created_at: p.created_at,
          updated_at: p.updated_at,
        })),
      });
      return true;
    }

    case '/scenario-defaults': {
      jsonResponse(res, 200, { defaults: SCENARIO_DEFAULTS });
      return true;
    }

    default: {
      // GET /plans/:id
      const planMatch = route.match(/^\/plans\/(.+)$/);
      if (planMatch) {
        const plan = getPlan(planMatch[1]);
        if (!plan) {
          jsonResponse(res, 404, { error: 'Plan not found' });
          return true;
        }
        jsonResponse(res, 200, {
          ...plan,
          config: JSON.parse(plan.config_json),
          result: plan.result_json ? JSON.parse(plan.result_json) : null,
          history: getResults(plan.id).map((r) => ({
            id: r.id,
            type: r.result_type,
            result: JSON.parse(r.result_json),
            created_at: r.created_at,
          })),
        });
        return true;
      }

      jsonResponse(res, 404, { error: 'Not found' });
      return true;
    }
  }
}

// ── POST Routes ──────────────────────────────────────────────

async function handlePost(route: string, body: unknown, res: ServerResponse): Promise<boolean> {
  const data = body as Record<string, unknown>;

  switch (route) {
    // ── Analyze ──
    case '/analyze': {
      const config = data.config as CapacityPlanConfig;
      if (!config?.lines?.length) {
        jsonResponse(res, 400, { error: 'config with lines[] required' });
        return true;
      }

      const result = analyzeCapacity(config);
      const heatmap = generateUtilizationHeatmap(config);

      // Generate chart
      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateCapacityUtilizationChart(
          result.lines,
          `${config.name} — Utilization`,
        );
      } catch (err) {
        logger.warn({ err }, 'Chart generation failed');
      }

      // Auto-save if name provided
      if (config.name) {
        savePlan(config.name, config, result);
      }

      jsonResponse(res, 200, {
        success: true,
        result,
        heatmap,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── Scenario ──
    case '/scenario': {
      const config = data.config as CapacityPlanConfig;
      const scenario = data.scenario as ScenarioParams;
      if (!config?.lines?.length || !scenario?.type) {
        jsonResponse(res, 400, { error: 'config and scenario required' });
        return true;
      }

      const result = runScenario(config, scenario);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateScenarioComparisonChart(
          [result],
          `Scenario: ${scenario.name}`,
        );
      } catch (err) {
        logger.warn({ err }, 'Scenario chart generation failed');
      }

      jsonResponse(res, 200, {
        success: true,
        result,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── Compare scenarios ──
    case '/compare': {
      const config = data.config as CapacityPlanConfig;
      const scenarios = data.scenarios as ScenarioParams[];
      if (!config?.lines?.length || !scenarios?.length) {
        jsonResponse(res, 400, { error: 'config and scenarios[] required' });
        return true;
      }

      const comparison = compareScenarios(config, scenarios);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateScenarioComparisonChart(
          comparison.scenarios,
          'Scenario Comparison',
        );
      } catch (err) {
        logger.warn({ err }, 'Comparison chart generation failed');
      }

      jsonResponse(res, 200, {
        success: true,
        comparison,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── Monte Carlo ──
    case '/monte-carlo': {
      const config = data.config as CapacityPlanConfig;
      const replications = (data.replications as number) ?? DEFAULT_REPLICATIONS;
      if (!config?.lines?.length) {
        jsonResponse(res, 400, { error: 'config required' });
        return true;
      }

      const mcConfig: MonteCarloCapacityConfig = {
        base_config: config,
        replications,
        efficiency_distribution: data.efficiency_distribution as MonteCarloCapacityConfig['efficiency_distribution'],
        absenteeism_distribution: data.absenteeism_distribution as MonteCarloCapacityConfig['absenteeism_distribution'],
        demand_distribution: data.demand_distribution as MonteCarloCapacityConfig['demand_distribution'],
      };

      const mcResults = runCapacityMonteCarlo(mcConfig);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateMonteCarloHistogram(
          mcResults,
          `Monte Carlo — ${config.name} (${replications} runs)`,
        );
      } catch (err) {
        logger.warn({ err }, 'Monte Carlo chart generation failed');
      }

      // Save result if plan name provided
      if (config.name) {
        const plan = savePlan(config.name, config);
        saveResult(plan.id, 'monte_carlo', mcResults);
      }

      jsonResponse(res, 200, {
        success: true,
        results: mcResults,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── ROI ──
    case '/roi': {
      const input = data as unknown as ROIInput;
      if (!input.investment_cost || !input.capacity_gain_hours) {
        jsonResponse(res, 400, { error: 'investment_cost and capacity_gain_hours required' });
        return true;
      }
      const result = calculateROI(input);
      jsonResponse(res, 200, { success: true, result });
      return true;
    }

    // ── ROI Compare ──
    case '/roi/compare': {
      const inputs = data.scenarios as ROIInput[];
      if (!inputs?.length) {
        jsonResponse(res, 400, { error: 'scenarios[] required' });
        return true;
      }
      const results = compareROIs(inputs);
      jsonResponse(res, 200, { success: true, results });
      return true;
    }

    // ── Save plan ──
    case '/plans': {
      const config = data.config as CapacityPlanConfig;
      const name = (data.name as string) || config?.name;
      if (!name || !config) {
        jsonResponse(res, 400, { error: 'name and config required' });
        return true;
      }
      const plan = savePlan(name, config);
      jsonResponse(res, 201, { success: true, plan: { id: plan.id, name: plan.name } });
      return true;
    }

    // ── Simulate-validate bridge (connect to S16 simulation) ──
    case '/simulate-validate': {
      const config = data.config as CapacityPlanConfig;
      if (!config?.lines?.length) {
        jsonResponse(res, 400, { error: 'config required' });
        return true;
      }

      // Step 1: Run capacity analysis
      const capacityResult = analyzeCapacity(config);

      // Step 2: Build SimulationConfig from capacity data for S16 bridge
      const simConfig = buildSimConfigFromCapacity(config, capacityResult);

      // Step 3: Run simulation if available
      let simResult = null;
      try {
        const { runSimulation, calculateAllBlocks, validateSimulationConfig } = await import('../simulation/index.js');
        const valReport = validateSimulationConfig(simConfig);
        const { metrics, durationSeconds } = await runSimulation(simConfig);
        simResult = calculateAllBlocks(simConfig, metrics, valReport, durationSeconds);
      } catch (err) {
        logger.warn({ err }, 'S16 simulation bridge not available');
      }

      jsonResponse(res, 200, {
        success: true,
        capacity_result: capacityResult,
        simulation_result: simResult,
        bridge_note: simResult
          ? 'Capacity analysis validated with DES simulation.'
          : 'Simulation engine not available — showing capacity analysis only.',
      });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

// ── DELETE Routes ────────────────────────────────────────────

function handleDelete(route: string, res: ServerResponse): boolean {
  const planMatch = route.match(/^\/plans\/(.+)$/);
  if (planMatch) {
    const deleted = deletePlan(planMatch[1]);
    if (deleted) {
      jsonResponse(res, 200, { success: true });
    } else {
      jsonResponse(res, 404, { error: 'Plan not found' });
    }
    return true;
  }

  jsonResponse(res, 404, { error: 'Not found' });
  return true;
}

// ── S16 Simulation Bridge ────────────────────────────────────

function buildSimConfigFromCapacity(
  config: CapacityPlanConfig,
  _result: ReturnType<typeof analyzeCapacity>,
): import('../simulation/models.js').SimulationConfig {
  // Convert capacity lines to simulation operations
  const operations: import('../simulation/models.js').OperationInput[] = [];
  const demands: import('../simulation/models.js').DemandInput[] = [];
  const products = new Set<string>();

  // Create one operation per line as a simplified model
  for (let i = 0; i < config.lines.length; i++) {
    const line = config.lines[i];
    // Aggregate demands for this line to determine products
    const lineDemands = config.demands.filter((d) => d.line_id === line.id);

    for (const ld of lineDemands) {
      const product = ld.product || `Product_${line.code}`;
      products.add(product);

      const samMin = ld.sam_minutes ?? (ld.hours ? (ld.hours / ld.quantity) * 60 : 5);

      operations.push({
        product,
        step: i + 1,
        operation: `${line.name} Processing`,
        machine_tool: line.code,
        sam_min: samMin,
        operators: line.max_operators,
        grade_pct: line.efficiency_factor * 100,
      });

      if (!demands.find((d) => d.product === product)) {
        demands.push({
          product,
          daily_demand: Math.round(ld.quantity / config.calendar.working_days),
          bundle_size: 1,
        });
      }
    }
  }

  // Fallback if no demands mapped
  if (operations.length === 0) {
    for (const line of config.lines) {
      operations.push({
        product: 'Default',
        step: 1,
        operation: line.name,
        machine_tool: line.code,
        sam_min: 5,
        operators: line.max_operators,
      });
    }
    demands.push({ product: 'Default', daily_demand: 100, bundle_size: 1 });
  }

  return {
    operations,
    schedule: {
      shifts_enabled: config.calendar.shifts_per_day,
      shift1_hours: config.calendar.hours_per_shift,
      shift2_hours: config.calendar.shifts_per_day >= 2 ? config.calendar.hours_per_shift : 0,
      shift3_hours: config.calendar.shifts_per_day >= 3 ? config.calendar.hours_per_shift : 0,
      work_days: Math.min(config.calendar.working_days, 7),
    },
    demands,
    mode: 'demand-driven',
    horizon_days: 1,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
