---
name: feature_request
description: "Manages the Level 3 feature request lifecycle. Creates kanban cards with PRD, schedules off-hours review, monitors status, and notifies stakeholders through the 13-step workflow."
type: generated_code
parameters:
  - name: action
    type: string
    description: "Workflow action: create, status, list"
    required: true
  - name: title
    type: string
    description: "Feature request title (for create)"
    required: false
  - name: description
    type: string
    description: "Full PRD content or status note"
    required: false
  - name: priority
    type: number
    description: "Priority 1-5 (1=critical)"
    required: false
---
// Feature request workflow automation
// Runs in V8 sandbox — returns structured data for the platform

const action = args.action;
const title = args.title || '';
const description = args.description || '';
const priority = args.priority || 2;

if (action === 'create') {
  if (!title) return { error: 'Title is required for create action' };
  return {
    kanban_action: 'create',
    title: '[L3] ' + title,
    description: description || 'PRD pending — use /skill use feature-architect to generate',
    priority: priority,
    assignee: 'noted',
    message: '📋 Feature request created: **' + title + '**\n' +
      'Your request will be reviewed during off-hours and submitted to the dev team.\n' +
      'Use `/skill use feature-architect` to generate a full PRD.\n\n' +
      '📋 Solicitud creada: **' + title + '**\n' +
      'Su solicitud será revisada fuera de horario y enviada al equipo de desarrollo.',
  };
}

if (action === 'status') {
  return {
    message: 'Use `/board` to check the status of your feature requests.\n' +
      'Cards with [L3] prefix are Level 3 feature requests.\n\n' +
      'Use `/board` para verificar el estado de sus solicitudes.',
  };
}

if (action === 'list') {
  return {
    message: 'Use `/board` to see all cards. Level 3 requests have [L3] prefix.\n' +
      'Use `/board` para ver todas las tarjetas. Las solicitudes Nivel 3 tienen prefijo [L3].',
  };
}

return { error: 'Unknown action: ' + action + '. Use: create, status, list' };
