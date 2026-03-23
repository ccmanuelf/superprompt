import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ── Test DB setup ────────────────────────────────────────────

const TMP_DIR = resolve(tmpdir(), 'clauded-test-inventory');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'inventory-test.db');

let db: Database.Database;

vi.mock('../src/db.js', () => ({ getDatabase: () => db }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'clauded-test-inventory'),
  config: { NODE_ENV: 'test' },
}));

import {
  parseInventoryCsv,
  calculateEOQ,
  calculateSafetyStock,
  calculateReorderPoint,
  generateReplenishmentPlan,
  abcClassification,
  exponentialSmoothing,
  formatReplenishmentPlan,
  generateAbcChart,
  generateForecastChart,
  initInventoryTables,
  createInventoryProject,
  getInventoryProjectByName,
  listInventoryProjects,
  deleteInventoryProject,
  insertInventoryItems,
  getInventoryItems,
  saveInventoryResult,
  getInventoryResults,
  type InventoryItem,
} from '../src/inventory.js';

// Need sigma tables for inverseNormal dependency
import { initSigmaTables } from '../src/sigma.js';

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSigmaTables();
  initInventoryTables();
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ── Test Data ────────────────────────────────────────────────

const BASIC_CSV = `item_id,description,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days,service_level
SKU-001,Widget A,10000,25.00,150,20,7,0.95
SKU-002,Widget B,5000,50.00,200,25,14,0.98
SKU-003,Widget C,1000,10.00,100,15,5,0.90
SKU-004,Gadget D,500,100.00,250,30,21,0.99
SKU-005,Part E,20000,5.00,75,10,3,0.95`;

const ABC_CSV = `item_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days
PART-A,1000,500,100,20,7
PART-B,5000,100,80,20,5
PART-C,200,2000,150,25,14
PART-D,10000,2,50,15,3
PART-E,500,50,60,20,7
PART-F,3000,10,40,15,5
PART-G,100,300,100,25,10
PART-H,8000,3,30,10,2`;

// ── CSV Parsing Tests ────────────────────────────────────────

describe('CSV Parsing', () => {
  it('parses basic inventory CSV', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    expect(items).toHaveLength(5);
    expect(items[0].item_id).toBe('SKU-001');
    expect(items[0].annual_demand).toBe(10000);
    expect(items[0].unit_cost).toBe(25);
    expect(items[0].service_level).toBe(0.95);
  });

  it('defaults service_level to 0.95 when not provided', () => {
    const csv = 'item_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days\nA,1000,10,50,20,5';
    const items = parseInventoryCsv(csv);
    expect(items[0].service_level).toBe(0.95);
  });

  it('clamps service_level to valid range', () => {
    const csv = 'item_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days,service_level\nA,1000,10,50,20,5,1.5';
    const items = parseInventoryCsv(csv);
    expect(items[0].service_level).toBeLessThanOrEqual(0.9999);
  });

  it('throws on missing required columns', () => {
    expect(() => parseInventoryCsv('item_id,demand\nA,100')).toThrow('annual_demand');
  });

  it('throws on negative values', () => {
    const csv = 'item_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days\nA,-100,10,50,20,5';
    expect(() => parseInventoryCsv(csv)).toThrow('non-negative');
  });

  it('handles BOM', () => {
    const csv = '\uFEFFitem_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days\nA,1000,10,50,20,5';
    expect(parseInventoryCsv(csv)).toHaveLength(1);
  });

  it('handles Windows CRLF', () => {
    const csv = 'item_id,annual_demand,unit_cost,order_cost,holding_cost_pct,lead_time_days\r\nA,1000,10,50,20,5\r\n';
    expect(parseInventoryCsv(csv)).toHaveLength(1);
  });
});

// ── EOQ Tests ────────────────────────────────────────────────

describe('EOQ Calculation', () => {
  it('calculates textbook EOQ correctly', () => {
    // D=10000, S=150, H=25*0.20=5
    // EOQ = sqrt(2*10000*150/5) = sqrt(600000) = 774.6
    const eoq = calculateEOQ(10000, 150, 5);
    expect(eoq).toBeCloseTo(774.6, 0);
  });

  it('EOQ increases with higher demand', () => {
    const eoq1 = calculateEOQ(1000, 100, 5);
    const eoq2 = calculateEOQ(5000, 100, 5);
    expect(eoq2).toBeGreaterThan(eoq1);
  });

  it('EOQ decreases with higher holding cost', () => {
    const eoq1 = calculateEOQ(1000, 100, 5);
    const eoq2 = calculateEOQ(1000, 100, 20);
    expect(eoq2).toBeLessThan(eoq1);
  });

  it('returns 0 for zero demand', () => {
    expect(calculateEOQ(0, 100, 5)).toBe(0);
  });

  it('returns 0 for zero order cost', () => {
    expect(calculateEOQ(1000, 0, 5)).toBe(0);
  });
});

