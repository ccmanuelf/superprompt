import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDatabase } from './db.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// ── Types ────────────────────────────────────────────────────

export interface BalanceTask {
  task_id: string;
  task_name: string;
  time_seconds: number;
  predecessors: string[];
  station_requirement?: string;
}

export interface StationAssignment {
  station: number;
  task_id: string;
  task_name: string;
  time_seconds: number;
  start_time: number;
  end_time: number;
}

export interface BalanceResult {
  project_id: string;
  project_name: string;
  takt_time: number;
  num_stations: number;
  efficiency: number;
  smoothness_index: number;
  stations: StationDetail[];
  assignments: StationAssignment[];
}

export interface StationDetail {
  station: number;
  tasks: string[];
  total_time: number;
  load_percent: number;
  idle_time: number;
}

export interface BalanceProject {
  id: string;
  name: string;
  description: string;
  takt_time: number;
  created_at: number;
  updated_at: number;
}

export interface BalanceResultRow {
  id: string;
  project_id: string;
  takt_time: number;
  efficiency: number;
  smoothness_index: number;
  num_stations: number;
  assignments_json: string;
  created_at: number;
}

// ── Database ─────────────────────────────────────────────────

export function initBalanceTables(): void {
  const db = getDatabase();

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

function genId(): string {
  return randomBytes(16).toString('hex');
}

export function createProject(name: string, description: string, taktTime: number): BalanceProject {
  const db = getDatabase();
  const id = genId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO balance_projects (id, name, description, takt_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, description, taktTime, now, now);
  return { id, name, description, takt_time: taktTime, created_at: now, updated_at: now };
}

export function getProject(id: string): BalanceProject | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM balance_projects WHERE id = ?').get(id) as BalanceProject | undefined;
}

export function getProjectByName(name: string): BalanceProject | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM balance_projects WHERE name = ? COLLATE NOCASE').get(name) as BalanceProject | undefined;
}

export function listProjects(): BalanceProject[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM balance_projects ORDER BY updated_at DESC').all() as BalanceProject[];
}

export function deleteProject(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM balance_projects WHERE id = ?').run(id);
  return result.changes > 0;
}

export function insertTasks(projectId: string, tasks: BalanceTask[]): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO balance_tasks (project_id, task_id, task_name, time_seconds, predecessors, station_requirement)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const transaction = db.transaction(() => {
    for (const t of tasks) {
      stmt.run(projectId, t.task_id, t.task_name, t.time_seconds, t.predecessors.join(','), t.station_requirement ?? null);
    }
  });
  transaction();
}

export function getProjectTasks(projectId: string): BalanceTask[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM balance_tasks WHERE project_id = ?').all(projectId) as Array<{
    task_id: string;
    task_name: string;
    time_seconds: number;
    predecessors: string;
    station_requirement: string | null;
  }>;

  return rows.map((r) => ({
    task_id: r.task_id,
    task_name: r.task_name,
    time_seconds: r.time_seconds,
    predecessors: r.predecessors ? r.predecessors.split(',').filter(Boolean) : [],
    station_requirement: r.station_requirement ?? undefined,
  }));
}

