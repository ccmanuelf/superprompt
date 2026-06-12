/**
 * Job Sequencing — Schedule Evaluation & Gantt Data
 *
 * Pure functions to evaluate schedule quality and generate Gantt chart data.
 * Used by dispatching rules, GA, and MiniZinc bridge.
 */

import type {
  SetupEntry,
  ScheduleEntry,
  ScheduleMetrics,
  GanttData,
  GanttBar,
  SequencerConfig,
} from './models.js';
import { productColor } from './models.js';

// ── Schedule Building ────────────────────────────────────────

/**
 * Build a schedule from a job ordering per machine.
 * machineAssignments: map of machine_id → ordered job IDs
 */
export function buildSchedule(
  machineAssignments: Map<string, string[]>,
  config: SequencerConfig,
): ScheduleEntry[] {
  const jobMap = new Map(config.jobs.map((j) => [j.id, j]));
  const machineMap = new Map(config.machines.map((m) => [m.id, m]));
  const setupMap = buildSetupMap(config.setup_matrix ?? []);
  const horizonStart = 0;

  const entries: ScheduleEntry[] = [];

  for (const [machineId, jobIds] of Array.from(machineAssignments)) {
    const machine = machineMap.get(machineId);
    if (!machine) continue;

    let currentTime = horizonStart;
    let prevProduct = '';
    let position = 0;

    for (const jobId of jobIds) {
      const job = jobMap.get(jobId);
      if (!job) continue;

      position++;
      const efficiency = machine.efficiency ?? 1.0;

      // Wait for job arrival
      const arrivalTime = job.arrival_time ?? 0;
      if (currentTime < arrivalTime) {
        currentTime = arrivalTime;
      }

      // Setup/changeover time
      const setupTime = prevProduct && prevProduct !== job.product
        ? getSetupTime(setupMap, prevProduct, job.product)
        : 0;
      currentTime += setupTime;

      // Processing time (adjusted by machine efficiency)
      const processingTime = efficiency > 0
        ? job.processing_minutes / efficiency
        : job.processing_minutes;

      const startTime = currentTime;
      const endTime = currentTime + processingTime;

      // Due date check
      const dueDateMinutes = job.due_date ? dateToPlanMinutes(job.due_date, config) : undefined;
      const isLate = dueDateMinutes != null ? endTime > dueDateMinutes : false;
      const lateness = dueDateMinutes != null ? Math.max(0, endTime - dueDateMinutes) : 0;

      entries.push({
        job_id: job.id,
        job_name: job.name,
        product: job.product,
        machine_id: machineId,
        machine_name: machine.name,
        start_time: round2(startTime),
        end_time: round2(endTime),
        processing_time: round2(processingTime),
        setup_time: round2(setupTime),
        due_date_minutes: dueDateMinutes,
        is_late: isLate,
        lateness_minutes: round2(lateness),
        sequence_position: position,
      });

      currentTime = endTime;
      prevProduct = job.product;
    }
  }

  return entries;
}

/**
 * Build schedule for single-machine case (all jobs on one machine, or round-robin).
 */
export function buildSingleMachineSchedule(
  orderedJobIds: string[],
  config: SequencerConfig,
): ScheduleEntry[] {
  if (config.machines.length === 1) {
    const assignments = new Map<string, string[]>();
    assignments.set(config.machines[0].id, orderedJobIds);
    return buildSchedule(assignments, config);
  }

  // Multi-machine: respect job.machine_id when set, round-robin the rest
  const jobMap = new Map(config.jobs.map((j) => [j.id, j]));
  const assignments = new Map<string, string[]>();
  for (const m of config.machines) {
    assignments.set(m.id, []);
  }
  const machineIds = config.machines.map((m) => m.id);
  let rrIdx = 0; // round-robin index for unassigned jobs
  for (const jobId of orderedJobIds) {
    const job = jobMap.get(jobId);
    const assignedMachine = job?.machine_id && assignments.has(job.machine_id)
      ? job.machine_id
      : machineIds[rrIdx++ % machineIds.length];
    assignments.get(assignedMachine)!.push(jobId);
  }

  return buildSchedule(assignments, config);
}

/**
 * Build schedule from a flat permutation (used by GA).
 * Permutation is an array of job indices. For multi-machine, assigns round-robin.
 */
export function buildScheduleFromPermutation(
  permutation: number[],
  config: SequencerConfig,
): ScheduleEntry[] {
  const jobIds = permutation.map((i) => config.jobs[i].id);
  return buildSingleMachineSchedule(jobIds, config);
}

// ── Metrics Computation ──────────────────────────────────────

