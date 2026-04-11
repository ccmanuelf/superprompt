import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';
import { inverseNormal } from './sigma.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Types ────────────────────────────────────────────────────

export interface InventoryItem {
  item_id: string;
  description: string;
  annual_demand: number;
  unit_cost: number;
  order_cost: number;
  holding_cost_pct: number;
  lead_time_days: number;
  service_level: number; // 0-1 (e.g. 0.95 for 95%)
  demand_stddev?: number; // daily demand standard deviation
}

export interface ReplenishmentPlan {
  item_id: string;
  description: string;
  eoq: number;
  reorder_point: number;
  safety_stock: number;
  daily_demand: number;
  annual_holding_cost: number;
  annual_order_cost: number;
  total_annual_cost: number;
  orders_per_year: number;
  days_between_orders: number;
}

export interface AbcItem {
  item_id: string;
  description: string;
  annual_demand: number;
  unit_cost: number;
  annual_dollar_volume: number;
  cumulative_pct: number;
  classification: 'A' | 'B' | 'C';
}

export interface ForecastResult {
  method: string;
  alpha: number;
  forecasts: number[];
  actuals: number[];
  mape: number; // mean absolute percentage error
  mad: number;  // mean absolute deviation
}

export interface InventoryProject {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface InventoryResultRow {
  id: string;
  project_id: string;
  result_type: string;
  result_json: string;
  created_at: number;
}

// ── Database ─────────────────────────────────────────────────

export async function initInventoryTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('inventory_projects'))) {
    await db.schema.createTable('inventory_projects', (t) => {
      t.text('id').primary();
      t.text('name').notNullable();
      t.text('description').notNullable().defaultTo('');
      t.integer('created_at').notNullable();
      t.integer('updated_at').notNullable();
    });
  }

  if (!(await db.schema.hasTable('inventory_items'))) {
    await db.schema.createTable('inventory_items', (t) => {
      t.increments('id').primary();
      t.text('project_id').notNullable().references('id').inTable('inventory_projects').onDelete('CASCADE');
      t.text('item_id').notNullable();
      t.text('description').notNullable().defaultTo('');
      t.float('annual_demand').notNullable();
      t.float('unit_cost').notNullable();
      t.float('order_cost').notNullable();
      t.float('holding_cost_pct').notNullable();
      t.float('lead_time_days').notNullable();
      t.float('service_level').notNullable().defaultTo(0.95);
      t.float('demand_stddev');
      t.unique(['project_id', 'item_id']);
    });
    await db.schema.raw('CREATE INDEX IF NOT EXISTS idx_inventory_items_project ON inventory_items(project_id)');
  }

  if (!(await db.schema.hasTable('inventory_results'))) {
    await db.schema.createTable('inventory_results', (t) => {
      t.text('id').primary();
      t.text('project_id').notNullable().references('id').inTable('inventory_projects').onDelete('CASCADE');
      t.text('result_type').notNullable();
      t.text('result_json').notNullable();
      t.integer('created_at').notNullable();
    });
    await db.schema.raw('CREATE INDEX IF NOT EXISTS idx_inventory_results_project ON inventory_results(project_id)');
  }
}

export const inventoryTableInit: TableInitializer = { name: 'inventory', initTables: initInventoryTables };

function genId(): string {
  return randomBytes(16).toString('hex');
}

export async function createInventoryProject(name: string, description: string = ''): Promise<InventoryProject> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('inventory_projects').insert({
    id, name, description, created_at: now, updated_at: now,
  });
  return { id, name, description, created_at: now, updated_at: now };
}

export async function getInventoryProjectByName(name: string): Promise<InventoryProject | undefined> {
  return await getKnex()('inventory_projects')
    .whereRaw('LOWER(name) = LOWER(?)', [name]).first() as InventoryProject | undefined;
}

export async function listInventoryProjects(): Promise<InventoryProject[]> {
  return await getKnex()('inventory_projects')
    .orderBy('updated_at', 'desc') as InventoryProject[];
}

export async function deleteInventoryProject(id: string): Promise<boolean> {
  const count = await getKnex()('inventory_projects').where({ id }).del();
  return count > 0;
}

export async function insertInventoryItems(projectId: string, items: InventoryItem[]): Promise<void> {
  const db = getKnex();
  await db.transaction(async (trx) => {
    for (const item of items) {
      await trx('inventory_items').insert({
        project_id: projectId, item_id: item.item_id, description: item.description,
        annual_demand: item.annual_demand, unit_cost: item.unit_cost,
        order_cost: item.order_cost, holding_cost_pct: item.holding_cost_pct,
        lead_time_days: item.lead_time_days, service_level: item.service_level,
        demand_stddev: item.demand_stddev ?? null,
      });
    }
  });
}

