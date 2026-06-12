/**
 * Job Sequencing — Genetic Algorithm
 *
 * Permutation-based GA for job-shop scheduling optimization.
 * - Encoding: permutation of job indices
 * - Crossover: Partially Mapped Crossover (PMX)
 * - Mutation: swap mutation
 * - Selection: tournament selection
 * - Elitism: preserve top N individuals
 *
 * Objectives: minimize makespan, lateness, setup time, or weighted combination.
 */

import type {
  SequencerConfig,
  GAConfig,
  GAResult,
  ScheduleMetrics,
} from './models.js';
import { DEFAULT_GA_CONFIG } from './models.js';
import {
  buildScheduleFromPermutation,
  computeMetrics,
} from './evaluation.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Run the genetic algorithm to find an optimal job sequence.
 */
export function runGA(
  config: SequencerConfig,
  gaConfig?: Partial<GAConfig>,
): GAResult {
  const ga: GAConfig = { ...DEFAULT_GA_CONFIG, ...gaConfig };
  const start = performance.now();
  const n = config.jobs.length;

  if (n === 0) {
    return {
      rule_or_method: 'GA',
      entries: [],
      metrics: emptyMetrics(),
      computation_ms: 0,
      best_fitness: 0,
      fitness_history: [],
      convergence_generation: 0,
    };
  }

  // Initialize population with random permutations
  let population = initializePopulation(n, ga.population_size);

  // Evaluate initial population
  let fitnesses = population.map((p) => evaluateFitness(p, config, ga));
  let bestFitness = Math.min(...fitnesses);
  const bestIdx = fitnesses.indexOf(bestFitness);
  let bestPermutation = [...population[bestIdx]];

  const fitnessHistory: number[] = [bestFitness];
  let convergenceGen = 0;
  let staleCount = 0;

  // Evolution loop
  for (let gen = 1; gen < ga.generations; gen++) {
    const newPopulation: number[][] = [];

    // Elitism: keep top N
    const eliteIndices = getTopIndices(fitnesses, ga.elitism_count);
    for (const idx of eliteIndices) {
      newPopulation.push([...population[idx]]);
    }

    // Fill rest with crossover + mutation
    while (newPopulation.length < ga.population_size) {
      const parent1 = tournamentSelect(population, fitnesses, ga.tournament_size);
      const parent2 = tournamentSelect(population, fitnesses, ga.tournament_size);

      let child: number[];
      if (Math.random() < ga.crossover_rate) {
        child = pmxCrossover(parent1, parent2);
      } else {
        child = [...parent1];
      }

      if (Math.random() < ga.mutation_rate) {
        swapMutation(child);
      }

      newPopulation.push(child);
    }

    population = newPopulation;
    fitnesses = population.map((p) => evaluateFitness(p, config, ga));

    const genBestFitness = Math.min(...fitnesses);
    const genBestIdx = fitnesses.indexOf(genBestFitness);

    if (genBestFitness < bestFitness) {
      bestFitness = genBestFitness;
      bestPermutation = [...population[genBestIdx]];
      convergenceGen = gen;
      staleCount = 0;
    } else {
      staleCount++;
    }

    fitnessHistory.push(bestFitness);

    // Early termination if no improvement for 50 generations
    if (staleCount >= 50 && gen > 100) break;
  }

  // Build final schedule from best permutation
  const entries = buildScheduleFromPermutation(bestPermutation, config);
  const metrics = computeMetrics(entries, config);
  const computationMs = performance.now() - start;

  return {
    rule_or_method: 'GA',
    entries,
    metrics,
    computation_ms: Math.round(computationMs * 100) / 100,
    best_fitness: Math.round(bestFitness * 100) / 100,
    fitness_history: fitnessHistory,
    convergence_generation: convergenceGen,
  };
}

// ── Fitness Evaluation ───────────────────────────────────────

