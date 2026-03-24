/**
 * Production Line Simulation v3.0 — Discrete-Event Engine
 *
 * Ported from kpi-operations SimPy V2 (engine.py).
 * Replaces SimPy with a lightweight TypeScript DES framework:
 * - SimEnvironment: priority-queue event loop with time-advance
 * - SimResource: capacity-limited resource with FIFO wait queue
 * - ProductionLineSimulator: the core simulation class
 *
 * This module is stateless with no database dependencies.
 */

import {
  type SimulationConfig,
  type OperationInput,
  type SimulationMetrics,
  applyOperationDefaults,
  getDailyPlannedHours,
  createEmptyMetrics,
} from './models.js';

import {
  SMALL_BUNDLE_THRESHOLD,
  SMALL_BUNDLE_TRANSITION_SECONDS,
  LARGE_BUNDLE_TRANSITION_SECONDS,
  MIN_PROCESS_TIME_MINUTES,
  WIP_SAMPLE_INTERVAL_MINUTES,
  TRIANGULAR_VARIABILITY_MIN,
  TRIANGULAR_VARIABILITY_MAX,
  TRIANGULAR_VARIABILITY_MODE,
  DEFAULT_BREAKDOWN_DELAY_MINUTES,
  DEFAULT_BREAK_PATTERN,
} from './constants.js';

// ── Seeded Random Number Generator ───────────────────────────

/**
 * Mulberry32 PRNG — deterministic, seedable, fast.
 * Produces uniform [0,1) values.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Returns uniform random in [0, 1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Triangular distribution with given min, mode, max */
  triangular(min: number, mode: number, max: number): number {
    const u = this.next();
    const fc = (mode - min) / (max - min);
    if (u < fc) {
      return min + Math.sqrt(u * (max - min) * (mode - min));
    }
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

// ── Discrete-Event Simulation Primitives ─────────────────────

interface ScheduledEvent {
  time: number;
  id: number;
  resolve: () => void;
}

/**
 * Minimal discrete-event simulation environment.
 * Replaces SimPy's Environment with a priority queue approach.
 */
export class SimEnvironment {
  private eventQueue: ScheduledEvent[] = [];
  private eventId = 0;
  private _now = 0;

  get now(): number {
    return this._now;
  }

  /**
   * Schedule a timeout (advance time by `delay` minutes).
   * Returns a Promise that resolves when the event fires.
   */
  timeout(delay: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const event: ScheduledEvent = {
        time: this._now + delay,
        id: this.eventId++,
        resolve,
      };
      this.insertEvent(event);
    });
  }

  /** Insert event maintaining sorted order (min-heap by time, then id) */
  private insertEvent(event: ScheduledEvent): void {
    // Binary search for insertion point
    let lo = 0;
    let hi = this.eventQueue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this.eventQueue[mid];
      if (e.time < event.time || (e.time === event.time && e.id < event.id)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.eventQueue.splice(lo, 0, event);
  }

  /**
   * Run the event loop until the given time limit.
   * Processes events in chronological order.
   */
  async run(until: number): Promise<void> {
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue[0];
      if (event.time > until) break;

      this.eventQueue.shift();
      this._now = event.time;
      event.resolve();

      // Allow microtask queue to process (critical for async generators)
      await new Promise<void>((r) => queueMicrotask(r));
    }
    this._now = until;
  }
}

/**
 * Capacity-limited resource with FIFO wait queue.
 * Replaces SimPy's Resource.
 */
export class SimResource {
  private available: number;
  private waitQueue: Array<() => void> = [];

  constructor(public readonly capacity: number) {
    this.available = capacity;
  }

  /**
   * Request the resource. Returns a Promise that resolves when
   * capacity is available, and a release function to call when done.
   */
  async request(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      // Wait in FIFO queue
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    // Return release function
    return () => {
      this.available++;
      if (this.waitQueue.length > 0) {
        this.available--;
        const next = this.waitQueue.shift()!;
        next();
      }
    };
  }

  get queueLength(): number {
    return this.waitQueue.length;
  }
}

// ── Production Line Simulator ────────────────────────────────

