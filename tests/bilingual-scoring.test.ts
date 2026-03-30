import { describe, it, expect } from 'vitest';
import { scoreMfgIntent } from '../src/capabilities.js';

describe('scoreMfgIntent — Bilingual EN/ES', () => {
  // Helper: check that a message scores above threshold and suggests expected tool
  function expectToolSuggested(message: string, tool: string) {
    const result = scoreMfgIntent(message);
    expect(result.suggestedTools, `"${message}" should suggest ${tool}`).toContain(tool);
    expect(result.score, `"${message}" should score > 0`).toBeGreaterThan(0);
  }

  function expectScoreAbove(message: string, minScore: number) {
    const result = scoreMfgIntent(message);
    expect(result.score, `"${message}" should score >= ${minScore}`).toBeGreaterThanOrEqual(minScore);
  }

  describe('English (baseline — should still work)', () => {
    it('capacity planning', () => expectToolSuggested('I need to analyze production capacity', 'capacity_planning'));
    it('simulation', () => expectToolSuggested('Run a simulation with 5 operators', 'production_simulation'));
    it('line balance', () => expectToolSuggested('Balance the assembly line', 'line_balance'));
    it('FMEA', () => expectToolSuggested('Perform a failure mode analysis', 'fmea_manage'));
    it('RCA', () => expectToolSuggested('Find the root cause of the defect', 'rca_manage'));
    it('DOE', () => expectToolSuggested('Design an experiment with 3 factors', 'design_of_experiments'));
    it('VSM', () => expectToolSuggested('Map the value stream for this process', 'value_stream_map'));
    it('TOC', () => expectToolSuggested('Identify the constraint in our process', 'toc_analysis'));
    it('inventory', () => expectToolSuggested('Calculate the EOQ for these parts', 'inventory_plan'));
    it('document', () => expectToolSuggested('Generate a production report', 'generate_document'));
    it('learning', () => expectToolSuggested('I want to learn about lean manufacturing', 'learning_coach'));
  });

  describe('Spanish — Manufacturing tools', () => {
    it('capacity planning', () => expectToolSuggested('Necesito analizar la capacidad de producción', 'capacity_planning'));
    it('simulation', () => expectToolSuggested('Quiero hacer una simulación con 5 operadores', 'production_simulation'));
    it('line balance', () => expectToolSuggested('Hacer un balance de línea con takt de 60 segundos', 'line_balance'));
    it('FMEA/AMEF', () => expectToolSuggested('Tengo un AMEF que necesita actualización', 'fmea_manage'));
    it('RCA', () => expectToolSuggested('Analizar la causa raíz del defecto', 'rca_manage'));
    it('DOE', () => expectToolSuggested('Diseñar un experimento con 3 factores', 'design_of_experiments'));
    it('VSM', () => expectToolSuggested('Hacer un mapeo de valor del proceso', 'value_stream_map'));
    it('TOC', () => expectToolSuggested('Identificar la restricción en nuestro proceso', 'toc_analysis'));
    it('inventory', () => expectToolSuggested('Calcular el inventario y punto de reorden', 'inventory_plan'));
    it('six sigma', () => expectToolSuggested('Necesito análisis de calidad con seis sigma', 'sigma_analysis'));
    it('SPC', () => expectToolSuggested('Crear un plan de control para la línea 3', 'spc_setup'));
    it('sequencing', () => expectToolSuggested('Programar la secuencia de las órdenes de trabajo', 'job_sequencer'));
    it('CONWIP', () => expectToolSuggested('Implementar nivelación de producción heijunka', 'conwip_heijunka'));
    it('FSM', () => expectToolSuggested('Modelar los estados de la máquina', 'state_machine_simulator'));
  });

  describe('Spanish — Non-manufacturing', () => {
    it('document generation', () => expectToolSuggested('Generar un reporte mensual de producción', 'generate_document'));
    it('learning', () => expectToolSuggested('Quiero aprender sobre lean manufacturing', 'learning_coach'));
    it('research', () => expectToolSuggested('Buscar artículos de investigación sobre calidad', 'search_papers'));
    it('task management', () => expectToolSuggested('Agregar esta tarea al tablero kanban', 'kanban_manage'));
    it('reminders', () => expectToolSuggested('Recordarme cada lunes revisar los reportes', 'create_reminder'));
    it('memory', () => expectToolSuggested('Recuerdas lo que hablamos de la línea 5?', 'query_memory'));
  });

  describe('Spanish — Problem signals score boost', () => {
    it('data signal: tengo datos', () => expectScoreAbove('Tengo datos de 15 estaciones', 15));
    it('units: 500 piezas', () => expectScoreAbove('Producimos 500 piezas por turno', 25));
    it('action: optimizar', () => expectScoreAbove('Necesito optimizar el proceso', 20));
    it('desire: me gustaría', () => expectScoreAbove('Me gustaría mejorar la eficiencia', 20));
    it('constraint: presupuesto', () => expectScoreAbove('El presupuesto no alcanza para más operadores', 15));
    it('tolerance: especificación', () => expectScoreAbove('La especificación es ±0.5mm', 20));
  });

  describe('Spanish — Knowledge signals reduce score', () => {
    it('qué es', () => {
      const result = scoreMfgIntent('Qué es un diagrama de Ishikawa?');
      // Should have negative contribution from knowledge signal
      expect(result.score).toBeLessThan(20);
    });
    it('explica (pure knowledge question)', () => {
      const result = scoreMfgIntent('Explica qué es el lean manufacturing');
      // Knowledge signal (-20) should keep score low even with some keyword matches
      expect(result.score).toBeLessThan(30);
    });
  });

  describe('Bilingual parity — same message, same tool', () => {
    const pairs = [
      ['Analyze production capacity', 'Analizar capacidad de producción', 'capacity_planning'],
      ['Run a simulation', 'Ejecutar una simulación', 'production_simulation'],
      ['Balance the line', 'Balancear la línea', 'line_balance'],
      ['Find the root cause', 'Encontrar la causa raíz', 'rca_manage'],
      ['Design an experiment', 'Diseñar un experimento', 'design_of_experiments'],
    ] as const;

    for (const [en, es, tool] of pairs) {
      it(`EN: "${en}" ↔ ES: "${es}" → ${tool}`, () => {
        const enResult = scoreMfgIntent(en);
        const esResult = scoreMfgIntent(es);
        expect(enResult.suggestedTools, `EN should suggest ${tool}`).toContain(tool);
        expect(esResult.suggestedTools, `ES should suggest ${tool}`).toContain(tool);
      });
    }
  });
});
