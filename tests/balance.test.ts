import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseBalanceCsv,
  parseCsvLine,
  buildSuccessorMap,
  detectCycle,
  calculatePositionalWeights,
  topologicalSort,
  assignStations,
  calculateEfficiency,
  calculateSmoothness,
  buildStationDetails,
  runBalance,
  exportAssignmentsCsv,
  formatBalanceResult,
  formatBalanceComparison,
  generateYamazumiChart,
  generateGanttChart,
  type BalanceTask,
  type StationAssignment,
} from '../src/balance.js';

// ── Test DB setup (raw SQL, same pattern as kanban.test.ts) ──

const TMP_DIR = resolve(tmpdir(), 'luna-test-balance');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'balance-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      takt_time REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balance_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      time_seconds REAL NOT NULL,
      predecessors TEXT NOT NULL DEFAULT '',
      station_requirement TEXT,
      FOREIGN KEY (project_id) REFERENCES balance_projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS balance_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      takt_time REAL NOT NULL,
      efficiency REAL NOT NULL,
      smoothness_index REAL NOT NULL,
      num_stations INTEGER NOT NULL,
      assignments_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES balance_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_balance_tasks_project
      ON balance_tasks(project_id);

    CREATE INDEX IF NOT EXISTS idx_balance_results_project
      ON balance_results(project_id);
  `);
}

function insertProject(name: string, taktTime: number, description = ''): string {
  const id = Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO balance_projects (id, name, description, takt_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, description, taktTime, now, now);
  return id;
}

function insertTask(projectId: string, taskId: string, taskName: string, time: number, preds = '', station?: string): void {
  db.prepare(
    `INSERT INTO balance_tasks (project_id, task_id, task_name, time_seconds, predecessors, station_requirement)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, taskId, taskName, time, preds, station ?? null);
}