/**
 * SimPy-based discrete-event simulation for labor-intensive production lines.
 *
 * Models bundles of pieces flowing through sequential operations,
 * each requiring machine/tool resources with pooled operator capacity.
 *
 * Ported from Python ProductionLineSimulator with identical logic.
 */
export class ProductionLineSimulator {
  private env: SimEnvironment;
  private metrics: SimulationMetrics;
  private rng: SeededRandom;

  private operationsByProduct: Map<string, OperationInput[]>;
  private demandsByProduct: Map<string, (typeof this.config.demands)[number]>;
  private breakdownsByTool: Map<string, number>;
  private resources: Map<string, SimResource>;
  private horizonMinutes: number;

  // V3 enhancement state
  private changeoverMatrix: Map<string, number>; // "fromProduct|toProduct" → minutes
  private breakdownDistributions: Map<string, { mtbf: number; mttr: number }>;
  private wipLimits: Map<string, number>; // machine_tool → max WIP
  private currentWipByStation: Map<string, number>; // machine_tool → current queue size
  private lastProductByTool: Map<string, string>; // last product processed per tool
  private breakSchedule: Array<{ afterMinutes: number; durationMinutes: number }>;
  private isOnBreak = false;

  constructor(
    private config: SimulationConfig,
    seed: number = 42,
  ) {
    this.env = new SimEnvironment();
    this.metrics = createEmptyMetrics();
    this.rng = new SeededRandom(seed);

    this.operationsByProduct = this.groupOperationsByProduct();
    this.demandsByProduct = new Map(config.demands.map((d) => [d.product, d]));
    this.breakdownsByTool = new Map((config.breakdowns ?? []).map((b) => [b.machine_tool, b.breakdown_pct]));
    this.resources = this.createResources();
    this.horizonMinutes = getDailyPlannedHours(config.schedule) * 60 * (config.horizon_days ?? 1);

    // V3 enhancements
    this.changeoverMatrix = new Map();
    for (const co of config.changeovers ?? []) {
      this.changeoverMatrix.set(`${co.from_product}|${co.to_product}`, co.changeover_minutes);
    }

    this.breakdownDistributions = new Map();
    for (const bd of config.breakdown_distributions ?? []) {
      this.breakdownDistributions.set(bd.machine_tool, { mtbf: bd.mtbf_minutes, mttr: bd.mttr_minutes });
    }

    this.wipLimits = new Map();
    for (const wl of config.wip_limits ?? []) {
      this.wipLimits.set(wl.machine_tool, wl.max_wip);
    }

    this.currentWipByStation = new Map();
    this.lastProductByTool = new Map();
    this.breakSchedule = config.enable_breaks ? DEFAULT_BREAK_PATTERN.breaks : [];
  }

  /** Group operations by product, sorted by step. */
  private groupOperationsByProduct(): Map<string, OperationInput[]> {
    const grouped = new Map<string, OperationInput[]>();
    for (const op of this.config.operations) {
      const list = grouped.get(op.product) ?? [];
      list.push(applyOperationDefaults(op));
      grouped.set(op.product, list);
    }
    for (const [, ops] of grouped) {
      ops.sort((a, b) => a.step - b.step);
    }
    return grouped;
  }

  /** Create SimResource per machine tool. Capacity = sum of operators. */
  private createResources(): Map<string, SimResource> {
    const toolCapacity = new Map<string, number>();
    for (const op of this.config.operations) {
      const current = toolCapacity.get(op.machine_tool) ?? 0;
      toolCapacity.set(op.machine_tool, current + (op.operators ?? 1));
    }

    const resources = new Map<string, SimResource>();
    for (const [tool, capacity] of toolCapacity) {
      resources.set(tool, new SimResource(capacity));
    }
    return resources;
  }

