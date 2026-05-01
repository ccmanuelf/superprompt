/**
 * Simulation HTTP API — REST endpoints for the simulation web UI.
 *
 * Mounted on the existing web server at /api/sim/*.
 * Handles JSON request/response for simulation operations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  calculateSimulationMetrics,
  calculateMonteCarloMetrics,
} from '../calculations/simulation.js';
import {
  validateSimulationConfig,
  saveScenario,
  getScenarioByName,
  listScenarios,
  deleteScenario,
  saveSimResult,
  getSimResults,
  generateUtilizationChart,
  generateThroughputChart,
  generateWipChart,
  generateMonteCarloChart,
  formatSimulationResults,
  type SimulationConfig,
  type SimulationResults,
} from '../simulation/index.js';
import {
  isMiniZincAvailable,
  optimizeOperators,
  optimizeSequence,
  optimizeSchedule,
  rebalanceLine,
  optimizeAndValidate,
} from '../minizinc.js';

/**
 * Handle simulation API requests.
 * Returns true if the request was handled, false if not a sim API route.
 */
export async function handleSimApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/sim')) return false;

  // CORS headers for API routes

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const route = urlPath.replace('/api/sim', '') || '/';

  try {
    if (req.method === 'GET') {
      return await handleGet(route, res, chatId);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res, chatId);
    }
    if (req.method === 'DELETE') {
      return await handleDelete(route, res, chatId);
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, route }, 'Sim API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

// ── GET Routes ───────────────────────────────────────────────

