/**
 * FSM Validation — Reachability, deadlock detection, completeness
 */

import type { FSMConfig, FSMDefinition, ValidationResult, ValidationIssue } from './models.js';

export function validateFSM(config: FSMConfig): ValidationResult {
  const issues: ValidationIssue[] = [];
  const reachability: Record<string, string[]> = {};
  const deadlockStates: Record<string, string[]> = {};
  let hasInitial = true;

  for (const machine of config.machines) {
    const mIssues = validateMachine(machine);
    issues.push(...mIssues);

    // Reachability: BFS from initial state
    const initial = machine.states.find((s) => s.is_initial);
    if (!initial) {
      hasInitial = false;
      issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: No initial state defined.` });
      continue;
    }

    const reachable = new Set<string>();
    const queue = [initial.id];
    while (queue.length > 0) {
      const stateId = queue.shift()!;
      if (reachable.has(stateId)) continue;
      reachable.add(stateId);
      const outgoing = machine.transitions.filter((t) => t.from_state_id === stateId);
      for (const t of outgoing) {
        if (!reachable.has(t.to_state_id)) queue.push(t.to_state_id);
      }
    }

    const unreachable = machine.states.filter((s) => !reachable.has(s.id)).map((s) => s.id);
    if (unreachable.length > 0) {
      reachability[machine.id] = unreachable;
      const names = machine.states.filter((s) => unreachable.includes(s.id)).map((s) => s.name);
      issues.push({ severity: 'warning', machine_id: machine.id, message: `${machine.name}: Unreachable states: ${names.join(', ')}` });
    } else {
      reachability[machine.id] = [];
    }

    // Deadlock: states with no outgoing transitions (and not final)
    const deadlocks = machine.states
      .filter((s) => !s.is_final && !machine.transitions.some((t) => t.from_state_id === s.id))
      .map((s) => s.id);
    if (deadlocks.length > 0) {
      deadlockStates[machine.id] = deadlocks;
      const names = machine.states.filter((s) => deadlocks.includes(s.id)).map((s) => s.name);
      issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: Deadlock states (no outgoing transitions): ${names.join(', ')}` });
    } else {
      deadlockStates[machine.id] = [];
    }
  }

  return {
    is_valid: !issues.some((i) => i.severity === 'error'),
    issues,
    reachability,
    deadlock_states: deadlockStates,
    has_initial_states: hasInitial,
  };
}

function validateMachine(machine: FSMDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (machine.states.length === 0) {
    issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: No states defined.` });
    return issues;
  }

  const initials = machine.states.filter((s) => s.is_initial);
  if (initials.length === 0) {
    issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: No initial state.` });
  } else if (initials.length > 1) {
    issues.push({ severity: 'warning', machine_id: machine.id, message: `${machine.name}: Multiple initial states (${initials.map((s) => s.name).join(', ')}). Using first.` });
  }

  // Check transitions reference valid states
  const stateIds = new Set(machine.states.map((s) => s.id));
  for (const t of machine.transitions) {
    if (!stateIds.has(t.from_state_id)) {
      issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: Transition "${t.event}" from unknown state "${t.from_state_id}".` });
    }
    if (!stateIds.has(t.to_state_id)) {
      issues.push({ severity: 'error', machine_id: machine.id, message: `${machine.name}: Transition "${t.event}" to unknown state "${t.to_state_id}".` });
    }
  }

  // Check for duplicate transitions (same from + event)
  const seen = new Set<string>();
  for (const t of machine.transitions) {
    const key = `${t.from_state_id}:${t.event}`;
    if (seen.has(key) && !t.guard && !t.probability) {
      issues.push({ severity: 'warning', machine_id: machine.id, message: `${machine.name}: Duplicate transition for event "${t.event}" from "${t.from_state_id}" — add guards to disambiguate.` });
    }
    seen.add(key);
  }

  return issues;
}