  /**
   * Calculate actual processing time for a single piece.
   * Formula: Actual = SAM × (1 + Variability + FPD/100 + (100-Grade)/100)
   */
  private calculateProcessTime(op: OperationInput): number {
    const baseSam = op.sam_min;
    const variability = op.variability ?? 'triangular';

    let variabilityFactor: number;
    if (variability === 'triangular') {
      variabilityFactor = this.rng.triangular(
        TRIANGULAR_VARIABILITY_MIN,
        TRIANGULAR_VARIABILITY_MODE,
        TRIANGULAR_VARIABILITY_MAX,
      );
    } else {
      variabilityFactor = 0;
    }

    const fpdMultiplier = (op.fpd_pct ?? 15) / 100;
    const gradeMultiplier = (100 - (op.grade_pct ?? 85)) / 100;

    const actualTime = baseSam * (1 + variabilityFactor + fpdMultiplier + gradeMultiplier);
    return Math.max(MIN_PROCESS_TIME_MINUTES, actualTime);
  }

  /** Get transition time in minutes based on bundle size. */
  private getBundleTransitionTime(bundleSize: number): number {
    if (bundleSize <= SMALL_BUNDLE_THRESHOLD) {
      return SMALL_BUNDLE_TRANSITION_SECONDS / 60;
    }
    return LARGE_BUNDLE_TRANSITION_SECONDS / 60;
  }

  /**
   * Check if a breakdown occurs and return delay time.
   * V3: Uses MTBF/MTTR distributions when configured, falls back to fixed delay.
   */
  private checkBreakdown(machineTool: string): number {
    const dist = this.breakdownDistributions.get(machineTool);
    if (dist) {
      // V3: Exponential MTBF → probability per operation = 1 - e^(-processTime/MTBF)
      // Simplified: check per-operation with rate derived from MTBF
      const failProb = 1 / dist.mtbf; // approximate per-minute failure rate
      if (this.rng.next() < failProb) {
        // MTTR: lognormal approximation using triangular(0.5×mttr, mttr, 2×mttr)
        const delay = this.rng.triangular(dist.mttr * 0.5, dist.mttr, dist.mttr * 2);
        this.metrics.breakdown_events++;
        this.metrics.breakdown_time_lost += delay;
        return delay;
      }
      return 0;
    }

    // V2 fallback: fixed probability + fixed delay
    const breakdownPct = this.breakdownsByTool.get(machineTool) ?? 0;
    if (breakdownPct > 0 && this.rng.next() * 100 < breakdownPct) {
      const delay = DEFAULT_BREAKDOWN_DELAY_MINUTES;
      this.metrics.breakdown_events++;
      this.metrics.breakdown_time_lost += delay;
      return delay;
    }
    return 0;
  }

  /**
   * V3: Get changeover delay when switching products on a tool.
   * Returns 0 if no changeover configured or same product.
   */
  private getChangeoverDelay(machineTool: string, product: string): number {
    const lastProduct = this.lastProductByTool.get(machineTool);
    this.lastProductByTool.set(machineTool, product);

    if (!lastProduct || lastProduct === product) return 0;

    const key = `${lastProduct}|${product}`;
    return this.changeoverMatrix.get(key) ?? 0;
  }

  /**
   * V3: Wait if station WIP exceeds kanban limit (backpressure).
   * Polls every 1 minute until space is available.
   */
  private async waitForWipCapacity(machineTool: string): Promise<void> {
    const limit = this.wipLimits.get(machineTool);
    if (limit === undefined) return;

    while ((this.currentWipByStation.get(machineTool) ?? 0) >= limit) {
      await this.env.timeout(1); // Poll every 1 minute
    }
  }

  /**
   * V3: Increment station WIP counter.
   */
  private enterStation(machineTool: string): void {
    const current = this.currentWipByStation.get(machineTool) ?? 0;
    this.currentWipByStation.set(machineTool, current + 1);
  }

  /**
   * V3: Decrement station WIP counter.
   */
  private leaveStation(machineTool: string): void {
    const current = this.currentWipByStation.get(machineTool) ?? 0;
    this.currentWipByStation.set(machineTool, Math.max(0, current - 1));
  }