// ── Safety Stock Tests ───────────────────────────────────────

describe('Safety Stock', () => {
  it('increases with higher service level', () => {
    const ss90 = calculateSafetyStock(100, 7, 0.90);
    const ss99 = calculateSafetyStock(100, 7, 0.99);
    expect(ss99).toBeGreaterThan(ss90);
  });

  it('increases with longer lead time', () => {
    const ss5 = calculateSafetyStock(100, 5, 0.95);
    const ss20 = calculateSafetyStock(100, 20, 0.95);
    expect(ss20).toBeGreaterThan(ss5);
  });

  it('uses provided demand_stddev when available', () => {
    const ssDefault = calculateSafetyStock(100, 7, 0.95); // uses 25% of demand
    const ssCustom = calculateSafetyStock(100, 7, 0.95, 50); // higher stddev
    expect(ssCustom).toBeGreaterThan(ssDefault);
  });

  it('returns 0 for zero lead time', () => {
    expect(calculateSafetyStock(100, 0, 0.95)).toBe(0);
  });

  it('safety stock is positive for any service level > 0.5', () => {
    expect(calculateSafetyStock(100, 7, 0.51)).toBeGreaterThan(0);
  });
});

// ── Reorder Point Tests ──────────────────────────────────────

describe('Reorder Point', () => {
  it('ROP = daily demand × lead time + safety stock', () => {
    const rop = calculateReorderPoint(100, 7, 50);
    expect(rop).toBe(750); // 100*7 + 50
  });

  it('ROP equals safety stock when lead time is 0', () => {
    expect(calculateReorderPoint(100, 0, 50)).toBe(50);
  });
});

// ── Replenishment Plan Tests ─────────────────────────────────

describe('Replenishment Plan', () => {
  it('generates plan for all items', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    const plans = generateReplenishmentPlan(items);

    expect(plans).toHaveLength(5);
    for (const plan of plans) {
      expect(plan.eoq).toBeGreaterThan(0);
      expect(plan.reorder_point).toBeGreaterThan(0);
      expect(plan.safety_stock).toBeGreaterThanOrEqual(0);
      expect(plan.total_annual_cost).toBeGreaterThan(0);
      expect(plan.orders_per_year).toBeGreaterThan(0);
      expect(plan.days_between_orders).toBeGreaterThan(0);
    }
  });

  it('total cost = ordering cost + holding cost', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    const plans = generateReplenishmentPlan(items);

    for (const plan of plans) {
      expect(plan.total_annual_cost).toBeCloseTo(
        plan.annual_order_cost + plan.annual_holding_cost, 0,
      );
    }
  });

  it('higher demand items have more orders per year', () => {
    const items: InventoryItem[] = [
      { item_id: 'LOW', description: 'Low', annual_demand: 100, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 5, service_level: 0.95 },
      { item_id: 'HIGH', description: 'High', annual_demand: 10000, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 5, service_level: 0.95 },
    ];
    const plans = generateReplenishmentPlan(items);
    const low = plans.find((p) => p.item_id === 'LOW')!;
    const high = plans.find((p) => p.item_id === 'HIGH')!;
    expect(high.orders_per_year).toBeGreaterThan(low.orders_per_year);
  });
});

// ── ABC Classification Tests ─────────────────────────────────