export function saveResult(result: BalanceResult): string {
  const db = getDatabase();
  const id = genId();
  db.prepare(
    `INSERT INTO balance_results (id, project_id, takt_time, efficiency, smoothness_index, num_stations, assignments_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, result.project_id, result.takt_time, result.efficiency, result.smoothness_index, result.num_stations, JSON.stringify(result.assignments), Date.now());

  db.prepare('UPDATE balance_projects SET updated_at = ? WHERE id = ?').run(Date.now(), result.project_id);
  return id;
}

export function getResultsForProject(projectId: string): BalanceResultRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM balance_results WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as BalanceResultRow[];
}

export function getResult(id: string): BalanceResultRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM balance_results WHERE id = ?').get(id) as BalanceResultRow | undefined;
}

// ── CSV Parsing ──────────────────────────────────────────────

/**
 * Parse balance CSV content into BalanceTask[].
 * Expected columns: task_id, task_name, time_seconds, predecessors[, station_requirement]
 * Exported for testing.
 */
export function parseBalanceCsv(csvContent: string): BalanceTask[] {
  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const idxTaskId = header.indexOf('task_id');
  const idxTaskName = header.indexOf('task_name');
  const idxTime = header.indexOf('time_seconds');
  const idxPred = header.indexOf('predecessors');
  const idxStation = header.indexOf('station_requirement');

  if (idxTaskId < 0 || idxTaskName < 0 || idxTime < 0) {
    throw new Error('CSV must have columns: task_id, task_name, time_seconds. Found: ' + header.join(', '));
  }

  const tasks: BalanceTask[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    const taskId = cols[idxTaskId]?.trim();
    const taskName = cols[idxTaskName]?.trim();
    const timeStr = cols[idxTime]?.trim();

    if (!taskId || !taskName || !timeStr) {
      throw new Error(`Row ${i + 1}: missing required fields (task_id, task_name, time_seconds).`);
    }

    const timeSeconds = parseFloat(timeStr);
    if (isNaN(timeSeconds) || timeSeconds <= 0) {
      throw new Error(`Row ${i + 1}: time_seconds must be a positive number, got "${timeStr}".`);
    }

    const predecessors = idxPred >= 0 && cols[idxPred]
      ? cols[idxPred].split(/[;|]/).map((p) => p.trim()).filter(Boolean)
      : [];

    const stationReq = idxStation >= 0 ? cols[idxStation]?.trim() || undefined : undefined;

    tasks.push({ task_id: taskId, task_name: taskName, time_seconds: timeSeconds, predecessors, station_requirement: stationReq });
  }

  if (tasks.length === 0) throw new Error('CSV contains no data rows.');
  return tasks;
}

/** Parse a single CSV line handling quoted fields. Exported for testing. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ── RPW Algorithm ────────────────────────────────────────────

/**
 * Build adjacency lists (successors) from task precedence data.
 * Exported for testing.
 */
export function buildSuccessorMap(tasks: BalanceTask[]): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const t of tasks) {
    if (!successors.has(t.task_id)) successors.set(t.task_id, []);
  }
  for (const t of tasks) {
    for (const pred of t.predecessors) {
      const succs = successors.get(pred);
      if (succs) succs.push(t.task_id);
    }
  }
  return successors;
}

/**
 * Detect circular dependencies in the task graph.
 * Returns the cycle path if found, null otherwise.
 * Exported for testing.
 */
export function detectCycle(tasks: BalanceTask[]): string[] | null {
  const successors = buildSuccessorMap(tasks);
  const taskIds = new Set(tasks.map((t) => t.task_id));

  // Check for predecessors referencing non-existent tasks
  for (const t of tasks) {
    for (const pred of t.predecessors) {
      if (!taskIds.has(pred)) {
        throw new Error(`Task "${t.task_id}" references unknown predecessor "${pred}".`);
      }
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const succ of successors.get(node) || []) {
      if (inStack.has(succ)) {
        const cycleStart = path.indexOf(succ);
        return path.slice(cycleStart).concat(succ);
      }
      if (!visited.has(succ)) {
        const cycle = dfs(succ);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const t of tasks) {
    if (!visited.has(t.task_id)) {
      const cycle = dfs(t.task_id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Calculate Ranked Positional Weight for each task.
 * PW(i) = time(i) + sum(PW(j) for all successors j of i)
 * Exported for testing.
 */
export function calculatePositionalWeights(tasks: BalanceTask[]): Map<string, number> {
  const timeMap = new Map<string, number>();
  for (const t of tasks) timeMap.set(t.task_id, t.time_seconds);

  const successors = buildSuccessorMap(tasks);
  const weights = new Map<string, number>();
  const computing = new Set<string>();

  function computeWeight(taskId: string): number {
    if (weights.has(taskId)) return weights.get(taskId)!;
    if (computing.has(taskId)) return 0; // should not happen if no cycles

    computing.add(taskId);
    const ownTime = timeMap.get(taskId) || 0;
    let succWeight = 0;
    for (const succ of successors.get(taskId) || []) {
      succWeight += computeWeight(succ);
    }

    const pw = ownTime + succWeight;
    weights.set(taskId, pw);
    computing.delete(taskId);
    return pw;
  }

  for (const t of tasks) computeWeight(t.task_id);
  return weights;
}

/**
 * Topological sort respecting precedence, ordered by descending positional weight.
 * Exported for testing.
 */
export function topologicalSort(tasks: BalanceTask[], weights: Map<string, number>): BalanceTask[] {
  const taskMap = new Map<string, BalanceTask>();
  for (const t of tasks) taskMap.set(t.task_id, t);

  // In-degree = number of predecessors (edges pointing into a task)
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    inDegree.set(t.task_id, t.predecessors.length);
  }

  // Available tasks: those with in-degree 0
  const available: BalanceTask[] = [];
  for (const t of tasks) {
    if (inDegree.get(t.task_id) === 0) available.push(t);
  }
  // Sort available by descending PW
  available.sort((a, b) => (weights.get(b.task_id) || 0) - (weights.get(a.task_id) || 0));

  const successors = buildSuccessorMap(tasks);
  const sorted: BalanceTask[] = [];

  while (available.length > 0) {
    const task = available.shift()!;
    sorted.push(task);

    for (const succId of successors.get(task.task_id) || []) {
      const deg = (inDegree.get(succId) || 0) - 1;
      inDegree.set(succId, deg);
      if (deg === 0) {
        available.push(taskMap.get(succId)!);
        // Re-sort to maintain PW order
        available.sort((a, b) => (weights.get(b.task_id) || 0) - (weights.get(a.task_id) || 0));
      }
    }
  }

  if (sorted.length !== tasks.length) {
    throw new Error('Topological sort failed — likely circular dependency exists.');
  }

  return sorted;
}

/**
 * Greedy station assignment using RPW-sorted tasks.
 * Assigns highest-weight unassigned task that fits remaining station time.
 * Respects station_requirement constraints.
 * Exported for testing.
 */
export function assignStations(
  sortedTasks: BalanceTask[],
  taktTime: number,
): StationAssignment[] {
  const assignments: StationAssignment[] = [];
  const stationTimes: number[] = []; // cumulative time per station
  const stationTaskSets: Set<string>[] = []; // tasks assigned per station
  const assignedStation = new Map<string, number>(); // task_id -> station number

  for (const task of sortedTasks) {
    let bestStation = -1;

    // Check station requirement constraint
    if (task.station_requirement) {
      const requiredStation = parseInt(task.station_requirement, 10);
      if (!isNaN(requiredStation) && requiredStation > 0) {
        // Ensure station exists
        while (stationTimes.length < requiredStation) {
          stationTimes.push(0);
          stationTaskSets.push(new Set());
        }
        const stationIdx = requiredStation - 1;
        if (stationTimes[stationIdx] + task.time_seconds <= taktTime) {
          // Check predecessors are assigned to earlier or same station
          if (predecessorsSatisfied(task, assignedStation, requiredStation)) {
            bestStation = stationIdx;
          }
        }
        // If required station can't fit, we still assign there (constraint takes priority)
        if (bestStation < 0) {
          if (predecessorsSatisfied(task, assignedStation, requiredStation)) {
            bestStation = stationIdx;
          }
        }
      }
    }

    if (bestStation < 0) {
      // Try to fit in existing stations
      for (let s = 0; s < stationTimes.length; s++) {
        if (stationTimes[s] + task.time_seconds <= taktTime) {
          if (predecessorsSatisfied(task, assignedStation, s + 1)) {
            bestStation = s;
            break;
          }
        }
      }
    }

    if (bestStation < 0) {
      // Open new station
      bestStation = stationTimes.length;
      stationTimes.push(0);
      stationTaskSets.push(new Set());
    }

    const startTime = stationTimes[bestStation];
    stationTimes[bestStation] += task.time_seconds;
    stationTaskSets[bestStation].add(task.task_id);
    assignedStation.set(task.task_id, bestStation + 1);

    assignments.push({
      station: bestStation + 1,
      task_id: task.task_id,
      task_name: task.task_name,
      time_seconds: task.time_seconds,
      start_time: startTime,
      end_time: startTime + task.time_seconds,
    });
  }

  return assignments;
}

function predecessorsSatisfied(
  task: BalanceTask,
  assignedStation: Map<string, number>,
  targetStation: number,
): boolean {
  for (const pred of task.predecessors) {
    const predStation = assignedStation.get(pred);
    if (predStation === undefined) return false; // predecessor not yet assigned
    if (predStation > targetStation) return false; // predecessor in later station
  }
  return true;
}

/**
 * Calculate balance efficiency.
 * efficiency = (sum of all task times) / (num_stations × takt_time) × 100
 * Exported for testing.
 */
export function calculateEfficiency(
  totalTaskTime: number,
  numStations: number,
  taktTime: number,
): number {
  if (numStations === 0 || taktTime === 0) return 0;
  return (totalTaskTime / (numStations * taktTime)) * 100;
}

/**
 * Calculate smoothness index (line balancing uniformity).
 * SI = sqrt(sum((max_station_time - station_time_i)²) / num_stations)
 * Lower is better.
 * Exported for testing.
 */
export function calculateSmoothness(stationTimes: number[]): number {
  if (stationTimes.length === 0) return 0;
  const maxTime = Math.max(...stationTimes);
  let sumSqDiff = 0;
  for (const t of stationTimes) {
    sumSqDiff += (maxTime - t) ** 2;
  }
  return Math.sqrt(sumSqDiff / stationTimes.length);
}

/**
 * Build station details from assignments.
 * Exported for testing.
 */
export function buildStationDetails(
  assignments: StationAssignment[],
  taktTime: number,
): StationDetail[] {
  const stationMap = new Map<number, StationAssignment[]>();
  for (const a of assignments) {
    if (!stationMap.has(a.station)) stationMap.set(a.station, []);
    stationMap.get(a.station)!.push(a);
  }

  const details: StationDetail[] = [];
  for (const [station, tasks] of stationMap) {
    const totalTime = tasks.reduce((sum, t) => sum + t.time_seconds, 0);
    details.push({
      station,
      tasks: tasks.map((t) => t.task_id),
      total_time: totalTime,
      load_percent: taktTime > 0 ? (totalTime / taktTime) * 100 : 0,
      idle_time: Math.max(0, taktTime - totalTime),
    });
  }

  details.sort((a, b) => a.station - b.station);
  return details;
}

// ── Main Balance Execution ───────────────────────────────────

/**
 * Run the full RPW line balance algorithm.
 * Validates inputs, computes weights, sorts, assigns, and returns results.
 * Exported for testing.
 */
export function runBalance(tasks: BalanceTask[], taktTime: number, projectName: string): BalanceResult {
  // Validate
  if (tasks.length === 0) throw new Error('No tasks provided.');
  if (taktTime <= 0) throw new Error('Takt time must be positive.');

  const maxTaskTime = Math.max(...tasks.map((t) => t.time_seconds));
  if (maxTaskTime > taktTime) {
    throw new Error(
      `Takt time (${taktTime}s) is less than the longest task "${tasks.find((t) => t.time_seconds === maxTaskTime)!.task_id}" (${maxTaskTime}s). ` +
      `Cannot balance — increase takt time or split the task.`,
    );
  }

  // Check for cycles
  const cycle = detectCycle(tasks);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
  }

  // Calculate positional weights
  const weights = calculatePositionalWeights(tasks);

  // Topological sort by descending PW
  const sorted = topologicalSort(tasks, weights);

  // Greedy station assignment
  const assignments = assignStations(sorted, taktTime);

  // Build station details
  const stations = buildStationDetails(assignments, taktTime);

  // Calculate metrics
  const totalTaskTime = tasks.reduce((sum, t) => sum + t.time_seconds, 0);
  const numStations = stations.length;
  const efficiency = calculateEfficiency(totalTaskTime, numStations, taktTime);
  const stationTimes = stations.map((s) => s.total_time);
  const smoothnessIndex = calculateSmoothness(stationTimes);

  return {
    project_id: '', // set by caller after DB insert
    project_name: projectName,
    takt_time: taktTime,
    num_stations: numStations,
    efficiency: Math.round(efficiency * 100) / 100,
    smoothness_index: Math.round(smoothnessIndex * 100) / 100,
    stations,
    assignments,
  };
}

// ── Full Pipeline (CSV → DB → Result) ────────────────────────

/**
 * Execute the full balance pipeline: parse CSV, create project, run algorithm, save results.
 */
export function executeBalance(
  csvContent: string,
  taktTime: number,
  projectName: string,
  description: string = '',
): BalanceResult {
  const tasks = parseBalanceCsv(csvContent);
  const result = runBalance(tasks, taktTime, projectName);

  // Reuse existing project or create new one
  let project = getProjectByName(projectName);
  if (project) {
    // Update takt time and clear old tasks for fresh run
    const db = getDatabase();
    db.prepare('DELETE FROM balance_tasks WHERE project_id = ?').run(project.id);
    db.prepare('UPDATE balance_projects SET takt_time = ?, updated_at = ? WHERE id = ?')
      .run(taktTime, Date.now(), project.id);
    project.takt_time = taktTime;
  } else {
    project = createProject(projectName, description, taktTime);
  }

  insertTasks(project.id, tasks);
  result.project_id = project.id;
  saveResult(result);

  logger.info(
    { projectName, numTasks: tasks.length, numStations: result.num_stations, efficiency: result.efficiency },
    'Line balance completed',
  );

  return result;
}

// ── Shared Chart Palette ──────────────────────────────────────

const CHART_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#8cd17d', '#b6992d', '#499894', '#e49444',
  '#d37295', '#a0cbe8', '#ffbe7d', '#8b8b8b', '#79706e',
];

// ── Yamazumi Chart Generation ─────────────────────────────────

/**
 * Generate a yamazumi (stacked bar) chart PNG for line balance visualization.
 * Each bar is a station, stacked segments are tasks with labels, takt time reference line.
 * This is the standard manufacturing visualization for line balancing results.
 * Returns the file path of the generated PNG.
 * Exported for testing.
 */
export async function generateYamazumiChart(result: BalanceResult): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const width = Math.max(600, result.num_stations * 120 + 200);
  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height: 520,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  const stationLabels = result.stations.map((s) => `Station ${s.station} (${s.load_percent.toFixed(0)}%)`);

  // Group assignments by station
  const stationAssignments = new Map<number, StationAssignment[]>();
  for (const a of result.assignments) {
    if (!stationAssignments.has(a.station)) stationAssignments.set(a.station, []);
    stationAssignments.get(a.station)!.push(a);
  }

  // Build a global task→color map for consistent colors across charts
  const taskColorMap = new Map<string, string>();
  const uniqueTasks = [...new Set(result.assignments.map((a) => a.task_id))];
  for (let i = 0; i < uniqueTasks.length; i++) {
    taskColorMap.set(uniqueTasks[i], CHART_PALETTE[i % CHART_PALETTE.length]);
  }

  // Build a task→label map for data labels
  const taskLabelMap = new Map<string, string>();
  for (const a of result.assignments) {
    taskLabelMap.set(a.task_id, `${a.task_id} (${a.time_seconds}s)`);
  }

  // One dataset per layer (task slot within a station), stacked vertically
  let maxTasksPerStation = 0;
  for (const [, tasks] of stationAssignments) {
    maxTasksPerStation = Math.max(maxTasksPerStation, tasks.length);
  }

  // Build layer-to-taskId mapping for datalabels
  const layerTaskIds: string[][] = []; // [layer][stationIndex] = taskId or ''

  const datasets: Array<Record<string, unknown>> = [];

  for (let layer = 0; layer < maxTasksPerStation; layer++) {
    const data: number[] = [];
    const colors: string[] = [];
    const taskIds: string[] = [];

    for (const s of result.stations) {
      const tasks = stationAssignments.get(s.station) || [];
      if (layer < tasks.length) {
        const task = tasks[layer];
        data.push(task.time_seconds);
        colors.push(taskColorMap.get(task.task_id) || CHART_PALETTE[0]);
        taskIds.push(task.task_id);
      } else {
        data.push(0);
        colors.push('transparent');
        taskIds.push('');
      }
    }

    layerTaskIds.push(taskIds);

    datasets.push({
      label: `Layer ${layer + 1}`,
      data,
      backgroundColor: colors,
      barPercentage: 0.7,
      categoryPercentage: 0.85,
      datalabels: {
        display: (ctx: { dataIndex: number }) => {
          const tid = taskIds[ctx.dataIndex];
          return tid !== '';
        },
        formatter: (_value: number, ctx: { dataIndex: number }) => {
          const tid = taskIds[ctx.dataIndex];
          return taskLabelMap.get(tid) || '';
        },
        color: 'white',
        font: { size: 11, weight: 'bold' as const },
        anchor: 'center' as const,
        align: 'center' as const,
        textStrokeColor: 'rgba(0,0,0,0.5)',
        textStrokeWidth: 2,
      },
    });
  }

  // Force takt time to appear as a Y-axis tick so grid callback highlights it
  const yMax = Math.ceil(result.takt_time * 1.2);
  const stepSize = result.takt_time > 100 ? 20 : result.takt_time > 50 ? 10 : 5;

  const config = {
    type: 'bar' as const,
    data: {
      labels: stationLabels,
      datasets,
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: [
            `Yamazumi Chart: ${result.project_name}`,
            `Efficiency: ${result.efficiency.toFixed(1)}% | Smoothness: ${result.smoothness_index.toFixed(2)} | Stations: ${result.num_stations}`,
          ],
          font: { size: 14 },
          padding: { bottom: 15 },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
        },
        y: {
          stacked: true,
          title: { display: true, text: 'Time (seconds)' },
          min: 0,
          max: yMax,
          ticks: {
            stepSize,
            callback: (value: number) =>
              value === result.takt_time ? `← ${value}s (Takt)` : `${value}`,
          },
          afterBuildTicks: (axis: { ticks: Array<{ value: number }> }) => {
            // Inject takt time as a tick if not already present
            const hasTakt = axis.ticks.some((t) => t.value === result.takt_time);
            if (!hasTakt) {
              axis.ticks.push({ value: result.takt_time });
              axis.ticks.sort((a, b) => a.value - b.value);
            }
          },
          grid: {
            color: (ctx: { tick: { value: number } }) =>
              ctx.tick.value === result.takt_time ? '#e15759' : '#e5e5e5',
            lineWidth: (ctx: { tick: { value: number } }) =>
              ctx.tick.value === result.takt_time ? 3 : 1,
          },
        },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `balance-yamazumi-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);

  return filePath;
}