async function handleGet(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  switch (route) {
    case '/':
    case '/info': {
      const { ENGINE_VERSION, MAX_PRODUCTS, MAX_TOTAL_OPERATIONS, MAX_HORIZON_DAYS } = await import('../simulation/constants.js');
      jsonResponse(res, 200, {
        engine_version: ENGINE_VERSION,
        limits: { max_products: MAX_PRODUCTS, max_operations: MAX_TOTAL_OPERATIONS, max_horizon_days: MAX_HORIZON_DAYS },
        minizinc_available: isMiniZincAvailable(),
      });
      return true;
    }

    case '/scenarios': {
      const scenarios = await listScenarios(chatId);
      jsonResponse(res, 200, {
        scenarios: scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          updated: new Date(s.updated_at).toISOString(),
        })),
      });
      return true;
    }

    default: {
      // GET /scenarios/:name
      const scenarioMatch = route.match(/^\/scenarios\/(.+)$/);
      if (scenarioMatch) {
        const name = decodeURIComponent(scenarioMatch[1]);
        const scenario = await getScenarioByName(name, chatId);
        if (!scenario) {
          jsonResponse(res, 404, { error: `Scenario "${name}" not found` });
          return true;
        }
        jsonResponse(res, 200, {
          id: scenario.id,
          name: scenario.name,
          config: JSON.parse(scenario.config_json),
          results: (await getSimResults(scenario.id)).map((r) => ({
            type: r.result_type,
            data: JSON.parse(r.result_json),
            created: new Date(r.created_at).toISOString(),
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

async function handlePost(route: string, body: Record<string, unknown>, res: ServerResponse, chatId: string): Promise<boolean> {
  switch (route) {
    case '/validate': {
      const config = body.config as SimulationConfig;
      if (!config) { jsonResponse(res, 400, { error: 'config is required' }); return true; }
      const report = validateSimulationConfig(config);
      jsonResponse(res, 200, report);
      return true;
    }

    case '/run': {
      const config = body.config as SimulationConfig;
      if (!config) { jsonResponse(res, 400, { error: 'config is required' }); return true; }

      const report = validateSimulationConfig(config);
      if (!report.is_valid) {
        jsonResponse(res, 200, { success: false, validation_report: report, message: 'Validation failed' });
        return true;
      }

      const seed = typeof body.seed === 'number' ? body.seed : 42;
      const results = (await calculateSimulationMetrics(
        { config, validationReport: report, seed },
        {},
        'standard',
      )).value;

      // Auto-save if scenario name provided
      const scenarioName = body.scenario_name as string;
      if (scenarioName) {
        const scenario = await saveScenario(scenarioName, config, chatId);
        await saveSimResult(scenario.id, 'single', results);
      }

      jsonResponse(res, 200, { success: true, results, validation_report: report, message: 'Simulation complete' });
      return true;
    }

    case '/monte-carlo': {
      const config = body.config as SimulationConfig;
      if (!config) { jsonResponse(res, 400, { error: 'config is required' }); return true; }

      const report = validateSimulationConfig(config);
      if (!report.is_valid) {
        jsonResponse(res, 200, { success: false, validation_report: report, message: 'Validation failed' });
        return true;
      }

      const replications = typeof body.replications === 'number' ? body.replications : 30;
      const mcResults = (await calculateMonteCarloMetrics(
        { config, replications },
        {},
        'standard',
      )).value;

      // Convert Maps to plain objects for JSON serialization
      const utilByStation: Record<string, unknown> = {};
      for (const [k, v] of mcResults.utilization_by_station) utilByStation[k] = v;

      const scenarioName = body.scenario_name as string;
      if (scenarioName) {
        const scenario = await saveScenario(scenarioName, config, chatId);
        await saveSimResult(scenario.id, 'monte_carlo', {
          replications: mcResults.replications,
          throughput: mcResults.throughput,
          cycle_time: mcResults.cycle_time,
          max_wip: mcResults.max_wip,
          utilization_by_station: utilByStation,
          demand_met_pct: mcResults.demand_met_pct,
        });
      }

      jsonResponse(res, 200, {
        success: true,
        replications: mcResults.replications,
        throughput: mcResults.throughput,
        cycle_time: mcResults.cycle_time,
        max_wip: mcResults.max_wip,
        utilization_by_station: utilByStation,
        demand_met_pct: mcResults.demand_met_pct,
      });
      return true;
    }

    case '/optimize': {
      const type = body.type as string;
      if (!type) { jsonResponse(res, 400, { error: 'type is required (operators/sequence/schedule/rebalance)' }); return true; }

      if (!isMiniZincAvailable()) {
        jsonResponse(res, 503, { error: 'MiniZinc solver is not available on this system' });
        return true;
      }

      switch (type) {
        case 'operators': {
          const result = optimizeOperators(body.input as Parameters<typeof optimizeOperators>[0]);
          jsonResponse(res, 200, { success: !!result, result });
          return true;
        }
        case 'sequence': {
          const result = optimizeSequence(body.input as Parameters<typeof optimizeSequence>[0]);
          jsonResponse(res, 200, { success: !!result, result });
          return true;
        }
        case 'schedule': {
          const result = optimizeSchedule(body.input as Parameters<typeof optimizeSchedule>[0]);
          jsonResponse(res, 200, { success: !!result, result });
          return true;
        }
        case 'rebalance': {
          const result = rebalanceLine(body.input as Parameters<typeof rebalanceLine>[0]);
          jsonResponse(res, 200, { success: !!result, result });
          return true;
        }
        default:
          jsonResponse(res, 400, { error: `Unknown optimization type: ${type}` });
          return true;
      }
    }

    case '/sensitivity': {
      const config = body.config as SimulationConfig;
      if (!config) { jsonResponse(res, 400, { error: 'config is required' }); return true; }

      const param = (body.param as string) || 'demand';
      const range = typeof body.range === 'number' ? body.range / 100 : 0.2;
      const steps = typeof body.steps === 'number' ? body.steps : 5;

      const report = validateSimulationConfig(config);
      if (!report.is_valid) {
        jsonResponse(res, 200, { success: false, message: 'Validation failed' });
        return true;
      }

      const results = [];
      for (let i = 0; i < steps; i++) {
        const factor = 1 + range * (2 * i / (steps - 1) - 1);
        const modConfig = JSON.parse(JSON.stringify(config)) as SimulationConfig;

        if (param === 'demand') {
          for (const d of modConfig.demands) {
            if (d.daily_demand) d.daily_demand = Math.round(d.daily_demand * factor);
            if (d.weekly_demand) d.weekly_demand = Math.round(d.weekly_demand * factor);
          }
        } else if (param === 'operators') {
          for (const op of modConfig.operations) {
            op.operators = Math.max(1, Math.round((op.operators ?? 1) * factor));
          }
        } else if (param === 'shift_hours') {
          modConfig.schedule.shift1_hours = Math.max(1, modConfig.schedule.shift1_hours * factor);
        }

        const modReport = validateSimulationConfig(modConfig);
        const simResults = (await calculateSimulationMetrics(
          { config: modConfig, validationReport: modReport },
          {},
          'standard',
        )).value;
        const topStation = simResults.station_performance[0];

        results.push({
          factor: Math.round(factor * 100),
          throughput: simResults.daily_summary.daily_throughput_pcs,
          coverage: simResults.daily_summary.daily_coverage_pct,
          bottleneck: topStation ? `${topStation.machine_tool} (${topStation.util_pct}%)` : 'N/A',
        });
      }

      jsonResponse(res, 200, { success: true, param, results });
      return true;
    }

    case '/optimize-and-validate': {
      const config = body.config as SimulationConfig;
      if (!config) { jsonResponse(res, 400, { error: 'config is required' }); return true; }
      const optType = (body.optimization_type as string) || 'operators';
      if (!isMiniZincAvailable()) {
        jsonResponse(res, 503, { error: 'MiniZinc solver not available' });
        return true;
      }

      const result = await optimizeAndValidate({
        optimization_type: optType as 'operators' | 'rebalance',
        config,
        replications: typeof body.replications === 'number' ? body.replications : 30,
      });

      if (!result) {
        jsonResponse(res, 200, { success: false, message: 'Optimization found no feasible solution' });
        return true;
      }

      jsonResponse(res, 200, { success: true, ...result });
      return true;
    }

    case '/scenarios': {
      const name = body.name as string;
      const config = body.config as SimulationConfig;
      if (!name || !config) { jsonResponse(res, 400, { error: 'name and config are required' }); return true; }
      const scenario = await saveScenario(name, config, chatId);
      jsonResponse(res, 200, { success: true, id: scenario.id, name: scenario.name });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

// ── DELETE Routes ─────────────────────────────────────────────

async function handleDelete(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  const scenarioMatch = route.match(/^\/scenarios\/(.+)$/);
  if (scenarioMatch) {
    const name = decodeURIComponent(scenarioMatch[1]);
    const scenario = await getScenarioByName(name, chatId);
    if (!scenario) {
      jsonResponse(res, 404, { error: `Scenario "${name}" not found` });
      return true;
    }
    await deleteScenario(scenario.id, chatId);
    jsonResponse(res, 200, { success: true });
    return true;
  }

  jsonResponse(res, 404, { error: 'Not found' });
  return true;
}

// ── Helpers ──────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