  /**
   * Process a single bundle through all operations.
   * This is the core simulation process — equivalent to SimPy's generator.
   */
  private async bundleProcess(
    bundleId: number,
    product: string,
    bundleSize: number,
    operations: OperationInput[],
  ): Promise<void> {
    const startTime = this.env.now;
    this.metrics.current_wip += bundleSize;
    this.metrics.max_wip = Math.max(this.metrics.max_wip, this.metrics.current_wip);

    const currentBundles = this.metrics.current_bundles_by_product.get(product) ?? 0;
    this.metrics.current_bundles_by_product.set(product, currentBundles + 1);

    const transitionTime = this.getBundleTransitionTime(bundleSize);

    for (const op of operations) {
      // Entry transition delay
      await this.env.timeout(transitionTime);

      // V3: Wait for WIP capacity (kanban backpressure)
      await this.waitForWipCapacity(op.machine_tool);
      this.enterStation(op.machine_tool);

      const arrivalTime = this.env.now;

      // Request the machine/tool resource
      const resource = this.resources.get(op.machine_tool);
      if (!resource) { this.leaveStation(op.machine_tool); continue; }

      const release = await resource.request();

      // Record queue wait time
      const waitTime = this.env.now - arrivalTime;
      const queueWaits = this.metrics.station_queue_waits.get(op.machine_tool) ?? [];
      queueWaits.push(waitTime);
      this.metrics.station_queue_waits.set(op.machine_tool, queueWaits);

      // V3: Changeover delay when switching products
      const changeoverDelay = this.getChangeoverDelay(op.machine_tool, product);
      if (changeoverDelay > 0) {
        await this.env.timeout(changeoverDelay);
      }

      // Check for equipment breakdown (V3: uses MTBF/MTTR when configured)
      const breakdownDelay = this.checkBreakdown(op.machine_tool);
      if (breakdownDelay > 0) {
        await this.env.timeout(breakdownDelay);
      }

      // Process each piece in the bundle
      for (let piece = 0; piece < bundleSize; piece++) {
        // V3: Wait if on break
        while (this.isOnBreak) {
          await this.env.timeout(1);
        }

        const processTime = this.calculateProcessTime(op);
        await this.env.timeout(processTime);

        // Accumulate busy time and piece count
        const busyTime = this.metrics.station_busy_time.get(op.machine_tool) ?? 0;
        this.metrics.station_busy_time.set(op.machine_tool, busyTime + processTime);

        const piecesProcessed = this.metrics.station_pieces_processed.get(op.machine_tool) ?? 0;
        this.metrics.station_pieces_processed.set(op.machine_tool, piecesProcessed + 1);

        // Check for rework
        const reworkPct = op.rework_pct ?? 0;
        if (reworkPct > 0 && this.rng.next() * 100 < reworkPct) {
          this.metrics.rework_count++;
          const reworkByStation = this.metrics.rework_by_station.get(op.machine_tool) ?? 0;
          this.metrics.rework_by_station.set(op.machine_tool, reworkByStation + 1);

          const reworkTime = this.calculateProcessTime(op);
          await this.env.timeout(reworkTime);

          const reworkBusy = this.metrics.station_busy_time.get(op.machine_tool) ?? 0;
          this.metrics.station_busy_time.set(op.machine_tool, reworkBusy + reworkTime);
        }
      }

      // Release the resource
      release();
      this.leaveStation(op.machine_tool);

      // Exit transition delay
      await this.env.timeout(transitionTime);
    }

    // Bundle completed
    const endTime = this.env.now;
    const cycleTime = endTime - startTime;

    this.metrics.cycle_times.push(cycleTime);

    const productCycleTimes = this.metrics.cycle_times_by_product.get(product) ?? [];
    productCycleTimes.push(cycleTime);
    this.metrics.cycle_times_by_product.set(product, productCycleTimes);

    const throughput = this.metrics.throughput_by_product.get(product) ?? 0;
    this.metrics.throughput_by_product.set(product, throughput + bundleSize);

    this.metrics.bundles_completed++;

    const productBundles = this.metrics.bundles_by_product.get(product) ?? 0;
    this.metrics.bundles_by_product.set(product, productBundles + 1);

    this.metrics.current_wip -= bundleSize;

    const currentBundlesAfter = this.metrics.current_bundles_by_product.get(product) ?? 0;
    this.metrics.current_bundles_by_product.set(product, Math.max(0, currentBundlesAfter - 1));
  }