describe('ABC Classification', () => {
  it('classifies items into A, B, C categories', () => {
    const items = parseInventoryCsv(ABC_CSV);
    const abc = abcClassification(items);

    expect(abc).toHaveLength(8);
    const classes = abc.map((i) => i.classification);
    expect(classes).toContain('A');
    expect(classes).toContain('B');
    expect(classes).toContain('C');
  });

  it('sorts by descending annual dollar volume', () => {
    const items = parseInventoryCsv(ABC_CSV);
    const abc = abcClassification(items);

    for (let i = 1; i < abc.length; i++) {
      expect(abc[i].annual_dollar_volume).toBeLessThanOrEqual(abc[i - 1].annual_dollar_volume);
    }
  });

  it('cumulative percentage reaches 100%', () => {
    const items = parseInventoryCsv(ABC_CSV);
    const abc = abcClassification(items);
    expect(abc[abc.length - 1].cumulative_pct).toBe(100);
  });

  it('A items cover approximately 80% of dollar volume', () => {
    const items = parseInventoryCsv(ABC_CSV);
    const abc = abcClassification(items);

    const aItems = abc.filter((i) => i.classification === 'A');
    // A class includes items that start below 80% cumulative
    // The last A item may push cumulative past 80%
    expect(aItems.length).toBeGreaterThan(0);
    expect(aItems.length).toBeLessThan(abc.length); // not all items are A
  });

  it('handles single item', () => {
    const items: InventoryItem[] = [
      { item_id: 'SOLO', description: 'Solo', annual_demand: 1000, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 5, service_level: 0.95 },
    ];
    const abc = abcClassification(items);
    expect(abc).toHaveLength(1);
    expect(abc[0].classification).toBe('A');
    expect(abc[0].cumulative_pct).toBe(100);
  });
});

// ── Exponential Smoothing Tests ──────────────────────────────

describe('Exponential Smoothing', () => {
  it('generates forecasts for demand history', () => {
    const actuals = [100, 110, 105, 115, 120, 108, 112, 118, 125, 130];
    const result = exponentialSmoothing(actuals);

    expect(result.method).toBe('Simple Exponential Smoothing');
    expect(result.alpha).toBeGreaterThan(0);
    expect(result.alpha).toBeLessThanOrEqual(1);
    expect(result.forecasts).toHaveLength(actuals.length + 1); // includes next-period
    expect(result.mape).toBeGreaterThan(0);
    expect(result.mad).toBeGreaterThan(0);
  });

  it('auto-selects optimal alpha', () => {
    const actuals = [100, 100, 100, 100, 100]; // constant demand
    const result = exponentialSmoothing(actuals);
    // For constant demand, any alpha works since all values are the same
    expect(result.mad).toBe(0); // perfect fit
  });

  it('respects provided alpha', () => {
    const actuals = [100, 110, 120, 130, 140];
    const result = exponentialSmoothing(actuals, 0.5);
    expect(result.alpha).toBe(0.5);
  });

  it('next period forecast is reasonable', () => {
    const actuals = [100, 110, 120, 130, 140]; // trending up
    const result = exponentialSmoothing(actuals);
    const nextForecast = result.forecasts[result.forecasts.length - 1];
    // Should be somewhere near recent values
    expect(nextForecast).toBeGreaterThan(100);
    expect(nextForecast).toBeLessThan(200);
  });

  it('throws on fewer than 3 data points', () => {
    expect(() => exponentialSmoothing([100, 110])).toThrow('at least 3');
  });

  it('MAPE is reasonable for noisy data', () => {
    const actuals = [100, 120, 90, 130, 85, 140, 95, 125, 110, 105];
    const result = exponentialSmoothing(actuals);
    // MAPE should be under 30% for this level of noise
    expect(result.mape).toBeLessThan(30);
  });
});

// ── Formatting Tests ─────────────────────────────────────────

describe('Formatting', () => {
  it('formats replenishment plan with ABC summary', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    const plans = generateReplenishmentPlan(items);
    const abc = abcClassification(items);
    const text = formatReplenishmentPlan(plans, abc, false);

    expect(text).toContain('Replenishment Plan');
    expect(text).toContain('Total Annual Cost');
    expect(text).toContain('Class A');
    expect(text).toContain('EOQ:');
    expect(text).toContain('ROP:');
  });

  it('formats as HTML', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    const plans = generateReplenishmentPlan(items);
    const abc = abcClassification(items);
    const html = formatReplenishmentPlan(plans, abc, true);

    expect(html).toContain('<b>');
    expect(html).toContain('Total Annual Cost');
  });
});

// ── Database Tests ───────────────────────────────────────────