// ── Gantt Chart Generation ───────────────────────────────────

/**
 * Generate a Gantt chart PNG showing task-to-station timeline.
 * Uses floating horizontal bars (non-stacked) to show [start, end] per task per station.
 * Returns the file path of the generated PNG.
 * Exported for testing.
 */
export async function generateGanttChart(result: BalanceResult): Promise<string> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
  const ChartDataLabels = (await import('chartjs-plugin-datalabels')).default;

  const height = Math.max(250, result.num_stations * 70 + 120);
  const chartCanvas = new ChartJSNodeCanvas({
    width: 900,
    height,
    backgroundColour: 'white',
    plugins: { modern: [ChartDataLabels] },
  });

  // Build global task→color map
  const taskColorMap = new Map<string, string>();
  const uniqueTasks = [...new Set(result.assignments.map((a) => a.task_id))];
  for (let i = 0; i < uniqueTasks.length; i++) {
    taskColorMap.set(uniqueTasks[i], CHART_PALETTE[i % CHART_PALETTE.length]);
  }

  const stationLabels = result.stations.map((s) => `Station ${s.station}`);

  // X-axis max: accommodate overloaded stations (constraint may push past takt)
  const maxStationTime = Math.max(...result.stations.map((s) => s.total_time));
  const xMax = Math.max(result.takt_time, maxStationTime) * 1.05;

  // One dataset per task — each with a floating [start, end] on its station row only
  const datasets: Array<Record<string, unknown>> = [];

  for (const taskId of uniqueTasks) {
    const assignment = result.assignments.find((a) => a.task_id === taskId)!;
    // Floating bar data: [start, end] on the correct station, null on others
    const data: Array<[number, number] | null> = result.stations.map((s) =>
      s.station === assignment.station
        ? [assignment.start_time, assignment.end_time]
        : null,
    );

    datasets.push({
      label: `${taskId}: ${assignment.task_name}`,
      data,
      backgroundColor: taskColorMap.get(taskId),
      barPercentage: 0.75,
      categoryPercentage: 0.9,
      skipNull: true,
      datalabels: {
        display: (ctx: { dataIndex: number }) => data[ctx.dataIndex] !== null,
        formatter: () => `${taskId} (${assignment.time_seconds}s)`,
        color: 'white',
        font: { size: 10, weight: 'bold' as const },
        anchor: 'center' as const,
        align: 'center' as const,
        textStrokeColor: 'rgba(0,0,0,0.4)',
        textStrokeWidth: 1,
      },
    });
  }

  const config = {
    type: 'bar' as const,
    data: {
      labels: stationLabels,
      datasets,
    },
    options: {
      indexAxis: 'y' as const,
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Gantt Chart: ${result.project_name} (Efficiency: ${result.efficiency.toFixed(1)}%)`,
          font: { size: 14 },
        },
        legend: {
          position: 'bottom' as const,
          labels: { font: { size: 9 }, boxWidth: 12 },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Time (seconds)' },
          min: 0,
          max: xMax,
          stacked: false, // Absolute positioning for floating [start, end] bars
          afterBuildTicks: (axis: { ticks: Array<{ value: number }> }) => {
            const hasTakt = axis.ticks.some((t) => t.value === result.takt_time);
            if (!hasTakt) {
              axis.ticks.push({ value: result.takt_time });
              axis.ticks.sort((a, b) => a.value - b.value);
            }
          },
          ticks: {
            callback: (value: number) =>
              value === result.takt_time ? `${value} (Takt)` : `${value}`,
          },
          grid: {
            color: (ctx: { tick: { value: number } }) =>
              ctx.tick.value === result.takt_time ? '#e15759' : '#e5e5e5',
            lineWidth: (ctx: { tick: { value: number } }) =>
              ctx.tick.value === result.takt_time ? 3 : 1,
          },
        },
        y: {
          stacked: true, // Share row space — bars overlap on same station row
        },
      },
    },
  };

  const buffer = Buffer.from(
    await chartCanvas.renderToBuffer(config as unknown as import('chart.js').ChartConfiguration),
  );

  const filename = `balance-gantt-${Date.now()}.png`;
  const filePath = resolve(STORE_DIR, filename);
  writeFileSync(filePath, buffer);

  return filePath;
}

// ── CSV Export ────────────────────────────────────────────────

/**
 * Export balance assignments to CSV string.
 * Exported for testing.
 */
export function exportAssignmentsCsv(result: BalanceResult): string {
  const lines: string[] = [
    'station,task_id,task_name,time_seconds,start_time,end_time',
  ];

  for (const a of result.assignments) {
    lines.push(
      `${a.station},${csvEscape(a.task_id)},${csvEscape(a.task_name)},${a.time_seconds},${a.start_time},${a.end_time}`,
    );
  }

  // Summary rows
  lines.push('');
  lines.push('# Summary');
  lines.push(`# Takt Time,${result.takt_time}`);
  lines.push(`# Stations,${result.num_stations}`);
  lines.push(`# Efficiency,${result.efficiency}%`);
  lines.push(`# Smoothness Index,${result.smoothness_index}`);

  for (const s of result.stations) {
    lines.push(`# Station ${s.station},Load: ${s.load_percent.toFixed(1)}%,Idle: ${s.idle_time.toFixed(1)}s`);
  }

  return lines.join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format balance result for display (Telegram HTML or plain text).
 * Exported for testing.
 */
export function formatBalanceResult(result: BalanceResult, html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';
  const code = html ? '<code>' : '';
  const codeEnd = html ? '</code>' : '';

  const lines: string[] = [];
  lines.push(`${b}Line Balance: ${result.project_name}${bEnd}`);
  lines.push('');
  lines.push(`${b}Takt Time:${bEnd} ${result.takt_time}s`);
  lines.push(`${b}Stations:${bEnd} ${result.num_stations}`);
  lines.push(`${b}Efficiency:${bEnd} ${result.efficiency.toFixed(1)}%`);
  lines.push(`${b}Smoothness Index:${bEnd} ${result.smoothness_index.toFixed(2)}`);
  lines.push('');

  const overloaded: string[] = [];

  for (const s of result.stations) {
    const filled = Math.min(Math.round(s.load_percent / 5), 20);
    const bar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(Math.max(0, 20 - filled));
    const overloadFlag = s.load_percent > 100 ? ' OVERLOADED' : '';
    lines.push(`${b}Station ${s.station}${bEnd} ${code}${bar}${emptyBar}${codeEnd} ${s.load_percent.toFixed(1)}%${overloadFlag}`);
    lines.push(`  Tasks: ${s.tasks.join(', ')}`);
    lines.push(`  Time: ${s.total_time.toFixed(1)}s / ${result.takt_time}s (idle: ${s.idle_time.toFixed(1)}s)`);

    if (s.load_percent > 100) {
      overloaded.push(`Station ${s.station} (${s.load_percent.toFixed(0)}%)`);
    }
  }

  if (overloaded.length > 0) {
    lines.push('');
    lines.push(`WARNING: ${overloaded.join(', ')} exceed${overloaded.length === 1 ? 's' : ''} takt time.`);
    lines.push('Consider increasing takt time, splitting tasks, or relaxing station constraints.');
  }

  return lines.join('\n');
}

/**
 * Format a comparison of multiple balance results.
 */
export function formatBalanceComparison(results: BalanceResultRow[], html: boolean = true): string {
  const b = html ? '<b>' : '';
  const bEnd = html ? '</b>' : '';

  const lines: string[] = [];
  lines.push(`${b}Balance Comparison (${results.length} runs)${bEnd}`);
  lines.push('');

  for (const r of results) {
    const date = new Date(r.created_at).toLocaleString();
    lines.push(`${b}Run${bEnd} ${r.id.slice(0, 8)} — ${date}`);
    lines.push(`  Takt: ${r.takt_time}s | Stations: ${r.num_stations} | Efficiency: ${r.efficiency.toFixed(1)}% | SI: ${r.smoothness_index.toFixed(2)}`);
  }

  return lines.join('\n');
}
