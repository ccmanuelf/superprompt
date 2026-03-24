/**
 * Simulation HTTP API — REST endpoints for the simulation web UI.
 *
 * Mounted on the existing web server at /api/sim/*.
 * Handles JSON request/response for simulation operations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  runSimulation,
  validateSimulationConfig,
  calculateAllBlocks,
  runMonteCarlo,
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
} from '../minizinc.js';

/**
 * Handle simulation API requests.
 * Returns true if the request was handled, false if not a sim API route.
 */
export async function handleSimApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/sim')) return false;

  // CORS headers for API routes
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      return await handleGet(route, res);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res);
    }
    if (req.method === 'DELETE') {
      return await handleDelete(route, res);
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

async function handleGet(route: string, res: ServerResponse): Promise<boolean> {
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
      const scenarios = listScenarios();
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
        const scenario = getScenarioByName(name);
        if (!scenario) {
          jsonResponse(res, 404, { error: `Scenario "${name}" not found` });
          return true;
        }
        jsonResponse(res, 200, {
          id: scenario.id,
          name: scenario.name,
          config: JSON.parse(scenario.config_json),
          results: getSimResults(scenario.id).map((r) => ({
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

async function handlePost(route: string, body: Record<string, unknown>, res: ServerResponse): Promise<boolean> {
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
      const { metrics, durationSeconds } = await runSimulation(config, seed);
      const results = calculateAllBlocks(config, metrics, report, durationSeconds);

      // Auto-save if scenario name provided
      const scenarioName = body.scenario_name as string;
      if (scenarioName) {
        const scenario = saveScenario(scenarioName, config);
        saveSimResult(scenario.id, 'single', results);
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
      const mcResults = await runMonteCarlo(config, replications);

      // Convert Maps to plain objects for JSON serialization
      const utilByStation: Record<string, unknown> = {};
      for (const [k, v] of mcResults.utilization_by_station) utilByStation[k] = v;

      const scenarioName = body.scenario_name as string;
      if (scenarioName) {
        const scenario = saveScenario(scenarioName, config);
        saveSimResult(scenario.id, 'monte_carlo', {
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

    case '/scenarios': {
      const name = body.name as string;
      const config = body.config as SimulationConfig;
      if (!name || !config) { jsonResponse(res, 400, { error: 'name and config are required' }); return true; }
      const scenario = saveScenario(name, config);
      jsonResponse(res, 200, { success: true, id: scenario.id, name: scenario.name });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

// ── DELETE Routes ─────────────────────────────────────────────

async function handleDelete(route: string, res: ServerResponse): Promise<boolean> {
  const scenarioMatch = route.match(/^\/scenarios\/(.+)$/);
  if (scenarioMatch) {
    const name = decodeURIComponent(scenarioMatch[1]);
    const scenario = getScenarioByName(name);
    if (!scenario) {
      jsonResponse(res, 404, { error: `Scenario "${name}" not found` });
      return true;
    }
    deleteScenario(scenario.id);
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
    'Access-Control-Allow-Origin': '*',
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