export async function getInventoryItems(projectId: string): Promise<InventoryItem[]> {
  const rows = await getKnex()('inventory_items')
    .where({ project_id: projectId })
    .orderBy('item_id') as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    item_id: r.item_id as string,
    description: r.description as string,
    annual_demand: r.annual_demand as number,
    unit_cost: r.unit_cost as number,
    order_cost: r.order_cost as number,
    holding_cost_pct: r.holding_cost_pct as number,
    lead_time_days: r.lead_time_days as number,
    service_level: r.service_level as number,
    demand_stddev: r.demand_stddev as number | undefined,
  }));
}

export async function saveInventoryResult(projectId: string, resultType: string, data: unknown): Promise<string> {
  const db = getKnex();
  const id = genId();
  const now = Date.now();
  await db('inventory_results').insert({
    id, project_id: projectId, result_type: resultType,
    result_json: JSON.stringify(data), created_at: now,
  });
  await db('inventory_projects').where({ id: projectId }).update({ updated_at: now });
  return id;
}

export async function getInventoryResults(projectId: string): Promise<InventoryResultRow[]> {
  return await getKnex()('inventory_results')
    .where({ project_id: projectId })
    .orderBy('created_at', 'desc') as InventoryResultRow[];
}

// ── CSV Parsing ──────────────────────────────────────────────

/**
 * Parse inventory CSV.
 * Required: item_id, annual_demand, unit_cost, order_cost, holding_cost_pct, lead_time_days
 * Optional: description, service_level (default 0.95), demand_stddev
 * Exported for testing.
 */
export function parseInventoryCsv(csvContent: string): InventoryItem[] {
  const lines = csvContent.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const required = ['item_id', 'annual_demand', 'unit_cost', 'order_cost', 'holding_cost_pct', 'lead_time_days'];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`CSV must have column "${col}". Found: ${header.join(', ')}`);
    }
  }

  const idx = (col: string) => header.indexOf(col);

  const items: InventoryItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim());

    const itemId = cols[idx('item_id')];
    if (!itemId) throw new Error(`Row ${i + 1}: item_id is required.`);

    const annualDemand = parseFloat(cols[idx('annual_demand')]);
    const unitCost = parseFloat(cols[idx('unit_cost')]);
    const orderCost = parseFloat(cols[idx('order_cost')]);
    const holdingPct = parseFloat(cols[idx('holding_cost_pct')]);
    const leadTime = parseFloat(cols[idx('lead_time_days')]);

    if ([annualDemand, unitCost, orderCost, holdingPct, leadTime].some(isNaN)) {
      throw new Error(`Row ${i + 1}: all numeric fields must be valid numbers.`);
    }
    if (annualDemand < 0 || unitCost < 0 || orderCost < 0 || holdingPct < 0 || leadTime < 0) {
      throw new Error(`Row ${i + 1}: numeric fields must be non-negative.`);
    }

    const descIdx = idx('description');
    const slIdx = idx('service_level');
    const sdIdx = idx('demand_stddev');

    const sl = slIdx >= 0 ? parseFloat(cols[slIdx]) : 0.95;
    const sd = sdIdx >= 0 && cols[sdIdx] ? parseFloat(cols[sdIdx]) : undefined;

    items.push({
      item_id: itemId,
      description: descIdx >= 0 ? cols[descIdx] || itemId : itemId,
      annual_demand: annualDemand,
      unit_cost: unitCost,
      order_cost: orderCost,
      holding_cost_pct: holdingPct,
      lead_time_days: leadTime,
      service_level: isNaN(sl) ? 0.95 : Math.min(Math.max(sl, 0.5), 0.9999),
      demand_stddev: sd !== undefined && !isNaN(sd) ? sd : undefined,
    });
  }

  if (items.length === 0) throw new Error('CSV contains no data rows.');
  return items;
}

// ── EOQ & Replenishment ──────────────────────────────────────

/**
 * Calculate Economic Order Quantity.
 * Q* = sqrt(2DS/H)
 * Exported for testing.
 */
export function calculateEOQ(annualDemand: number, orderCost: number, holdingCostPerUnit: number): number {
  if (annualDemand <= 0 || orderCost <= 0 || holdingCostPerUnit <= 0) return 0;
  return Math.sqrt((2 * annualDemand * orderCost) / holdingCostPerUnit);
}

/**
 * Calculate safety stock.
 * SS = Z × σ_daily × sqrt(lead_time)
 * If demand_stddev not provided, estimate as 25% of daily demand.
 * Exported for testing.
 */