function evaluateFitness(
  permutation: number[],
  config: SequencerConfig,
  ga: GAConfig,
): number {
  const entries = buildScheduleFromPermutation(permutation, config);
  const metrics = computeMetrics(entries, config);

  switch (ga.objective) {
    case 'makespan':
      return metrics.makespan;
    case 'lateness':
      return metrics.total_lateness + metrics.num_late_jobs * 100;
    case 'setup_time':
      return metrics.total_setup_time;
    case 'weighted': {
      const wM = ga.weight_makespan ?? 0.4;
      const wL = ga.weight_lateness ?? 0.3;
      const wS = ga.weight_setup ?? 0.3;
      return wM * metrics.makespan + wL * metrics.total_lateness + wS * metrics.total_setup_time;
    }
    default:
      return metrics.makespan;
  }
}

// ── Population Initialization ────────────────────────────────

function initializePopulation(n: number, size: number): number[][] {
  const population: number[][] = [];

  // First individual: sequential (FIFO-like)
  const base = Array.from({ length: n }, (_, i) => i);
  population.push([...base]);

  // Rest: random permutations
  for (let i = 1; i < size; i++) {
    const perm = [...base];
    fisherYatesShuffle(perm);
    population.push(perm);
  }

  return population;
}

function fisherYatesShuffle(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Selection ────────────────────────────────────────────────

function tournamentSelect(
  population: number[][],
  fitnesses: number[],
  tournamentSize: number,
): number[] {
  let bestIdx = Math.floor(Math.random() * population.length);
  let bestFit = fitnesses[bestIdx];

  for (let i = 1; i < tournamentSize; i++) {
    const idx = Math.floor(Math.random() * population.length);
    if (fitnesses[idx] < bestFit) {
      bestIdx = idx;
      bestFit = fitnesses[idx];
    }
  }

  return population[bestIdx];
}

// ── Crossover (PMX — Partially Mapped Crossover) ────────────

function pmxCrossover(parent1: number[], parent2: number[]): number[] {
  const n = parent1.length;
  if (n <= 2) return [...parent1];

  const child = new Array(n).fill(-1);

  // Select random crossover segment
  let start = Math.floor(Math.random() * n);
  let end = Math.floor(Math.random() * n);
  if (start > end) [start, end] = [end, start];
  if (start === end) end = Math.min(end + 1, n - 1);

  // Copy segment from parent1
  for (let i = start; i <= end; i++) {
    child[i] = parent1[i];
  }

  // Map remaining from parent2
  const childSet = new Set(child.filter((v) => v !== -1));

  for (let i = 0; i < n; i++) {
    if (child[i] !== -1) continue;

    // Try parent2's value at this position
    const val = parent2[i];
    if (!childSet.has(val)) {
      child[i] = val;
      childSet.add(val);
    }
  }

  // Fill any remaining positions
  const missing = Array.from({ length: n }, (_, i) => i).filter((v) => !childSet.has(v));
  let mIdx = 0;
  for (let i = 0; i < n; i++) {
    if (child[i] === -1) {
      child[i] = missing[mIdx++];
    }
  }

  return child;
}

// ── Mutation ─────────────────────────────────────────────────

function swapMutation(perm: number[]): void {
  if (perm.length < 2) return;
  const i = Math.floor(Math.random() * perm.length);
  let j = Math.floor(Math.random() * perm.length);
  while (j === i) j = Math.floor(Math.random() * perm.length);
  [perm[i], perm[j]] = [perm[j], perm[i]];
}

// ── Helpers ──────────────────────────────────────────────────

function getTopIndices(fitnesses: number[], count: number): number[] {
  const indexed = fitnesses.map((f, i) => ({ f, i }));
  indexed.sort((a, b) => a.f - b.f);
  return indexed.slice(0, Math.min(count, indexed.length)).map((x) => x.i);
}

function emptyMetrics(): ScheduleMetrics {
  return {
    makespan: 0, total_flow_time: 0, avg_flow_time: 0,
    total_lateness: 0, max_lateness: 0, num_late_jobs: 0,
    on_time_pct: 100, total_setup_time: 0, avg_utilization_pct: 0,
    total_idle_time: 0,
  };
}