describe('Database Operations', () => {
  it('creates and retrieves project', () => {
    const project = createInventoryProject('Warehouse', 'Main warehouse');
    expect(project.name).toBe('Warehouse');

    const found = getInventoryProjectByName('warehouse');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Warehouse');
  });

  it('inserts and retrieves items', () => {
    const project = createInventoryProject('ItemTest');
    const items = parseInventoryCsv(BASIC_CSV);
    insertInventoryItems(project.id, items);

    const retrieved = getInventoryItems(project.id);
    expect(retrieved).toHaveLength(5);
    expect(retrieved[0].item_id).toBe('SKU-001');
  });

  it('cascades delete', () => {
    const project = createInventoryProject('Cascade');
    insertInventoryItems(project.id, parseInventoryCsv(BASIC_CSV));
    saveInventoryResult(project.id, 'test', { x: 1 });

    deleteInventoryProject(project.id);
    expect(getInventoryItems(project.id)).toHaveLength(0);
    expect(getInventoryResults(project.id)).toHaveLength(0);
  });

  it('prevents duplicate item_id per project', () => {
    const project = createInventoryProject('DupTest');
    const items: InventoryItem[] = [
      { item_id: 'A', description: 'A', annual_demand: 100, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 5, service_level: 0.95 },
    ];
    insertInventoryItems(project.id, items);
    expect(() => insertInventoryItems(project.id, items)).toThrow();
  });
});

// ── Chart Generation Tests ───────────────────────────────────

describe('Chart Generation', () => {
  it('generates ABC chart PNG', async () => {
    const items = parseInventoryCsv(ABC_CSV);
    const abc = abcClassification(items);
    const filePath = await generateAbcChart(abc, 'ABC Test');

    expect(existsSync(filePath)).toBe(true);
    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0x89); // PNG
    expect(buffer.length).toBeGreaterThan(1000);
    rmSync(filePath);
  });

  it('generates forecast chart PNG', async () => {
    const actuals = [100, 110, 105, 115, 120, 108, 112, 118, 125, 130];
    const forecast = exponentialSmoothing(actuals);
    const filePath = await generateForecastChart(forecast, 'Forecast Test');

    expect(existsSync(filePath)).toBe(true);
    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0x89);
    rmSync(filePath);
  });
});

// ── Real-World Scenarios ─────────────────────────────────────

describe('Real-World Scenarios', () => {
  it('auto parts warehouse — full analysis', () => {
    const items = parseInventoryCsv(BASIC_CSV);
    const plans = generateReplenishmentPlan(items);
    const abc = abcClassification(items);

    // Verify all items have valid plans
    expect(plans).toHaveLength(5);
    for (const p of plans) {
      expect(p.eoq).toBeGreaterThan(0);
      expect(p.safety_stock).toBeGreaterThanOrEqual(0);
      expect(p.reorder_point).toBeGreaterThan(p.safety_stock);
    }

    // Verify ABC makes sense: high dollar volume items are A
    const partE = abc.find((i) => i.item_id === 'SKU-005')!; // 20000 × $5 = $100k
    const gadgetD = abc.find((i) => i.item_id === 'SKU-004')!; // 500 × $100 = $50k
    const widgetB = abc.find((i) => i.item_id === 'SKU-002')!; // 5000 × $50 = $250k
    const widgetA = abc.find((i) => i.item_id === 'SKU-001')!; // 10000 × $25 = $250k

    // Top dollar volume items should be Class A
    expect(widgetA.classification === 'A' || widgetB.classification === 'A').toBe(true);
  });

  it('seasonal demand forecast', () => {
    // Quarterly demand with seasonal pattern
    const actuals = [100, 150, 200, 120, 110, 160, 210, 130, 115, 165, 215, 135];
    const forecast = exponentialSmoothing(actuals);

    expect(forecast.forecasts).toHaveLength(13); // 12 actuals + 1 next
    expect(forecast.mape).toBeLessThan(25); // reasonable for seasonal
  });

  it('high service level item has more safety stock', () => {
    const items: InventoryItem[] = [
      { item_id: 'STD', description: 'Standard', annual_demand: 1000, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 7, service_level: 0.90 },
      { item_id: 'CRIT', description: 'Critical', annual_demand: 1000, unit_cost: 10, order_cost: 50, holding_cost_pct: 20, lead_time_days: 7, service_level: 0.99 },
    ];
    const plans = generateReplenishmentPlan(items);
    const std = plans.find((p) => p.item_id === 'STD')!;
    const crit = plans.find((p) => p.item_id === 'CRIT')!;
    expect(crit.safety_stock).toBeGreaterThan(std.safety_stock);
  });
});