function insertResult(projectId: string, taktTime: number, efficiency: number, si: number, stations: number, assignments: unknown[]): string {
  const id = Math.random().toString(36).slice(2, 14);
  db.prepare(
    `INSERT INTO balance_results (id, project_id, takt_time, efficiency, smoothness_index, num_stations, assignments_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, taktTime, efficiency, si, stations, JSON.stringify(assignments), Date.now());
  return id;
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ── Test Data ────────────────────────────────────────────────

const SIMPLE_CSV = `task_id,task_name,time_seconds,predecessors
T1,Attach base plate,45,
T2,Mount motor,30,T1
T3,Wire harness,25,T1
T4,Install cover,20,T2;T3
T5,Final inspection,15,T4`;

const DIAMOND_CSV = `task_id,task_name,time_seconds,predecessors
A,Task A,10,
B,Task B,20,A
C,Task C,15,A
D,Task D,25,B;C`;

const CONSTRAINED_CSV = `task_id,task_name,time_seconds,predecessors,station_requirement
T1,Weld frame,40,,1
T2,Paint frame,30,T1,2
T3,Install electronics,25,,
T4,Final assembly,20,T2;T3,`;

// ── CSV Parsing Tests ────────────────────────────────────────

describe('CSV Parsing', () => {
  it('parses simple CSV line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('handles escaped quotes in quoted fields', () => {
    expect(parseCsvLine('a,"b""c",d')).toEqual(['a', 'b"c', 'd']);
  });

  it('handles empty fields', () => {
    expect(parseCsvLine('a,,c,')).toEqual(['a', '', 'c', '']);
  });

  it('parses balance CSV into tasks', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    expect(tasks).toHaveLength(5);
    expect(tasks[0]).toEqual({
      task_id: 'T1',
      task_name: 'Attach base plate',
      time_seconds: 45,
      predecessors: [],
      station_requirement: undefined,
    });
    expect(tasks[3].predecessors).toEqual(['T2', 'T3']);
  });

  it('parses CSV with station requirements', () => {
    const tasks = parseBalanceCsv(CONSTRAINED_CSV);
    expect(tasks[0].station_requirement).toBe('1');
    expect(tasks[1].station_requirement).toBe('2');
    expect(tasks[2].station_requirement).toBeUndefined();
  });

  it('throws on missing header columns', () => {
    expect(() => parseBalanceCsv('name,duration\nA,10')).toThrow('must have columns');
  });

  it('throws on header-only CSV', () => {
    expect(() => parseBalanceCsv('task_id,task_name,time_seconds,predecessors')).toThrow('at least one data row');
  });

  it('throws on invalid time_seconds', () => {
    const csv = 'task_id,task_name,time_seconds,predecessors\nT1,Test,abc,';
    expect(() => parseBalanceCsv(csv)).toThrow('positive number');
  });

  it('throws on negative time_seconds', () => {
    const csv = 'task_id,task_name,time_seconds,predecessors\nT1,Test,-5,';
    expect(() => parseBalanceCsv(csv)).toThrow('positive number');
  });

  it('uses semicolons or pipes as predecessor separators', () => {
    const csv = 'task_id,task_name,time_seconds,predecessors\nA,A,10,\nB,B,10,\nC,C,10,A;B\nD,D,10,A|B';
    const tasks = parseBalanceCsv(csv);
    expect(tasks[2].predecessors).toEqual(['A', 'B']);
    expect(tasks[3].predecessors).toEqual(['A', 'B']);
  });
});

// ── Successor Map Tests ──────────────────────────────────────

describe('Successor Map', () => {
  it('builds correct successor adjacency list', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const successors = buildSuccessorMap(tasks);
    expect(successors.get('T1')).toEqual(['T2', 'T3']);
    expect(successors.get('T2')).toEqual(['T4']);
    expect(successors.get('T3')).toEqual(['T4']);
    expect(successors.get('T4')).toEqual(['T5']);
    expect(successors.get('T5')).toEqual([]);
  });
});

// ── Cycle Detection Tests ────────────────────────────────────

describe('Cycle Detection', () => {
  it('returns null for acyclic graph', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    expect(detectCycle(tasks)).toBeNull();
  });

  it('detects simple cycle', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: ['B'] },
      { task_id: 'B', task_name: 'B', time_seconds: 10, predecessors: ['A'] },
    ];
    const cycle = detectCycle(tasks);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for complex acyclic graph', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: [] },
      { task_id: 'B', task_name: 'B', time_seconds: 10, predecessors: ['A'] },
      { task_id: 'C', task_name: 'C', time_seconds: 10, predecessors: ['B'] },
      { task_id: 'D', task_name: 'D', time_seconds: 10, predecessors: ['C', 'B'] },
    ];
    expect(detectCycle(tasks)).toBeNull();
  });

  it('throws on unknown predecessor', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: ['UNKNOWN'] },
    ];
    expect(() => detectCycle(tasks)).toThrow('unknown predecessor');
  });
});

// ── Positional Weight Tests ──────────────────────────────────

describe('Positional Weights', () => {
  it('calculates correct weights for linear chain', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: [] },
      { task_id: 'B', task_name: 'B', time_seconds: 20, predecessors: ['A'] },
      { task_id: 'C', task_name: 'C', time_seconds: 30, predecessors: ['B'] },
    ];
    const weights = calculatePositionalWeights(tasks);
    // C: 30 (no successors)
    // B: 20 + 30 = 50
    // A: 10 + 50 = 60
    expect(weights.get('A')).toBe(60);
    expect(weights.get('B')).toBe(50);
    expect(weights.get('C')).toBe(30);
  });

  it('calculates correct weights for diamond dependency', () => {
    const tasks = parseBalanceCsv(DIAMOND_CSV);
    const weights = calculatePositionalWeights(tasks);
    // D: 25
    // B: 20 + 25 = 45
    // C: 15 + 25 = 40
    // A: 10 + 45 + 40 = 95
    expect(weights.get('D')).toBe(25);
    expect(weights.get('B')).toBe(45);
    expect(weights.get('C')).toBe(40);
    expect(weights.get('A')).toBe(95);
  });

  it('calculates weights for the simple assembly line', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const weights = calculatePositionalWeights(tasks);
    // T5: 15
    // T4: 20 + 15 = 35
    // T2: 30 + 35 = 65
    // T3: 25 + 35 = 60
    // T1: 45 + 65 + 60 = 170
    expect(weights.get('T5')).toBe(15);
    expect(weights.get('T4')).toBe(35);
    expect(weights.get('T2')).toBe(65);
    expect(weights.get('T3')).toBe(60);
    expect(weights.get('T1')).toBe(170);
  });
});

// ── Topological Sort Tests ───────────────────────────────────

describe('Topological Sort', () => {
  it('respects precedence constraints', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const ids = sorted.map((t) => t.task_id);

    // T1 must come before T2, T3
    expect(ids.indexOf('T1')).toBeLessThan(ids.indexOf('T2'));
    expect(ids.indexOf('T1')).toBeLessThan(ids.indexOf('T3'));
    // T2, T3 must come before T4
    expect(ids.indexOf('T2')).toBeLessThan(ids.indexOf('T4'));
    expect(ids.indexOf('T3')).toBeLessThan(ids.indexOf('T4'));
    // T4 must come before T5
    expect(ids.indexOf('T4')).toBeLessThan(ids.indexOf('T5'));
  });

  it('sorts by descending PW among available tasks', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const ids = sorted.map((t) => t.task_id);

    // T1 is first (highest PW = 170)
    expect(ids[0]).toBe('T1');
    // After T1, T2 (PW=65) should come before T3 (PW=60)
    expect(ids.indexOf('T2')).toBeLessThan(ids.indexOf('T3'));
  });

  it('handles diamond dependencies', () => {
    const tasks = parseBalanceCsv(DIAMOND_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const ids = sorted.map((t) => t.task_id);

    expect(ids[0]).toBe('A');
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('D'));
    expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('D'));
  });
});

// ── Station Assignment Tests ─────────────────────────────────

describe('Station Assignment', () => {
  it('assigns tasks to stations respecting takt time', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const assignments = assignStations(sorted, 60);

    // Total time = 45+30+25+20+15 = 135
    // With takt=60, need at least ceil(135/60) = 3 stations
    const stations = new Set(assignments.map((a) => a.station));
    expect(stations.size).toBeGreaterThanOrEqual(3);

    // Verify no station exceeds takt time
    const stationTimes = new Map<number, number>();
    for (const a of assignments) {
      stationTimes.set(a.station, (stationTimes.get(a.station) || 0) + a.time_seconds);
    }
    for (const [, time] of stationTimes) {
      expect(time).toBeLessThanOrEqual(60);
    }
  });

  it('respects precedence — predecessors assigned to earlier or same station', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const assignments = assignStations(sorted, 60);

    const stationOf = new Map<string, number>();
    for (const a of assignments) stationOf.set(a.task_id, a.station);

    // T2 depends on T1 → station(T1) <= station(T2)
    expect(stationOf.get('T1')!).toBeLessThanOrEqual(stationOf.get('T2')!);
    // T4 depends on T2 and T3
    expect(stationOf.get('T2')!).toBeLessThanOrEqual(stationOf.get('T4')!);
    expect(stationOf.get('T3')!).toBeLessThanOrEqual(stationOf.get('T4')!);
  });

  it('respects station requirement constraints', () => {
    const tasks = parseBalanceCsv(CONSTRAINED_CSV);
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const assignments = assignStations(sorted, 60);

    const stationOf = new Map<string, number>();
    for (const a of assignments) stationOf.set(a.task_id, a.station);

    // T1 must be in station 1, T2 must be in station 2
    expect(stationOf.get('T1')).toBe(1);
    expect(stationOf.get('T2')).toBe(2);
  });

  it('handles single task', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 30, predecessors: [] },
    ];
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const assignments = assignStations(sorted, 60);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].station).toBe(1);
    expect(assignments[0].start_time).toBe(0);
    expect(assignments[0].end_time).toBe(30);
  });

  it('packs tasks into minimal stations', () => {
    // Two independent tasks that fit in one station
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 20, predecessors: [] },
      { task_id: 'B', task_name: 'B', time_seconds: 20, predecessors: [] },
    ];
    const weights = calculatePositionalWeights(tasks);
    const sorted = topologicalSort(tasks, weights);
    const assignments = assignStations(sorted, 60);

    const stations = new Set(assignments.map((a) => a.station));
    expect(stations.size).toBe(1);
  });
});

// ── Metrics Tests ────────────────────────────────────────────

describe('Metrics', () => {
  it('calculates efficiency correctly', () => {
    // Total task time = 100, 2 stations, takt = 60
    // Efficiency = 100 / (2 * 60) * 100 = 83.33%
    expect(calculateEfficiency(100, 2, 60)).toBeCloseTo(83.33, 1);
  });

  it('calculates efficiency at 100% for perfectly balanced line', () => {
    expect(calculateEfficiency(120, 2, 60)).toBe(100);
  });

  it('handles edge case with zero stations', () => {
    expect(calculateEfficiency(100, 0, 60)).toBe(0);
  });

  it('handles edge case with zero takt time', () => {
    expect(calculateEfficiency(100, 2, 0)).toBe(0);
  });

  it('calculates smoothness index correctly', () => {
    // Stations with times [50, 50, 50] → SI = 0 (perfectly smooth)
    expect(calculateSmoothness([50, 50, 50])).toBe(0);
  });

  it('calculates smoothness for uneven loads', () => {
    // Stations: [60, 40, 20]. Max = 60
    // SI = sqrt(((0)² + (20)² + (40)²) / 3) = sqrt((0 + 400 + 1600)/3) = sqrt(666.67) ≈ 25.82
    const si = calculateSmoothness([60, 40, 20]);
    expect(si).toBeCloseTo(25.82, 1);
  });

  it('smoothness of empty array is 0', () => {
    expect(calculateSmoothness([])).toBe(0);
  });

  it('smoothness of single station is 0', () => {
    expect(calculateSmoothness([42])).toBe(0);
  });
});

// ── Station Details Tests ────────────────────────────────────

describe('Station Details', () => {
  it('builds correct station details from assignments', () => {
    const assignments: StationAssignment[] = [
      { station: 1, task_id: 'A', task_name: 'A', time_seconds: 30, start_time: 0, end_time: 30 },
      { station: 1, task_id: 'B', task_name: 'B', time_seconds: 20, start_time: 30, end_time: 50 },
      { station: 2, task_id: 'C', task_name: 'C', time_seconds: 40, start_time: 0, end_time: 40 },
    ];
    const details = buildStationDetails(assignments, 60);

    expect(details).toHaveLength(2);
    expect(details[0].station).toBe(1);
    expect(details[0].total_time).toBe(50);
    expect(details[0].load_percent).toBeCloseTo(83.33, 1);
    expect(details[0].idle_time).toBe(10);
    expect(details[0].tasks).toEqual(['A', 'B']);

    expect(details[1].station).toBe(2);
    expect(details[1].total_time).toBe(40);
    expect(details[1].load_percent).toBeCloseTo(66.67, 1);
    expect(details[1].idle_time).toBe(20);
  });
});

// ── Full Balance (runBalance) Tests ──────────────────────────

describe('runBalance', () => {
  it('runs the complete RPW algorithm on simple assembly', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Simple Assembly');

    expect(result.project_name).toBe('Simple Assembly');
    expect(result.takt_time).toBe(60);
    expect(result.num_stations).toBeGreaterThanOrEqual(3);
    expect(result.efficiency).toBeGreaterThan(0);
    expect(result.efficiency).toBeLessThanOrEqual(100);
    expect(result.smoothness_index).toBeGreaterThanOrEqual(0);
    expect(result.stations.length).toBe(result.num_stations);
    expect(result.assignments.length).toBe(5);

    // Verify total time is preserved
    const totalAssigned = result.assignments.reduce((s, a) => s + a.time_seconds, 0);
    expect(totalAssigned).toBe(135); // 45+30+25+20+15
  });

  it('runs on diamond dependency graph', () => {
    const tasks = parseBalanceCsv(DIAMOND_CSV);
    const result = runBalance(tasks, 30, 'Diamond');

    // Total time = 10 + 20 + 15 + 25 = 70
    // With takt=30, need at least ceil(70/30) = 3 stations
    expect(result.num_stations).toBeGreaterThanOrEqual(3);

    // Verify all tasks are assigned
    const assignedIds = new Set(result.assignments.map((a) => a.task_id));
    expect(assignedIds).toEqual(new Set(['A', 'B', 'C', 'D']));
  });

  it('runs with station constraints', () => {
    const tasks = parseBalanceCsv(CONSTRAINED_CSV);
    const result = runBalance(tasks, 60, 'Constrained');

    const stationOf = new Map<string, number>();
    for (const a of result.assignments) stationOf.set(a.task_id, a.station);

    expect(stationOf.get('T1')).toBe(1);
    expect(stationOf.get('T2')).toBe(2);
  });

  it('throws when takt time is less than longest task', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    // Longest task is T1 at 45s, takt=30 is too short
    expect(() => runBalance(tasks, 30, 'Fail')).toThrow('Takt time');
  });

  it('throws when no tasks provided', () => {
    expect(() => runBalance([], 60, 'Empty')).toThrow('No tasks');
  });

  it('throws when takt time is zero', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: [] },
    ];
    expect(() => runBalance(tasks, 0, 'Zero')).toThrow('positive');
  });

  it('throws on circular dependencies', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: ['C'] },
      { task_id: 'B', task_name: 'B', time_seconds: 10, predecessors: ['A'] },
      { task_id: 'C', task_name: 'C', time_seconds: 10, predecessors: ['B'] },
    ];
    expect(() => runBalance(tasks, 60, 'Cyclic')).toThrow('Circular');
  });

  it('handles large task count efficiently', () => {
    // 50 tasks in a linear chain
    const tasks: BalanceTask[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push({
        task_id: `T${i}`,
        task_name: `Task ${i}`,
        time_seconds: 10,
        predecessors: i > 0 ? [`T${i - 1}`] : [],
      });
    }
    const result = runBalance(tasks, 60, 'LargeChain');
    expect(result.assignments).toHaveLength(50);
    expect(result.num_stations).toBeGreaterThanOrEqual(9); // 500/60 ≈ 8.33
  });

  it('handles many independent tasks', () => {
    const tasks: BalanceTask[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push({
        task_id: `T${i}`,
        task_name: `Task ${i}`,
        time_seconds: 10,
        predecessors: [],
      });
    }
    const result = runBalance(tasks, 60, 'Independent');
    // 20 tasks × 10s = 200s, takt=60 → min 4 stations (200/60 = 3.33)
    expect(result.num_stations).toBeLessThanOrEqual(4);
    expect(result.efficiency).toBeGreaterThan(80);
  });
});

// ── CSV Export Tests ─────────────────────────────────────────

describe('CSV Export', () => {
  it('exports assignments with correct columns', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Export Test');
    const csv = exportAssignmentsCsv(result);

    const lines = csv.split('\n');
    expect(lines[0]).toBe('station,task_id,task_name,time_seconds,start_time,end_time');
    expect(lines.length).toBeGreaterThan(6); // header + 5 data rows + summary
  });

  it('includes summary metrics', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Export Test');
    const csv = exportAssignmentsCsv(result);

    expect(csv).toContain('# Takt Time,60');
    expect(csv).toContain('# Efficiency');
    expect(csv).toContain('# Smoothness Index');
  });

  it('properly escapes task names with commas', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'Weld, paint, and finish', time_seconds: 30, predecessors: [] },
    ];
    const result = runBalance(tasks, 60, 'Escape Test');
    const csv = exportAssignmentsCsv(result);
    expect(csv).toContain('"Weld, paint, and finish"');
  });
});

// ── Formatting Tests ─────────────────────────────────────────

describe('Formatting', () => {
  it('formats balance result as HTML', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Format Test');
    const html = formatBalanceResult(result, true);

    expect(html).toContain('<b>Line Balance: Format Test</b>');
    expect(html).toContain('<b>Takt Time:</b> 60s');
    expect(html).toContain('<b>Efficiency:</b>');
    expect(html).toContain('Station 1');
  });

  it('formats balance result as plain text', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Format Test');
    const text = formatBalanceResult(result, false);

    expect(text).not.toContain('<b>');
    expect(text).toContain('Line Balance: Format Test');
    expect(text).toContain('Efficiency:');
  });

  it('shows overload warning when stations exceed takt time', () => {
    const tasks = parseBalanceCsv(CONSTRAINED_CSV);
    // T1 (40s, station 1) + T3 (25s, no constraint) — T3 fits in station 1 (40+25=65 > 60 → no)
    // Use tight takt to force overloading with constraints
    const overloadCsv = `task_id,task_name,time_seconds,predecessors,station_requirement
X1,Task A,30,,1
X2,Task B,25,X1,1
X3,Task C,20,X2,`;
    const overTasks = parseBalanceCsv(overloadCsv);
    // takt=40, station 1 gets X1(30) + X2(25) = 55 > 40 → overloaded
    const result = runBalance(overTasks, 40, 'Overload Test');
    const text = formatBalanceResult(result, false);

    expect(text).toContain('OVERLOADED');
    expect(text).toContain('WARNING');
    expect(text).toContain('exceed');
  });

  it('no overload warning when all stations within takt', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Normal Test');
    const text = formatBalanceResult(result, false);

    expect(text).not.toContain('OVERLOADED');
    expect(text).not.toContain('WARNING');
  });

  it('formats comparison of multiple results', () => {
    const results = [
      { id: 'abc123456789', project_id: 'p1', takt_time: 60, efficiency: 85.5, smoothness_index: 5.2, num_stations: 3, assignments_json: '[]', created_at: Date.now() - 1000 },
      { id: 'def987654321', project_id: 'p1', takt_time: 50, efficiency: 90.1, smoothness_index: 3.8, num_stations: 4, assignments_json: '[]', created_at: Date.now() },
    ];
    const text = formatBalanceComparison(results, false);
    expect(text).toContain('Balance Comparison (2 runs)');
    expect(text).toContain('abc12345');
    expect(text).toContain('85.5%');
    expect(text).toContain('90.1%');
  });
});

// ── Database Schema Tests (raw SQL, real DB) ─────────────────

describe('Database Schema (real DB)', () => {
  it('creates project with correct fields', () => {
    const id = insertProject('Test Line', 60, 'A test line');
    const row = db.prepare('SELECT * FROM balance_projects WHERE id = ?').get(id) as any;
    expect(row.name).toBe('Test Line');
    expect(row.takt_time).toBe(60);
    expect(row.description).toBe('A test line');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('finds project by name case-insensitively', () => {
    insertProject('My Assembly', 45);
    const row = db.prepare('SELECT * FROM balance_projects WHERE name = ? COLLATE NOCASE').get('my assembly') as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('My Assembly');
  });

  it('stores and retrieves tasks with predecessors', () => {
    const pid = insertProject('TaskTest', 60);
    insertTask(pid, 'T1', 'Task 1', 30);
    insertTask(pid, 'T2', 'Task 2', 20, 'T1');
    insertTask(pid, 'T3', 'Task 3', 25, 'T1;T2');

    const tasks = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ? ORDER BY task_id').all(pid) as any[];
    expect(tasks).toHaveLength(3);
    expect(tasks[0].predecessors).toBe('');
    expect(tasks[1].predecessors).toBe('T1');
    expect(tasks[2].predecessors).toBe('T1;T2');
  });

  it('stores station requirement constraint', () => {
    const pid = insertProject('Constrained', 60);
    insertTask(pid, 'T1', 'Weld', 40, '', '1');
    insertTask(pid, 'T2', 'Paint', 30, 'T1', '2');

    const tasks = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ? ORDER BY task_id').all(pid) as any[];
    expect(tasks[0].station_requirement).toBe('1');
    expect(tasks[1].station_requirement).toBe('2');
  });

  it('enforces unique task_id per project', () => {
    const pid = insertProject('DupTest', 60);
    insertTask(pid, 'T1', 'Task 1', 30);
    expect(() => insertTask(pid, 'T1', 'Duplicate', 20)).toThrow();
  });

  it('allows same task_id in different projects', () => {
    const pid1 = insertProject('Project 1', 60);
    const pid2 = insertProject('Project 2', 45);
    insertTask(pid1, 'T1', 'Task in P1', 30);
    insertTask(pid2, 'T1', 'Task in P2', 25);

    const tasks1 = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ?').all(pid1) as any[];
    const tasks2 = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ?').all(pid2) as any[];
    expect(tasks1).toHaveLength(1);
    expect(tasks2).toHaveLength(1);
  });

  it('stores and retrieves balance results with assignments JSON', () => {
    const pid = insertProject('ResultTest', 60);
    const assignments = [
      { station: 1, task_id: 'T1', task_name: 'A', time_seconds: 30, start_time: 0, end_time: 30 },
      { station: 2, task_id: 'T2', task_name: 'B', time_seconds: 25, start_time: 0, end_time: 25 },
    ];
    const rid = insertResult(pid, 60, 87.5, 2.5, 2, assignments);

    const row = db.prepare('SELECT * FROM balance_results WHERE id = ?').get(rid) as any;
    expect(row.efficiency).toBe(87.5);
    expect(row.smoothness_index).toBe(2.5);
    expect(row.num_stations).toBe(2);

    const parsed = JSON.parse(row.assignments_json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].task_id).toBe('T1');
  });

  it('cascades delete from project to tasks and results', () => {
    const pid = insertProject('Cascade', 60);
    insertTask(pid, 'T1', 'Task 1', 30);
    insertResult(pid, 60, 85, 3, 2, []);

    db.prepare('DELETE FROM balance_projects WHERE id = ?').run(pid);

    const tasks = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ?').all(pid);
    const results = db.prepare('SELECT * FROM balance_results WHERE project_id = ?').all(pid);
    expect(tasks).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it('lists projects ordered by updated_at descending', () => {
    const id1 = insertProject('First', 60);
    // Update timestamp to ensure ordering
    db.prepare('UPDATE balance_projects SET updated_at = ? WHERE id = ?').run(Date.now() - 10000, id1);
    insertProject('Second', 45);

    const projects = db.prepare('SELECT * FROM balance_projects ORDER BY updated_at DESC').all() as any[];
    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe('Second');
    expect(projects[1].name).toBe('First');
  });

  it('stores multiple result runs per project', () => {
    const pid = insertProject('MultiRun', 60);
    insertResult(pid, 60, 80, 5, 3, []);
    insertResult(pid, 50, 85, 4, 4, []);
    insertResult(pid, 70, 90, 2, 2, []);

    const results = db.prepare('SELECT * FROM balance_results WHERE project_id = ? ORDER BY created_at DESC').all(pid) as any[];
    expect(results).toHaveLength(3);
  });
});

// ── Integration: End-to-End Algorithm + DB ───────────────────

describe('End-to-End Integration', () => {
  it('full pipeline: CSV parse → RPW balance → persist → retrieve → format', () => {
    // 1. Parse CSV
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    expect(tasks).toHaveLength(5);

    // 2. Run balance algorithm
    const result = runBalance(tasks, 60, 'E2E Test');
    expect(result.num_stations).toBeGreaterThanOrEqual(3);
    expect(result.efficiency).toBeGreaterThan(0);

    // 3. Persist to DB
    const pid = insertProject('E2E Test', 60);
    for (const t of tasks) {
      insertTask(pid, t.task_id, t.task_name, t.time_seconds, t.predecessors.join(';'), t.station_requirement);
    }
    insertResult(pid, 60, result.efficiency, result.smoothness_index, result.num_stations, result.assignments);

    // 4. Retrieve and verify
    const dbTasks = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ?').all(pid) as any[];
    expect(dbTasks).toHaveLength(5);

    const dbResults = db.prepare('SELECT * FROM balance_results WHERE project_id = ?').all(pid) as any[];
    expect(dbResults).toHaveLength(1);
    expect(dbResults[0].efficiency).toBe(result.efficiency);

    const dbAssignments = JSON.parse(dbResults[0].assignments_json) as StationAssignment[];
    expect(dbAssignments).toHaveLength(5);
    const allIds = new Set(dbAssignments.map((a) => a.task_id));
    expect(allIds).toEqual(new Set(['T1', 'T2', 'T3', 'T4', 'T5']));

    // 5. Format output
    const formatted = formatBalanceResult(result, true);
    expect(formatted).toContain('E2E Test');
    expect(formatted).toContain('Efficiency:');

    // 6. CSV export round-trip
    const csv = exportAssignmentsCsv(result);
    expect(csv).toContain('station,task_id');
    expect(csv).toContain('# Takt Time,60');
  });

  it('compare scenarios: takt=60 vs takt=90', () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);

    const result60 = runBalance(tasks, 60, 'Scenario A');
    const result90 = runBalance(tasks, 90, 'Scenario B');

    // Higher takt → fewer stations
    expect(result90.num_stations).toBeLessThanOrEqual(result60.num_stations);

    // Persist both
    const pid = insertProject('Compare', 60);
    for (const t of tasks) insertTask(pid, t.task_id, t.task_name, t.time_seconds, t.predecessors.join(';'));
    insertResult(pid, 60, result60.efficiency, result60.smoothness_index, result60.num_stations, result60.assignments);
    insertResult(pid, 90, result90.efficiency, result90.smoothness_index, result90.num_stations, result90.assignments);

    const results = db.prepare('SELECT * FROM balance_results WHERE project_id = ?').all(pid) as any[];
    expect(results).toHaveLength(2);

    // Format comparison
    const comparison = formatBalanceComparison(results, false);
    expect(comparison).toContain('Balance Comparison (2 runs)');
  });
});

// ── Real-World Manufacturing Scenarios ───────────────────────

describe('Real-World Scenarios', () => {
  it('automotive wiring harness assembly (15 tasks, real precedences)', () => {
    const csv = `task_id,task_name,time_seconds,predecessors
W1,Cut wires,20,
W2,Strip ends,15,W1
W3,Crimp terminals,25,W2
W4,Insert terminals A,18,W3
W5,Insert terminals B,22,W3
W6,Route harness,30,W4;W5
W7,Tape wrap section A,12,W6
W8,Tape wrap section B,14,W6
W9,Install connectors,20,W7;W8
W10,Continuity test,15,W9
W11,Apply labels,8,W10
W12,Bundle and tie,10,W11
W13,Visual inspection,12,W12
W14,Package,10,W13
W15,Final sign-off,5,W14`;

    const tasks = parseBalanceCsv(csv);
    expect(tasks).toHaveLength(15);

    const result = runBalance(tasks, 50, 'Wiring Harness');

    // Total time = 236s, takt=50 → min 5 stations
    expect(result.num_stations).toBeGreaterThanOrEqual(5);
    expect(result.efficiency).toBeGreaterThan(70);
    expect(result.assignments).toHaveLength(15);

    const assignedIds = new Set(result.assignments.map((a) => a.task_id));
    expect(assignedIds.size).toBe(15);
  });

  it('PCB assembly with zone constraints', () => {
    const csv = `task_id,task_name,time_seconds,predecessors,station_requirement
P1,Apply solder paste,30,,1
P2,Place SMD components,25,P1,1
P3,Reflow solder,35,P2,2
P4,Place through-hole parts,20,P3,
P5,Wave solder,30,P4,3
P6,Clean board,15,P5,
P7,Inspect solder joints,20,P6,
P8,Functional test,25,P7,`;

    const tasks = parseBalanceCsv(csv);
    const result = runBalance(tasks, 45, 'PCB Assembly');

    const stationOf = new Map<string, number>();
    for (const a of result.assignments) stationOf.set(a.task_id, a.station);

    expect(stationOf.get('P1')).toBe(1);
    expect(stationOf.get('P2')).toBe(1);
    expect(stationOf.get('P3')).toBe(2);
    expect(stationOf.get('P5')).toBe(3);
  });

  it('perfectly balanced line achieves 100% efficiency', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 30, predecessors: [] },
      { task_id: 'B', task_name: 'B', time_seconds: 30, predecessors: [] },
      { task_id: 'C', task_name: 'C', time_seconds: 30, predecessors: [] },
      { task_id: 'D', task_name: 'D', time_seconds: 30, predecessors: [] },
    ];
    const result = runBalance(tasks, 30, 'Perfect');
    expect(result.efficiency).toBe(100);
    expect(result.smoothness_index).toBe(0);
    expect(result.num_stations).toBe(4);
  });

  it('single-station assembly fits all tasks', () => {
    const tasks: BalanceTask[] = [
      { task_id: 'A', task_name: 'A', time_seconds: 10, predecessors: [] },
      { task_id: 'B', task_name: 'B', time_seconds: 15, predecessors: ['A'] },
      { task_id: 'C', task_name: 'C', time_seconds: 20, predecessors: ['B'] },
    ];
    const result = runBalance(tasks, 60, 'SingleStation');
    expect(result.num_stations).toBe(1);
    expect(result.efficiency).toBe(75); // 45/60*100
    expect(result.stations[0].idle_time).toBe(15);
  });

  it('wide parallel graph with convergence', () => {
    // 8 independent branches merging into a final task
    const tasks: BalanceTask[] = [];
    for (let i = 0; i < 8; i++) {
      tasks.push({ task_id: `B${i}`, task_name: `Branch ${i}`, time_seconds: 15, predecessors: [] });
    }
    tasks.push({ task_id: 'MERGE', task_name: 'Merge', time_seconds: 10, predecessors: tasks.map((t) => t.task_id) });

    const result = runBalance(tasks, 30, 'Wide Parallel');
    // 8×15 + 10 = 130s total. With takt=30, at least 5 stations (130/30=4.33)
    expect(result.num_stations).toBeGreaterThanOrEqual(5);
    expect(result.assignments).toHaveLength(9);

    // MERGE must be in the last station (all branches before it)
    const mergeStation = result.assignments.find((a) => a.task_id === 'MERGE')!.station;
    for (const a of result.assignments) {
      if (a.task_id !== 'MERGE') {
        expect(a.station).toBeLessThanOrEqual(mergeStation);
      }
    }
  });
});

// ── Chart Generation Tests ───────────────────────────────────

describe('Chart Generation', () => {
  it('generates yamazumi chart PNG from simple balance', async () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Yamazumi Test');

    const filePath = await generateYamazumiChart(result);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain('yamazumi');

    // Verify it's a valid PNG (starts with PNG magic bytes)
    const buffer = readFileSync(filePath);
    expect(buffer.length).toBeGreaterThan(1000); // non-trivial image
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50); // P
    expect(buffer[2]).toBe(0x4E); // N
    expect(buffer[3]).toBe(0x47); // G

    // Cleanup
    rmSync(filePath);
  });

  it('generates yamazumi chart for constrained balance', async () => {
    const tasks = parseBalanceCsv(CONSTRAINED_CSV);
    const result = runBalance(tasks, 60, 'Constrained Yamazumi');

    const filePath = await generateYamazumiChart(result);
    expect(existsSync(filePath)).toBe(true);

    const buffer = readFileSync(filePath);
    expect(buffer.length).toBeGreaterThan(1000);

    rmSync(filePath);
  });

  it('generates yamazumi chart with many stations', async () => {
    // 15-task wiring harness → multiple stations
    const csv = `task_id,task_name,time_seconds,predecessors
W1,Cut wires,20,
W2,Strip ends,15,W1
W3,Crimp terminals,25,W2
W4,Insert terminals A,18,W3
W5,Insert terminals B,22,W3
W6,Route harness,30,W4;W5
W7,Tape wrap A,12,W6
W8,Tape wrap B,14,W6
W9,Install connectors,20,W7;W8
W10,Continuity test,15,W9
W11,Apply labels,8,W10
W12,Bundle and tie,10,W11
W13,Visual inspection,12,W12
W14,Package,10,W13
W15,Final sign-off,5,W14`;

    const tasks = parseBalanceCsv(csv);
    const result = runBalance(tasks, 50, 'Many Stations');

    const filePath = await generateYamazumiChart(result);
    expect(existsSync(filePath)).toBe(true);

    const buffer = readFileSync(filePath);
    expect(buffer.length).toBeGreaterThan(1000);

    rmSync(filePath);
  });

  it('generates Gantt chart PNG', async () => {
    const tasks = parseBalanceCsv(SIMPLE_CSV);
    const result = runBalance(tasks, 60, 'Gantt Test');

    const filePath = await generateGanttChart(result);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain('gantt');

    const buffer = readFileSync(filePath);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x89); // PNG magic

    rmSync(filePath);
  });

  it('generates both charts from same result', async () => {
    const tasks = parseBalanceCsv(DIAMOND_CSV);
    const result = runBalance(tasks, 30, 'Both Charts');

    const yamazumiPath = await generateYamazumiChart(result);
    const ganttPath = await generateGanttChart(result);

    expect(existsSync(yamazumiPath)).toBe(true);
    expect(existsSync(ganttPath)).toBe(true);
    expect(yamazumiPath).not.toBe(ganttPath);

    rmSync(yamazumiPath);
    rmSync(ganttPath);
  });
});