export function calculateSafetyStock(
  dailyDemand: number,
  leadTimeDays: number,
  serviceLevel: number,
  demandStddev?: number,
): number {
  if (leadTimeDays <= 0) return 0;
  const z = inverseNormal(serviceLevel);
  const sigma = demandStddev !== undefined ? demandStddev : dailyDemand * 0.25;
  return z * sigma * Math.sqrt(leadTimeDays);
}

/**
 * Calculate reorder point.
 * ROP = (daily_demand × lead_time) + safety_stock
 * Exported for testing.
 */
export function calculateReorderPoint(dailyDemand: number, leadTimeDays: number, safetyStock: number): number {
  return dailyDemand * leadTimeDays + safetyStock;
}

/**
 * Generate full replenishment plan for a set of inventory items.
 * Exported for testing.
 */
export function generateReplenishmentPlan(items: InventoryItem[]): ReplenishmentPlan[] {
  return items.map((item) => {
    const holdingCostPerUnit = item.unit_cost * (item.holding_cost_pct / 100);
    const dailyDemand = item.annual_demand / 365;

    // When holding cost is zero, order the full annual demand at once (1 order/year)
    // since there's no cost to holding inventory.
    let eoq = calculateEOQ(item.annual_demand, item.order_cost, holdingCostPerUnit);
    if (eoq === 0 && item.annual_demand > 0) {
      eoq = item.annual_demand;
    }

    const safetyStock = calculateSafetyStock(dailyDemand, item.lead_time_days, item.service_level, item.demand_stddev);
    const rop = calculateReorderPoint(dailyDemand, item.lead_time_days, safetyStock);

    const ordersPerYear = eoq > 0 ? item.annual_demand / eoq : 0;
    const annualOrderCost = ordersPerYear * item.order_cost;
    const avgInventory = eoq / 2 + safetyStock;
    const annualHoldingCost = avgInventory * holdingCostPerUnit;

    return {
      item_id: item.item_id,
      description: item.description,
      eoq: round2(eoq),
      reorder_point: round2(rop),
      safety_stock: round2(safetyStock),
      daily_demand: round4(dailyDemand),
      annual_holding_cost: round2(annualHoldingCost),
      annual_order_cost: round2(annualOrderCost),
      total_annual_cost: round2(annualOrderCost + annualHoldingCost),
      orders_per_year: round2(ordersPerYear),
      days_between_orders: ordersPerYear > 0 ? round2(365 / ordersPerYear) : 0,
    };
  });
}

// ── ABC Classification ───────────────────────────────────────

/**
 * ABC classification by annual dollar volume.
 * A: top ~80% of dollar volume, B: next ~15%, C: rest.
 * Exported for testing.
 */
export function abcClassification(items: InventoryItem[]): AbcItem[] {
  const withDollarVol = items.map((item) => ({
    ...item,
    annual_dollar_volume: item.annual_demand * item.unit_cost,
  }));

  // Sort descending by dollar volume
  withDollarVol.sort((a, b) => b.annual_dollar_volume - a.annual_dollar_volume);

  const totalDollarVol = withDollarVol.reduce((s, i) => s + i.annual_dollar_volume, 0);

  let cumulative = 0;
  return withDollarVol.map((item) => {
    cumulative += item.annual_dollar_volume;
    const cumulativePct = totalDollarVol > 0 ? (cumulative / totalDollarVol) * 100 : 0;

    // Items contributing to top 80% of dollar volume are A,
    // next 15% (up to 95%) are B, rest are C.
    // Use previous cumulative to determine: if adding this item crosses the threshold,
    // it still belongs to the category it's contributing to.
    const prevCumPct = cumulativePct - (totalDollarVol > 0 ? (item.annual_dollar_volume / totalDollarVol) * 100 : 0);

    let classification: 'A' | 'B' | 'C';
    if (prevCumPct < 80) classification = 'A';
    else if (prevCumPct < 95) classification = 'B';
    else classification = 'C';

    return {
      item_id: item.item_id,
      description: item.description,
      annual_demand: item.annual_demand,
      unit_cost: item.unit_cost,
      annual_dollar_volume: round2(item.annual_dollar_volume),
      cumulative_pct: round2(cumulativePct),
      classification,
    };
  });
}

// ── Exponential Smoothing ────────────────────────────────────

/**
 * Simple exponential smoothing with auto-selected alpha.
 * Tests multiple alpha values and picks the one with lowest MAD.
 * Exported for testing.
 */
