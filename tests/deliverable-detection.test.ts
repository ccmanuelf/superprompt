/**
 * rc.74 — bilingual detection for deliverable-format requests and
 * kanban-intent guards. Both must work on EN and ES because the user
 * routinely code-switches mid-conversation.
 *
 * These regexes are duplicated from router.ts / telegram.ts /
 * matrix.ts intentionally — they're simple enough that exporting
 * internals would cost more than the sync tax.
 */
import { describe, it, expect } from 'vitest';

// Mirror of router.ts DELIVERABLE_FORMAT_REGEX
const DELIVERABLE_FORMAT_REGEX =
  /\b(pdf|docx|xlsx|pptx|csv|report|document|file|attachment|download|deliverable|reporte|informe|documento|archivo|adjunto|descarga|descargar|entregable)\b/i;

// Mirror of the kanban intent regex in telegram.ts / matrix.ts
const KANBAN_INTENT_REGEX =
  /\b(board|kanban|task|card|ticket|todo|to-?do|tablero|tarea|tarjeta|pendiente|pendientes|por hacer)\b/i;

// Mirror of router.ts SIMULATION_INTENT_REGEX + classifyDeliverableIntent
const SIMULATION_INTENT_REGEX =
  /\b(simulation|simulaci[oó]n|monte\s*carlo|sanity\s*check|capacity|capacidad|bottleneck|restricci[oó]n|vsm|toc|throughput|takt)\b/i;

interface DeliverableIntent {
  isDeliverable: boolean;
  needsSimulation: boolean;
  allowedTools: string[] | null;
}

function classifyDeliverableIntent(text: string | undefined): DeliverableIntent {
  if (!text || !DELIVERABLE_FORMAT_REGEX.test(text)) {
    return { isDeliverable: false, needsSimulation: false, allowedTools: null };
  }
  const tools = ['parse_file', 'read_file', 'generate_document'];
  const needsSimulation = SIMULATION_INTENT_REGEX.test(text);
  if (needsSimulation) {
    tools.push(
      'production_simulation',
      'monte_carlo',
      'line_balance',
      'capacity_planning',
      'value_stream_map',
      'toc_analysis',
    );
  }
  return { isDeliverable: true, needsSimulation, allowedTools: tools };
}

describe('deliverable format detection (rc.74)', () => {
  const matchingEN = [
    'Please generate a PDF with the results',
    'Can you produce a docx summary?',
    'I need an xlsx export',
    'Create a report in English',
    'Send me the document',
    'Prepare a file with the data',
    'Email me the attachment',
    'I want to download the final deliverable',
  ];

  const matchingES = [
    'Genera un PDF con los resultados',
    'Necesito un reporte completo',
    'Prepara un informe ejecutivo',
    'Envíame el documento',
    'Hazme el archivo con los datos',
    'Quiero descargar el reporte',
    'Necesito descarga del entregable',
    'Quiero el reporte adjunto',
  ];

  const nonMatching = [
    'How are things going today?',
    'Explain the concept of value stream mapping',
    'What is the bottleneck?',
    '¿Cómo estás?',
    'Explícame el concepto de mapeo de flujo de valor',
  ];

  it.each(matchingEN)('matches English deliverable request: %s', (msg) => {
    expect(DELIVERABLE_FORMAT_REGEX.test(msg)).toBe(true);
  });

  it.each(matchingES)('matches Spanish deliverable request: %s', (msg) => {
    expect(DELIVERABLE_FORMAT_REGEX.test(msg)).toBe(true);
  });

  it.each(nonMatching)('does not match conversational message: %s', (msg) => {
    expect(DELIVERABLE_FORMAT_REGEX.test(msg)).toBe(false);
  });
});

describe('kanban intent detection (rc.74)', () => {
  const matchingEN = [
    'Add this to the board',
    'Create a kanban card for this',
    'Make a task for the team',
    'Open a ticket about this',
    'Add a todo',
    'Add a to-do for follow-up',
  ];

  const matchingES = [
    'Agrega esto al tablero',
    'Crea una tarea para esto',
    'Añade una tarjeta al kanban',
    'Abre un ticket',
    'Déjalo como pendiente',
    'Ponlo en pendientes',
    'Lo dejamos por hacer',
  ];

  const nonMatchingDeliverables = [
    'Please generate a PDF with the results',
    'Necesito un reporte completo',
    'Can you make me a document',
    'Prepara un informe ejecutivo',
  ];

  it.each(matchingEN)('matches English board/task intent: %s', (msg) => {
    expect(KANBAN_INTENT_REGEX.test(msg)).toBe(true);
  });

  it.each(matchingES)('matches Spanish board/task intent: %s', (msg) => {
    expect(KANBAN_INTENT_REGEX.test(msg)).toBe(true);
  });

  it.each(nonMatchingDeliverables)(
    'does NOT match deliverable requests (no stray card creation): %s',
    (msg) => {
      expect(KANBAN_INTENT_REGEX.test(msg)).toBe(false);
    },
  );
});

describe('classifyDeliverableIntent — tool allowlist (rc.75)', () => {
  it('returns null allowlist for non-deliverable messages', () => {
    const result = classifyDeliverableIntent('How are things going today?');
    expect(result.isDeliverable).toBe(false);
    expect(result.needsSimulation).toBe(false);
    expect(result.allowedTools).toBeNull();
  });

  it('returns base tools for a plain deliverable request (no simulation)', () => {
    const result = classifyDeliverableIntent('Generate a PDF report in English');
    expect(result.isDeliverable).toBe(true);
    expect(result.needsSimulation).toBe(false);
    expect(result.allowedTools).toEqual(['parse_file', 'read_file', 'generate_document']);
  });

  it('includes simulation tools when simulation keywords are present (EN)', () => {
    const result = classifyDeliverableIntent(
      'Run a Monte Carlo simulation and generate the PDF report',
    );
    expect(result.isDeliverable).toBe(true);
    expect(result.needsSimulation).toBe(true);
    expect(result.allowedTools).toContain('generate_document');
    expect(result.allowedTools).toContain('production_simulation');
    expect(result.allowedTools).toContain('monte_carlo');
  });

  it('includes simulation tools when simulation keywords are present (ES)', () => {
    const result = classifyDeliverableIntent(
      'Corre la simulación de Monte Carlo y genera el reporte PDF',
    );
    expect(result.isDeliverable).toBe(true);
    expect(result.needsSimulation).toBe(true);
    expect(result.allowedTools).toContain('generate_document');
    expect(result.allowedTools).toContain('production_simulation');
  });

  it('does NOT include kanban, memory, screenshot, or unrelated tools', () => {
    const result = classifyDeliverableIntent('Necesito el reporte PDF con análisis de capacidad');
    expect(result.allowedTools).not.toContain('kanban_manage');
    expect(result.allowedTools).not.toContain('query_memory');
    expect(result.allowedTools).not.toContain('save_memory');
    expect(result.allowedTools).not.toContain('take_screenshot');
    expect(result.allowedTools).not.toContain('web_search');
  });

  it('handles undefined text safely', () => {
    const result = classifyDeliverableIntent(undefined);
    expect(result.isDeliverable).toBe(false);
    expect(result.allowedTools).toBeNull();
  });
});