export function computeMetrics(
  entries: ScheduleEntry[],
  _config: SequencerConfig,
): ScheduleMetrics {
  if (entries.length === 0) {
    return {
      makespan: 0, total_flow_time: 0, avg_flow_time: 0,
      total_lateness: 0, max_lateness: 0, num_late_jobs: 0,
      on_time_pct: 100, total_setup_time: 0, avg_utilization_pct: 0,
      total_idle_time: 0,
    };
  }

  const makespan = Math.max(...entries.map((e) => e.end_time));
  const totalFlowTime = entries.reduce((s, e) => s + e.end_time, 0);
  const avgFlowTime = totalFlowTime / entries.length;
  const totalLateness = entries.reduce((s, e) => s + e.lateness_minutes, 0);
  const maxLateness = Math.max(...entries.map((e) => e.lateness_minutes));
  const numLateJobs = entries.filter((e) => e.is_late).length;
  const jobsWithDueDate = entries.filter((e) => e.due_date_minutes != null).length;
  const onTimePct = jobsWithDueDate > 0
    ? ((jobsWithDueDate - numLateJobs) / jobsWithDueDate) * 100
    : 100;
  const totalSetupTime = entries.reduce((s, e) => s + e.setup_time, 0);

  // Machine utilization
  const machineWork = new Map<string, number>();
  const machineSpan = new Map<string, { min: number; max: number }>();
  for (const e of entries) {
    machineWork.set(e.machine_id, (machineWork.get(e.machine_id) ?? 0) + e.processing_time + e.setup_time);
    const span = machineSpan.get(e.machine_id) ?? { min: Infinity, max: 0 };
    span.min = Math.min(span.min, e.start_time - e.setup_time);
    span.max = Math.max(span.max, e.end_time);
    machineSpan.set(e.machine_id, span);
  }

  let totalUtil = 0;
  let totalIdle = 0;
  let machineCount = 0;
  for (const [mId, work] of Array.from(machineWork)) {
    const span = machineSpan.get(mId);
    if (span && span.max > span.min) {
      totalUtil += (work / (span.max - span.min)) * 100;
      totalIdle += (span.max - span.min) - work;
      machineCount++;
    }
  }

  return {
    makespan: round2(makespan),
    total_flow_time: round2(totalFlowTime),
    avg_flow_time: round2(avgFlowTime),
    total_lateness: round2(totalLateness),
    max_lateness: round2(maxLateness),
    num_late_jobs: numLateJobs,
    on_time_pct: round2(onTimePct),
    total_setup_time: round2(totalSetupTime),
    avg_utilization_pct: machineCount > 0 ? round2(totalUtil / machineCount) : 0,
    total_idle_time: round2(totalIdle),
  };
}

// ── Gantt Chart Data ─────────────────────────────────────────

export function buildGanttData(
  entries: ScheduleEntry[],
  config: SequencerConfig,
): GanttData {
  const bars: GanttBar[] = [];
  const machines = config.machines.map((m) => m.name);

  for (const e of entries) {
    // Setup bar (if any)
    if (e.setup_time > 0) {
      bars.push({
        machine_id: e.machine_id,
        machine_name: e.machine_name,
        job_id: e.job_id,
        job_name: `Setup → ${e.product}`,
        product: e.product,
        start: e.start_time - e.setup_time,
        end: e.start_time,
        is_setup: true,
        is_late: false,
        color: '#bab0ac',
      });
    }

    // Processing bar
    bars.push({
      machine_id: e.machine_id,
      machine_name: e.machine_name,
      job_id: e.job_id,
      job_name: e.job_name,
      product: e.product,
      start: e.start_time,
      end: e.end_time,
      is_setup: false,
      is_late: e.is_late,
      color: e.is_late ? '#e15759' : productColor(e.product),
    });
  }

  const horizon = entries.length > 0 ? Math.max(...entries.map((e) => e.end_time)) : 0;

  // Add idle bars between consecutive jobs on the same machine
  for (const machine of config.machines) {
    const machineBars = bars
      .filter((b) => b.machine_id === machine.id && !b.is_setup)
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < machineBars.length - 1; i++) {
      const gapStart = machineBars[i].end;
      const nextBarStart = machineBars[i + 1].start;
      // Check if there's a setup bar filling the gap
      const setupFills = bars.some((b) =>
        b.machine_id === machine.id && b.is_setup && b.start >= gapStart && b.end <= nextBarStart);
      // Only if there's still a gap after accounting for setup
      if (!setupFills && nextBarStart - gapStart > 0.5) {
        bars.push({
          machine_id: machine.id,
          machine_name: machine.name,
          job_id: '',
          job_name: 'Idle',
          product: '',
          start: gapStart,
          end: nextBarStart,
          is_setup: false,
          is_late: false,
          color: '#e0e0e0',
        });
      }
    }
  }

  const dueDateMarkers = entries
    .filter((e) => e.due_date_minutes != null)
    .map((e) => ({ job_id: e.job_id, time: e.due_date_minutes! }));

  return { bars, machines, horizon, due_date_markers: dueDateMarkers };
}

// ── Setup Matrix Utilities ───────────────────────────────────

export function buildSetupMap(
  entries: SetupEntry[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(`${e.from_product}→${e.to_product}`, e.setup_minutes);
  }
  return map;
}

export function getSetupTime(
  setupMap: Map<string, number>,
  fromProduct: string,
  toProduct: string,
): number {
  if (fromProduct === toProduct) return 0;
  return setupMap.get(`${fromProduct}→${toProduct}`) ?? 0;
}

/**
 * Get unique products and build a display matrix.
 */
export function buildSetupMatrix(
  setup: SetupEntry[],
): { products: string[]; matrix: number[][] } {
  const products = Array.from(new Set(setup.flatMap((s) => [s.from_product, s.to_product]))).sort();
  const map = buildSetupMap(setup);
  const matrix = products.map((from) =>
    products.map((to) => from === to ? 0 : (map.get(`${from}→${to}`) ?? 0)),
  );
  return { products, matrix };
}

// ── Due Date Conversion ──────────────────────────────────────

/**
 * Convert ISO date string to minutes from planning start.
 * Uses config.planning_start_date if set, otherwise start-of-today.
 * Days from reference × working hours per day × 60 minutes.
 */
export function dateToPlanMinutes(dateStr: string, config: SequencerConfig): number {
  const hoursPerDay = config.working_hours_per_day ?? 8;
  const ref = config.planning_start_date
    ? new Date(config.planning_start_date)
    : new Date();
  ref.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(17, 0, 0, 0); // Assume end-of-business for due dates
  const diffDays = (due.getTime() - ref.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diffDays * hoursPerDay * 60));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