export function exponentialSmoothing(actuals: number[], alpha?: number): ForecastResult {
  if (actuals.length < 3) throw new Error('Need at least 3 data points for forecasting.');

  // If alpha not provided, find optimal
  const alphas = alpha !== undefined ? [alpha] : [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  let bestAlpha = 0.3;
  let bestMad = Infinity;

  for (const a of alphas) {
    const forecasts = computeSES(actuals, a);
    const mad = computeMAD(actuals, forecasts);
    if (mad < bestMad) {
      bestMad = mad;
      bestAlpha = a;
    }
  }

  const forecasts = computeSES(actuals, bestAlpha);
  const mad = computeMAD(actuals, forecasts);
  const mape = computeMAPE(actuals, forecasts);

  return {
    method: 'Simple Exponential Smoothing',
    alpha: bestAlpha,
    forecasts: forecasts.map(round2),
    actuals,
    mape: round2(mape),
    mad: round2(mad),
  };
}

function computeSES(actuals: number[], alpha: number): number[] {
  const forecasts: number[] = [actuals[0]]; // F1 = A1
  for (let i = 1; i < actuals.length; i++) {
    forecasts.push(alpha * actuals[i - 1] + (1 - alpha) * forecasts[i - 1]);
  }
  // One-step-ahead forecast
  forecasts.push(alpha * actuals[actuals.length - 1] + (1 - alpha) * forecasts[forecasts.length - 1]);
  return forecasts;
}

function computeMAD(actuals: number[], forecasts: number[]): number {
  let totalError = 0;
  let count = 0;
  for (let i = 1; i < actuals.length; i++) {
    totalError += Math.abs(actuals[i] - forecasts[i]);
    count++;
  }
  return count > 0 ? totalError / count : 0;
}

function computeMAPE(actuals: number[], forecasts: number[]): number {
  let totalPctError = 0;
  let count = 0;
  for (let i = 1; i < actuals.length; i++) {
    if (actuals[i] !== 0) {
      totalPctError += Math.abs((actuals[i] - forecasts[i]) / actuals[i]) * 100;
      count++;
    }
  }
  return count > 0 ? totalPctError / count : 0;
}

// ── Chart Generation ─────────────────────────────────────────

/**
 * Generate ABC classification chart (Pareto-style with A/B/C zones).
 * Exported for testing.
 */
export async function generateAbcChart(abc: AbcItem[], projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({
    width: Math.max(700, abc.length * 50 + 200),
    height: 450,
    backgroundColour: 'white',
  });

  const labels = abc.map((i) => i.item_id);
  const dollarVols = abc.map((i) => i.annual_dollar_volume);
  const cumPcts = abc.map((i) => i.cumulative_pct);
  const colors = abc.map((i) =>
    i.classification === 'A' ? '#e15759' :
    i.classification === 'B' ? '#f28e2b' : '#76b7b2',
  );

  const aCount = abc.filter((i) => i.classification === 'A').length;
  const bCount = abc.filter((i) => i.classification === 'B').length;
  const cCount = abc.filter((i) => i.classification === 'C').length;

  const config = {
    type: 'bar' as const,
    data: {
      labels,
      datasets: [
        {
          type: 'bar' as const,
          label: 'Annual $ Volume',
          data: dollarVols,
          backgroundColor: colors,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line' as const,
          label: 'Cumulative %',
          data: cumPcts,
          borderColor: '#333',
          backgroundColor: 'transparent',
          pointRadius: 2,
          borderWidth: 2,
          yAxisID: 'y1',
          order: 1,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `ABC Classification: ${projectName}`,
            `A: ${aCount} items | B: ${bCount} items | C: ${cCount} items`,
          ],
          font: { size: 14 },
        },
        legend: { position: 'bottom' as const, labels: { font: { size: 10 } } },
      },
      scales: {
        y: { title: { display: true, text: 'Annual Dollar Volume' }, min: 0 },
        y1: {
          position: 'right' as const,
          title: { display: true, text: 'Cumulative %' },
          min: 0, max: 100,
          grid: { drawOnChartArea: false },
        },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `inventory-abc-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate forecast chart (actuals vs forecast line).
 * Exported for testing.
 */
export async function generateForecastChart(forecast: ForecastResult, projectName: string): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400, backgroundColour: 'white' });

  const labels = forecast.actuals.map((_, i) => `${i + 1}`);
  // Add one more label for the next-period forecast
  labels.push(`${forecast.actuals.length + 1}`);

  const config = {
    type: 'line' as const,
    data: {
      labels,
      datasets: [
        {
          label: 'Actual',
          data: [...forecast.actuals, null],
          borderColor: '#4e79a7',
          backgroundColor: 'transparent',
          pointRadius: 3,
          borderWidth: 2,
        },
        {
          label: `Forecast (α=${forecast.alpha})`,
          data: forecast.forecasts,
          borderColor: '#e15759',
          backgroundColor: 'transparent',
          pointRadius: 2,
          borderWidth: 2,
          borderDash: [4, 2],
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `Demand Forecast: ${projectName}`,
            `MAPE: ${forecast.mape.toFixed(1)}% | MAD: ${forecast.mad.toFixed(1)} | α: ${forecast.alpha}`,
          ],
          font: { size: 14 },
        },
        legend: { position: 'bottom' as const },
      },
      scales: {
        x: { title: { display: true, text: 'Period' } },
        y: { title: { display: true, text: 'Demand' } },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `inventory-forecast-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── Full Pipeline ────────────────────────────────────────────

/**
 * Execute full inventory analysis: parse CSV, compute plans, classify, save.
 */
export async function executeInventoryAnalysis(
  csvContent: string,
  projectName: string,
  demandHistory?: number[],
): Promise<{
  project: InventoryProject;
  plans: ReplenishmentPlan[];
  abc: AbcItem[];
  forecast: ForecastResult | null;
  stockoutRisks: string[];
}> {
  const items = parseInventoryCsv(csvContent);

  const plans = generateReplenishmentPlan(items);
  const abc = abcClassification(items);
  const forecast = demandHistory && demandHistory.length >= 3
    ? exponentialSmoothing(demandHistory) : null;

  // Stockout risk alerts
  const stockoutRisks: string[] = [];
  for (const plan of plans) {
    if (plan.safety_stock <= 0) {
      stockoutRisks.push(`${plan.item_id}: Zero safety stock — high stockout risk.`);
    }
    const item = items.find((i) => i.item_id === plan.item_id)!;
    if (item.service_level < 0.90) {
      stockoutRisks.push(`${plan.item_id}: Service level ${(item.service_level * 100).toFixed(0)}% — below recommended 90%.`);
    }
  }

  // DB: reuse or create project
  let project = await getInventoryProjectByName(projectName);
  if (project) {
    const db = getKnex();
    await db('inventory_items').where({ project_id: project.id }).del();
    await db('inventory_projects').where({ id: project.id }).update({ updated_at: Date.now() });
  } else {
    project = await createInventoryProject(projectName);
  }

  await insertInventoryItems(project.id, items);
  await saveInventoryResult(project.id, 'replenishment', plans);
  await saveInventoryResult(project.id, 'abc', abc);
  if (forecast) await saveInventoryResult(project.id, 'forecast', forecast);

  logger.info(
    { projectName, items: items.length, aItems: abc.filter((i) => i.classification === 'A').length },
    'Inventory analysis completed',
  );

  return { project, plans, abc, forecast, stockoutRisks };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format replenishment plan for display.
 * Exported for testing.
 */
export function formatReplenishmentPlan(plans: ReplenishmentPlan[], abc: AbcItem[], html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  lines.push(`${b}Inventory Replenishment Plan (${plans.length} items)${bEnd}`);
  lines.push('');

  // Summary
  const totalAnnualCost = plans.reduce((s, p) => s + p.total_annual_cost, 0);
  const aCount = abc.filter((i) => i.classification === 'A').length;
  const bCount = abc.filter((i) => i.classification === 'B').length;
  const cCount = abc.filter((i) => i.classification === 'C').length;
  lines.push(`${b}Total Annual Cost:${bEnd} $${totalAnnualCost.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  lines.push(`${b}ABC:${bEnd} A=${aCount} | B=${bCount} | C=${cCount}`);
  lines.push('');

  // Per-item details (show ABC class items grouped)
  for (const cls of ['A', 'B', 'C'] as const) {
    const classItems = abc.filter((i) => i.classification === cls);
    if (classItems.length === 0) continue;

    lines.push(`${b}Class ${cls} Items:${bEnd}`);
    for (const item of classItems) {
      const plan = plans.find((p) => p.item_id === item.item_id);
      if (!plan) continue;
      lines.push(`  ${b}${item.item_id}${bEnd} — ${item.description}`);
      lines.push(`    EOQ: ${Math.ceil(plan.eoq)} | ROP: ${Math.ceil(plan.reorder_point)} | SS: ${Math.ceil(plan.safety_stock)}`);
      lines.push(`    Orders/yr: ${plan.orders_per_year.toFixed(1)} | Days between: ${plan.days_between_orders.toFixed(0)}`);
      lines.push(`    Annual cost: $${plan.total_annual_cost.toFixed(2)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