  /** Background process to sample WIP at regular intervals. */
  private async wipSampler(): Promise<void> {
    while (this.env.now < this.horizonMinutes) {
      await this.env.timeout(WIP_SAMPLE_INTERVAL_MINUTES);
      this.metrics.wip_samples.push(this.metrics.current_wip);

      for (const [product, count] of this.metrics.current_bundles_by_product) {
        const samples = this.metrics.bundles_in_system_samples.get(product) ?? [];
        samples.push(count);
        this.metrics.bundles_in_system_samples.set(product, samples);
      }
    }
  }

  /** Generate all bundles with staggered arrivals. */
  private generateBundles(): void {
    for (const [product, demand] of this.demandsByProduct) {
      if (!this.operationsByProduct.has(product)) continue;

      const operations = this.operationsByProduct.get(product)!;
      const bundleSize = demand.bundle_size ?? 1;

      // Calculate daily demand based on mode
      let dailyDemand: number;
      const mode = this.config.mode ?? 'demand-driven';

      if (mode === 'mix-driven') {
        if (this.config.total_demand && demand.mix_share_pct) {
          dailyDemand = this.config.total_demand * demand.mix_share_pct / 100;
        } else {
          continue;
        }
      } else {
        dailyDemand = demand.daily_demand ?? 0;
        if (!dailyDemand && demand.weekly_demand) {
          dailyDemand = demand.weekly_demand / this.config.schedule.work_days;
        }
      }

      if (dailyDemand <= 0) continue;

      const horizonDays = this.config.horizon_days ?? 1;
      const totalDemand = dailyDemand * horizonDays;
      const bundlesNeeded = Math.ceil(totalDemand / bundleSize);

      if (bundlesNeeded <= 0) continue;

      const interArrivalTime = this.horizonMinutes / bundlesNeeded;

      for (let i = 0; i < bundlesNeeded; i++) {
        const startDelay = i * interArrivalTime * 0.1; // 10% spread factor
        // Fire and forget — the event loop will process them
        this.delayedBundleStart(startDelay, i, product, bundleSize, operations);
      }
    }
  }

  /** Start a bundle after an initial delay. */
  private async delayedBundleStart(
    delay: number,
    bundleId: number,
    product: string,
    bundleSize: number,
    operations: OperationInput[],
  ): Promise<void> {
    if (delay > 0) {
      await this.env.timeout(delay);
    }
    await this.bundleProcess(bundleId, product, bundleSize, operations);
  }

  /**
   * V3: Schedule shift breaks as background events.
   * Sets isOnBreak flag during break periods, pausing all production.
   */
  private async shiftBreakScheduler(): Promise<void> {
    if (this.breakSchedule.length === 0) return;

    const dailyHours = getDailyPlannedHours(this.config.schedule);
    const horizonDays = this.config.horizon_days ?? 1;

    for (let day = 0; day < horizonDays; day++) {
      const dayStartMinutes = day * dailyHours * 60;

      for (const brk of this.breakSchedule) {
        const breakStart = dayStartMinutes + brk.afterMinutes;
        if (breakStart >= this.horizonMinutes) continue;

        // Wait until break time
        const waitUntil = breakStart - this.env.now;
        if (waitUntil > 0) await this.env.timeout(waitUntil);

        // Start break
        this.isOnBreak = true;
        await this.env.timeout(brk.durationMinutes);
        this.isOnBreak = false;
      }
    }
  }

  /** Execute the simulation and return collected metrics. */
  async run(): Promise<SimulationMetrics> {
    // Start background processes
    this.wipSampler();
    this.shiftBreakScheduler();

    // Generate all bundles
    this.generateBundles();

    // Run simulation until horizon
    await this.env.run(this.horizonMinutes);

    return this.metrics;
  }
}

// ── Public Entry Point ───────────────────────────────────────

/**
 * Execute simulation and return metrics with duration.
 * Main entry point for running a simulation.
 * Exported for testing.
 */
export async function runSimulation(
  config: SimulationConfig,
  seed: number = 42,
): Promise<{ metrics: SimulationMetrics; durationSeconds: number }> {
  const start = Date.now();

  const simulator = new ProductionLineSimulator(config, seed);
  const metrics = await simulator.run();

  const durationSeconds = (Date.now() - start) / 1000;
  return { metrics, durationSeconds };
}
