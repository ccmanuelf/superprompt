/**
 * Manufacturing Pack — Level 3 barrel export.
 *
 * This pack owns all 15 manufacturing domain modules:
 * balance, sigma, inventory, control-plan, fmea, rca,
 * simulation, capacity, sequencer, vsm, toc, conwip, doe, fsm, minizinc
 *
 * The source files remain at their current paths in src/ for import
 * compatibility. This barrel is the ownership boundary — the pack system
 * loads manufacturing through this file, not through src/index.ts.
 *
 * SA5: Extracted from core into capability pack.
 */

import type { TableInitializer } from '../../core/interfaces.js';
import type { ToolEntry } from '../../forge/tool-registry.js';
import { registerTool } from '../../forge/tool-registry.js';
import { registerToolPolicy } from '../../policy-engine.js';

// ── Table Initializers ───────────────────────────────────────

import { balanceTableInit } from '../../balance.js';
import { sigmaTableInit } from '../../sigma.js';
import { inventoryTableInit } from '../../inventory.js';
import { controlPlanTableInit } from '../../control-plan.js';
import { fmeaTableInit } from '../../fmea.js';
import { rcaTableInit } from '../../rca.js';
import { simulationTableInit } from '../../simulation/index.js';
import { capacityTableInit } from '../../capacity/index.js';
import { sequencerTableInit } from '../../sequencer/index.js';
import { vsmTableInit } from '../../vsm/index.js';
import { tocTableInit } from '../../toc/index.js';
import { conwipTableInit } from '../../conwip/index.js';
import { doeTableInit } from '../../doe/index.js';
import { fsmTableInit } from '../../fsm/index.js';

/** Combined table initializer for all 15 manufacturing modules */
export const tableInit: TableInitializer = {
  name: 'manufacturing',
  initTables() {
    balanceTableInit.initTables();
    sigmaTableInit.initTables();
    inventoryTableInit.initTables();
    controlPlanTableInit.initTables();
    fmeaTableInit.initTables();
    rcaTableInit.initTables();
    simulationTableInit.initTables();
    capacityTableInit.initTables();
    sequencerTableInit.initTables();
    vsmTableInit.initTables();
    tocTableInit.initTables();
    conwipTableInit.initTables();
    doeTableInit.initTables();
    fsmTableInit.initTables();
  },
};

// ── Tool Registration ────────────────────────────────────────

import { lineBalanceDefinition, lineBalance } from '../../providers/tools/balance.js';
import { sigmaAnalysisDefinition, sigmaAnalysis } from '../../providers/tools/sigma.js';
import { inventoryPlanDefinition, inventoryPlan } from '../../providers/tools/inventory.js';
import { spcSetupDefinition, spcSetup } from '../../providers/tools/spc-setup.js';
import { fmeaManageDefinition, fmeaManage } from '../../providers/tools/fmea.js';
import { rcaManageDefinition, rcaManage } from '../../providers/tools/rca.js';
import { simulationDefinition, productionSimulation } from '../../providers/tools/simulation.js';
import { minizincOptimizeDefinition, minizincOptimize } from '../../providers/tools/minizinc-tool.js';
import { capacityDefinition, capacityPlanning } from '../../providers/tools/capacity.js';
import { sequencerDefinition, jobSequencer } from '../../providers/tools/sequencer.js';
import { vsmDefinition, valueStreamMap } from '../../providers/tools/vsm.js';
import { tocDefinition, tocAnalysis } from '../../providers/tools/toc.js';
import { conwipDefinition, conwipHeijunka } from '../../providers/tools/conwip.js';
import { doeDefinition, designOfExperiments } from '../../providers/tools/doe.js';
import { fsmDefinition, stateMachineSimulator } from '../../providers/tools/fsm.js';

/** Register all 15 manufacturing tools in the tool registry */
export function registerTools(): void {
  const tools: ToolEntry[] = [
    {
      definition: lineBalanceDefinition,
      execute: async (args, chatId) => lineBalance(args as Parameters<typeof lineBalance>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: sigmaAnalysisDefinition,
      execute: async (args, chatId) => sigmaAnalysis(args as Parameters<typeof sigmaAnalysis>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: inventoryPlanDefinition,
      execute: async (args, chatId) => inventoryPlan(args as Parameters<typeof inventoryPlan>[0], chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: spcSetupDefinition,
      execute: async (args, chatId) => spcSetup(args as Record<string, unknown>, chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: fmeaManageDefinition,
      execute: async (args, chatId) => fmeaManage(args as Record<string, unknown>, chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: rcaManageDefinition,
      execute: async (args, chatId) => rcaManage(args as Record<string, unknown>, chatId),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: simulationDefinition,
      execute: async (args) => productionSimulation(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: minizincOptimizeDefinition,
      execute: async (args) => minizincOptimize(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['command', 'database:write'], requiresConfirmation: false },
    },
    {
      definition: capacityDefinition,
      execute: async (args) => capacityPlanning(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: sequencerDefinition,
      execute: async (args) => jobSequencer(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: vsmDefinition,
      execute: async (args) => valueStreamMap(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: tocDefinition,
      execute: async (args) => tocAnalysis(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: conwipDefinition,
      execute: async (args) => conwipHeijunka(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: doeDefinition,
      execute: async (args) => designOfExperiments(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
    {
      definition: fsmDefinition,
      execute: async (args) => stateMachineSimulator(args as Record<string, unknown>),
      source: 'builtin',
      policy: { riskLevel: 'medium', scopes: ['database:write'], requiresConfirmation: false },
    },
  ];

  for (const entry of tools) {
    registerTool(entry);
    if (entry.policy) {
      registerToolPolicy(entry.definition.function.name!, entry.policy);
    }
  }
}
