/**
 * FSM Templates — Pre-built manufacturing state machines
 *
 * Templates mirror the 9 implicit states from the S16 DES engine.
 * Each template represents a common manufacturing resource type.
 */

import type { FSMTemplate } from './models.js';

export const FSM_TEMPLATES: FSMTemplate[] = [
  // ── CNC Machine ────────────────────────────────────────
  {
    name: 'cnc_machine',
    label: 'CNC Machine',
    description: 'Standard CNC machine with breakdown, changeover, and material starvation states.',
    resource_type: 'machine',
    definition: {
      states: [
        { id: 'idle', name: 'Idle', mfg_type: 'idle', is_initial: true, is_final: false, x: 100, y: 200, entry_action: 'Signal upstream: ready for next job' },
        { id: 'processing', name: 'Processing', mfg_type: 'processing', is_initial: false, is_final: false, x: 350, y: 200, entry_action: 'Start cycle timer', exit_action: 'Increment parts counter' },
        { id: 'changeover', name: 'Changeover', mfg_type: 'changeover', is_initial: false, is_final: false, x: 350, y: 50, entry_action: 'Load new program, change tooling' },
        { id: 'breakdown', name: 'Breakdown', mfg_type: 'broken_down', is_initial: false, is_final: false, x: 600, y: 100, entry_action: 'Alert maintenance, log downtime' },
        { id: 'starved', name: 'Starved', mfg_type: 'starved', is_initial: false, is_final: false, x: 100, y: 50, entry_action: 'Signal material handler' },
        { id: 'blocked', name: 'Blocked', mfg_type: 'blocked', is_initial: false, is_final: false, x: 600, y: 300, entry_action: 'WIP limit reached, hold output' },
      ],
      transitions: [
        { id: 't1', from_state_id: 'idle', to_state_id: 'processing', event: 'job_arrives', guard: 'material_available && wip_below_limit' },
        { id: 't2', from_state_id: 'idle', to_state_id: 'changeover', event: 'job_arrives', guard: 'product_changed' },
        { id: 't3', from_state_id: 'idle', to_state_id: 'starved', event: 'job_arrives', guard: '!material_available' },
        { id: 't4', from_state_id: 'changeover', to_state_id: 'processing', event: 'changeover_complete' },
        { id: 't5', from_state_id: 'processing', to_state_id: 'idle', event: 'processing_complete' },
        { id: 't6', from_state_id: 'processing', to_state_id: 'breakdown', event: 'failure_occurs', probability: 0.02 },
        { id: 't7', from_state_id: 'processing', to_state_id: 'blocked', event: 'wip_limit_reached' },
        { id: 't8', from_state_id: 'breakdown', to_state_id: 'idle', event: 'repair_complete' },
        { id: 't9', from_state_id: 'starved', to_state_id: 'processing', event: 'material_replenished' },
        { id: 't10', from_state_id: 'blocked', to_state_id: 'processing', event: 'wip_cleared' },
      ],
    },
  },

  // ── Conveyor System ────────────────────────────────────
  {
    name: 'conveyor',
    label: 'Conveyor System',
    description: 'Material handling conveyor with running, stopped, and jam states.',
    resource_type: 'machine',
    definition: {
      states: [
        { id: 'stopped', name: 'Stopped', mfg_type: 'idle', is_initial: true, is_final: false, x: 100, y: 200 },
        { id: 'running', name: 'Running', mfg_type: 'processing', is_initial: false, is_final: false, x: 350, y: 200, entry_action: 'Motor ON, belt moving' },
        { id: 'jammed', name: 'Jammed', mfg_type: 'broken_down', is_initial: false, is_final: false, x: 350, y: 50, entry_action: 'E-stop, alert operator' },
        { id: 'maintenance', name: 'PM', mfg_type: 'on_break', is_initial: false, is_final: false, x: 600, y: 200, entry_action: 'Scheduled maintenance' },
      ],
      transitions: [
        { id: 't1', from_state_id: 'stopped', to_state_id: 'running', event: 'start_command' },
        { id: 't2', from_state_id: 'running', to_state_id: 'stopped', event: 'stop_command' },
        { id: 't3', from_state_id: 'running', to_state_id: 'jammed', event: 'jam_detected', probability: 0.01 },
        { id: 't4', from_state_id: 'jammed', to_state_id: 'stopped', event: 'jam_cleared' },
        { id: 't5', from_state_id: 'stopped', to_state_id: 'maintenance', event: 'pm_scheduled' },
        { id: 't6', from_state_id: 'maintenance', to_state_id: 'stopped', event: 'pm_complete' },
      ],
    },
  },

  // ── AGV Navigation ─────────────────────────────────────
  {
    name: 'agv',
    label: 'AGV Navigation',
    description: 'Automated Guided Vehicle with loading, traveling, and charging states.',
    resource_type: 'agv',
    definition: {
      states: [
        { id: 'parked', name: 'Parked', mfg_type: 'idle', is_initial: true, is_final: false, x: 100, y: 200 },
        { id: 'loading', name: 'Loading', mfg_type: 'changeover', is_initial: false, is_final: false, x: 250, y: 100 },
        { id: 'traveling', name: 'Traveling', mfg_type: 'processing', is_initial: false, is_final: false, x: 400, y: 200, entry_action: 'Navigate to destination' },
        { id: 'unloading', name: 'Unloading', mfg_type: 'changeover', is_initial: false, is_final: false, x: 550, y: 100 },
        { id: 'charging', name: 'Charging', mfg_type: 'on_break', is_initial: false, is_final: false, x: 100, y: 50 },
        { id: 'blocked_path', name: 'Path Blocked', mfg_type: 'blocked', is_initial: false, is_final: false, x: 400, y: 50 },
      ],
      transitions: [
        { id: 't1', from_state_id: 'parked', to_state_id: 'loading', event: 'dispatch_request' },
        { id: 't2', from_state_id: 'loading', to_state_id: 'traveling', event: 'load_complete' },
        { id: 't3', from_state_id: 'traveling', to_state_id: 'unloading', event: 'destination_reached' },
        { id: 't4', from_state_id: 'traveling', to_state_id: 'blocked_path', event: 'obstacle_detected' },
        { id: 't5', from_state_id: 'blocked_path', to_state_id: 'traveling', event: 'path_clear' },
        { id: 't6', from_state_id: 'unloading', to_state_id: 'parked', event: 'unload_complete' },
        { id: 't7', from_state_id: 'parked', to_state_id: 'charging', event: 'low_battery', guard: 'battery < 20%' },
        { id: 't8', from_state_id: 'charging', to_state_id: 'parked', event: 'charge_complete' },
      ],
    },
  },

  // ── Order Processing ───────────────────────────────────
  {
    name: 'order_processing',
    label: 'Order Processing',
    description: 'Production order lifecycle from received to shipped.',
    resource_type: 'product',
    definition: {
      states: [
        { id: 'received', name: 'Received', mfg_type: 'queued', is_initial: true, is_final: false, x: 50, y: 200 },
        { id: 'scheduled', name: 'Scheduled', mfg_type: 'queued', is_initial: false, is_final: false, x: 200, y: 200 },
        { id: 'in_production', name: 'In Production', mfg_type: 'processing', is_initial: false, is_final: false, x: 350, y: 200 },
        { id: 'qc_inspection', name: 'QC Inspection', mfg_type: 'processing', is_initial: false, is_final: false, x: 500, y: 200 },
        { id: 'on_hold', name: 'On Hold', mfg_type: 'blocked', is_initial: false, is_final: false, x: 350, y: 50, entry_action: 'Flag for review' },
        { id: 'shipped', name: 'Shipped', mfg_type: 'idle', is_initial: false, is_final: true, x: 650, y: 200 },
        { id: 'rejected', name: 'Rejected/Rework', mfg_type: 'broken_down', is_initial: false, is_final: false, x: 500, y: 50 },
      ],
      transitions: [
        { id: 't1', from_state_id: 'received', to_state_id: 'scheduled', event: 'schedule_confirmed' },
        { id: 't2', from_state_id: 'scheduled', to_state_id: 'in_production', event: 'production_start', guard: 'material_available' },
        { id: 't3', from_state_id: 'scheduled', to_state_id: 'on_hold', event: 'material_shortage' },
        { id: 't4', from_state_id: 'on_hold', to_state_id: 'scheduled', event: 'hold_released' },
        { id: 't5', from_state_id: 'in_production', to_state_id: 'qc_inspection', event: 'production_complete' },
        { id: 't6', from_state_id: 'qc_inspection', to_state_id: 'shipped', event: 'qc_passed' },
        { id: 't7', from_state_id: 'qc_inspection', to_state_id: 'rejected', event: 'qc_failed' },
        { id: 't8', from_state_id: 'rejected', to_state_id: 'in_production', event: 'rework_started' },
      ],
    },
  },
];

export function getTemplate(name: string): FSMTemplate | undefined {
  return FSM_TEMPLATES.find((t) => t.name === name);
}

export function listTemplates(): Array<{ name: string; label: string; description: string; resource_type: string }> {
  return FSM_TEMPLATES.map((t) => ({
    name: t.name, label: t.label, description: t.description, resource_type: t.resource_type,
  }));
}
