/**
 * Web UI Knowledge Base — onboarding guidance for every web dashboard.
 *
 * clauded uses this to:
 * 1. Proactively suggest the right web UI in conversation context
 * 2. Provide onboarding guidance when users ask "how do I use /sim?"
 * 3. Know what each dashboard does so it doesn't rebuild existing features
 *
 * Each guide is bilingual (EN/ES) and includes:
 * - What the dashboard does
 * - Key features and how to use them
 * - When to suggest it (conversation triggers)
 * - Tips for getting the most value
 */

export interface WebUIGuide {
  url: string;
  name: string;
  nameEs: string;
  description: string;
  descriptionEs: string;
  features: string[];
  featuresEs: string[];
  whenToSuggest: string[];
  tips: string[];
  tipsEs: string[];
}

// ── Core Web UIs ─────────────────────────────────────────────

export const WEB_UI_GUIDES: WebUIGuide[] = [
  {
    url: '/',
    name: 'Voice Chat',
    nameEs: 'Chat de Voz',
    description: 'Browser-based voice conversation with clauded. Speak naturally and get spoken responses.',
    descriptionEs: 'Conversacion por voz desde el navegador. Habla naturalmente y recibe respuestas habladas.',
    features: [
      'Real-time speech-to-text (99 languages)',
      'Text-to-speech responses (English + Spanish voices)',
      'No Telegram needed — works in any browser',
      'WebSocket connection for low latency',
    ],
    featuresEs: [
      'Voz a texto en tiempo real (99 idiomas)',
      'Respuestas de texto a voz (voces en ingles + espanol)',
      'No necesitas Telegram — funciona en cualquier navegador',
      'Conexion WebSocket de baja latencia',
    ],
    whenToSuggest: [
      'User mentions hands-free or voice interaction',
      'User is on production floor (can\'t type easily)',
      'User asks about browser access to clauded',
    ],
    tips: [
      'You need an access token to connect — ask your IT administrator or department champion for it',
      'The token is the VOICE_WEB_TOKEN from the deployment configuration',
      'Click the microphone button and speak clearly',
      'Wait for the "processing" indicator before speaking again',
      'Works best in Chrome or Edge',
    ],
    tipsEs: [
      'Necesitas un token de acceso para conectar — consultalo con tu administrador de TI o lider de departamento',
      'El token es el VOICE_WEB_TOKEN de la configuracion de despliegue',
      'Haz clic en el boton del microfono y habla claramente',
      'Espera el indicador de "procesando" antes de hablar de nuevo',
      'Funciona mejor en Chrome o Edge',
    ],
  },
  {
    url: '/board.html',
    name: 'Kanban Task Board',
    nameEs: 'Tablero Kanban de Tareas',
    description: 'Visual task management board with drag-and-drop columns: Backlog → In Progress → Review → Done.',
    descriptionEs: 'Tablero visual de gestion de tareas con columnas arrastrables: Pendiente → En Progreso → Revision → Hecho.',
    features: [
      'Drag and drop cards between columns',
      'Create, edit, delete task cards',
      'Set priority (1-5), due dates, and assignees',
      'Real-time sync with Telegram /board commands',
      'Filter by status, priority, or assignee',
    ],
    featuresEs: [
      'Arrastra y suelta tarjetas entre columnas',
      'Crear, editar, eliminar tarjetas de tareas',
      'Establecer prioridad (1-5), fechas limite y asignados',
      'Sincronizacion en tiempo real con comandos /board de Telegram',
      'Filtrar por estado, prioridad o asignado',
    ],
    whenToSuggest: [
      'User creates or manages tasks',
      'User asks about project status or tracking',
      'User mentions priorities or deadlines',
      'User says "show me my tasks" or "what\'s on my plate"',
    ],
    tips: [
      'Cards created via Telegram /board appear here automatically',
      'Click a card to see full details and edit',
      'Use the priority colors to quickly spot urgent items',
    ],
    tipsEs: [
      'Las tarjetas creadas via Telegram /board aparecen aqui automaticamente',
      'Haz clic en una tarjeta para ver detalles completos y editar',
      'Usa los colores de prioridad para identificar rapidamente los urgentes',
    ],
  },
  {
    url: '/learn.html',
    name: 'Learning Coach',
    nameEs: 'Coach de Aprendizaje',
    description: 'Interactive study plans with spaced repetition, progress tracking, and 12 teaching personas.',
    descriptionEs: 'Planes de estudio interactivos con repeticion espaciada, seguimiento de progreso y 12 personas de ensenanza.',
    features: [
      'View all learning plans and topic progress',
      'Track daily/weekly study time and streaks',
      'See mastery levels per topic (needs work → mastered)',
      'Manage topic order and plan structure',
      'Real-time sync with Telegram /learn commands',
    ],
    featuresEs: [
      'Ver todos los planes de aprendizaje y progreso por tema',
      'Seguimiento de tiempo de estudio diario/semanal y rachas',
      'Ver niveles de dominio por tema (necesita trabajo → dominado)',
      'Gestionar orden de temas y estructura del plan',
      'Sincronizacion en tiempo real con comandos /learn de Telegram',
    ],
    whenToSuggest: [
      'User mentions learning, studying, or training',
      'User asks about progress on a learning plan',
      'User wants to review their study streaks',
    ],
    tips: [
      'Start a plan via Telegram (/learn plan Topic), then track visually here',
      'The spaced repetition system brings topics back at optimal intervals',
      'Try different teaching personas for varied learning experiences',
    ],
    tipsEs: [
      'Inicia un plan via Telegram (/learn plan Tema), luego sigue el progreso aqui',
      'El sistema de repeticion espaciada trae temas de vuelta en intervalos optimos',
      'Prueba diferentes personas de ensenanza para experiencias variadas',
    ],
  },
  {
    url: '/hub',
    name: 'Production Hub',
    nameEs: 'Centro de Produccion',
    description: 'Work order management, production tracking, bot/AI interface, alerts, and activity logging.',
    descriptionEs: 'Gestion de ordenes de trabajo, seguimiento de produccion, interfaz bot/IA, alertas y registro de actividad.',
    features: [
      'Live dashboard with KPIs (total WOs, in production, on hold, completed)',
      'Work order table with status, priority, progress tracking',
      'Built-in bot/AI chat interface for order commands',
      'Alerts and holds management',
      'Full activity log from all channels',
      'Dark/light theme toggle',
    ],
    featuresEs: [
      'Tablero en vivo con KPIs (OTs totales, en produccion, en espera, completadas)',
      'Tabla de ordenes de trabajo con estado, prioridad, seguimiento de progreso',
      'Interfaz chat bot/IA integrada para comandos de ordenes',
      'Gestion de alertas y retenciones',
      'Registro completo de actividad de todos los canales',
      'Alternancia de tema oscuro/claro',
    ],
    whenToSuggest: [
      'User asks about work orders, production orders, or WO status',
      'User mentions order tracking, production progress, or scheduling',
      'User asks about client orders or shipment status',
      'User needs to see production KPIs or pipeline',
    ],
    tips: [
      'Preview version — using sample data until real connections are wired',
      'Use the EN/ES toggle in the top bar to switch language',
      'The bot interface accepts the same commands as Telegram',
    ],
    tipsEs: [
      'Version de vista previa — usando datos de ejemplo hasta conectar datos reales',
      'Usa el boton EN/ES en la barra superior para cambiar idioma',
      'La interfaz del bot acepta los mismos comandos que Telegram',
    ],
  },
  {
    url: '/hub/bom',
    name: 'BOM & Shortage Resolution',
    nameEs: 'BOM e Inteligencia de Faltantes',
    description: 'Bill of materials management, shortage detection, alternative suggestions, and FIFO tracking.',
    descriptionEs: 'Gestion de lista de materiales, deteccion de faltantes, sugerencias de alternativas y seguimiento FIFO.',
    features: [
      'Component shortage alerts with severity levels',
      'Alternative material suggestions with compatibility scores',
      'Split-order FIFO tracking and allocation',
      'WO-scoped BOM override log (never modifies master BOM)',
      'Inventory snapshot from API (when connected)',
    ],
    featuresEs: [
      'Alertas de faltantes de componentes con niveles de severidad',
      'Sugerencias de materiales alternativos con puntuaciones de compatibilidad',
      'Seguimiento FIFO de ordenes divididas y asignacion',
      'Registro de modificaciones BOM por OT (nunca modifica el BOM maestro)',
      'Instantanea de inventario desde API (cuando esta conectada)',
    ],
    whenToSuggest: [
      'User mentions BOM, bill of materials, or components',
      'User asks about material shortages or out-of-stock items',
      'User discusses FIFO, split orders, or material allocation',
      'User needs to find alternative materials',
    ],
    tips: [
      'Shortage alerts show affected work orders — click to see resolution options',
      'BOM overrides are always WO-scoped — the master BOM is never changed',
      'The AI will NOT make override decisions — it presents options for your approval',
    ],
    tipsEs: [
      'Las alertas de faltantes muestran OTs afectadas — haz clic para ver opciones',
      'Las modificaciones BOM siempre son por OT — el BOM maestro nunca se cambia',
      'La IA NO tomara decisiones de modificacion — presenta opciones para tu aprobacion',
    ],
  },
  {
    url: '/sim',
    name: 'Production Line Simulator',
    nameEs: 'Simulador de Linea de Produccion',
    description: 'Discrete-event simulation with Monte Carlo analysis, MiniZinc optimization, and sensitivity analysis.',
    descriptionEs: 'Simulacion de eventos discretos con analisis Monte Carlo, optimizacion MiniZinc y analisis de sensibilidad.',
    features: [
      'Configure operations, schedule, demand, and breakdowns',
      'Run simulation with real-time results (8 output blocks)',
      'Monte Carlo N-replication with confidence intervals',
      'MiniZinc constraint optimization (operators, sequencing, scheduling)',
      'Sensitivity analysis with parameter sweeps',
      'Visual line layout with +/- operator buttons',
    ],
    featuresEs: [
      'Configurar operaciones, horario, demanda y averias',
      'Ejecutar simulacion con resultados en tiempo real (8 bloques de salida)',
      'Monte Carlo con N replicas e intervalos de confianza',
      'Optimizacion por restricciones MiniZinc (operadores, secuenciacion, programacion)',
      'Analisis de sensibilidad con barridos de parametros',
      'Diseno visual de linea con botones +/- de operadores',
    ],
    whenToSuggest: [
      'User discusses production line performance or throughput',
      'User asks about bottlenecks, efficiency, or capacity',
      'User wants to simulate scenarios or what-if analysis',
      'User mentions Monte Carlo, optimization, or sensitivity',
    ],
    tips: ['Start with the Operations tab to define your line, then run a simulation to see results'],
    tipsEs: ['Comienza con la pestana Operaciones para definir tu linea, luego ejecuta una simulacion'],
  },
  {
    url: '/capacity',
    name: 'Capacity Planning',
    nameEs: 'Planificacion de Capacidad',
    description: '12-step capacity calculation with scenarios, Monte Carlo, and ROI analysis.',
    descriptionEs: 'Calculo de capacidad en 12 pasos con escenarios, Monte Carlo y analisis ROI.',
    features: ['Setup (lines/calendar/demand)', 'Analysis with utilization charts', 'Heatmap (lines × periods)', 'What-if scenarios', 'Monte Carlo simulation', 'ROI calculator'],
    featuresEs: ['Configuracion (lineas/calendario/demanda)', 'Analisis con graficos de utilizacion', 'Mapa de calor (lineas × periodos)', 'Escenarios what-if', 'Simulacion Monte Carlo', 'Calculadora ROI'],
    whenToSuggest: ['User asks about capacity, utilization, or throughput planning', 'User discusses adding shifts, overtime, or new lines'],
    tips: ['Define lines and calendar first, then run analysis'],
    tipsEs: ['Define lineas y calendario primero, luego ejecuta el analisis'],
  },
  {
    url: '/sequence',
    name: 'Job Sequencer',
    nameEs: 'Secuenciador de Trabajos',
    description: '6 dispatching rules, genetic algorithm optimization, and interactive Gantt chart.',
    descriptionEs: '6 reglas de despacho, optimizacion por algoritmo genetico y diagrama Gantt interactivo.',
    features: ['FIFO/SPT/LPT/EDD/CR/SLACK dispatching rules', 'Side-by-side rule comparison', 'Genetic algorithm optimization', 'Interactive Gantt chart with due date markers'],
    featuresEs: ['Reglas de despacho FIFO/SPT/LPT/EDD/CR/SLACK', 'Comparacion lado a lado de reglas', 'Optimizacion por algoritmo genetico', 'Diagrama Gantt interactivo con marcadores de fecha limite'],
    whenToSuggest: ['User asks about job scheduling, sequencing, or order priority', 'User mentions makespan, lateness, or setup times'],
    tips: ['Add jobs and machines in Setup, then compare all 6 rules at once'],
    tipsEs: ['Agrega trabajos y maquinas en Configuracion, luego compara las 6 reglas a la vez'],
  },
  {
    url: '/vsm',
    name: 'Value Stream Mapping',
    nameEs: 'Mapeo de Flujo de Valor',
    description: 'Lean VSM with VA/NVA/BNVA classification, TIMWOODS waste analysis, and current vs future comparison.',
    descriptionEs: 'VSM Lean con clasificacion VA/NVA/BNVA, analisis de desperdicios TIMWOODS y comparacion actual vs futuro.',
    features: ['Process flow visualization with VA/NVA color coding', 'TIMWOODS waste analysis with Pareto chart', 'PCE gauge and breakdown', 'Current vs future state comparison'],
    featuresEs: ['Visualizacion de flujo de proceso con colores VA/NVA', 'Analisis TIMWOODS con diagrama Pareto', 'Indicador PCE y desglose', 'Comparacion estado actual vs futuro'],
    whenToSuggest: ['User mentions value stream, waste, lean, or process improvement', 'User asks about lead time, cycle time, or process efficiency'],
    tips: ['Define process steps with VA/NVA classification, then analyze for waste'],
    tipsEs: ['Define pasos del proceso con clasificacion VA/NVA, luego analiza desperdicios'],
  },
  {
    url: '/toc',
    name: 'Theory of Constraints',
    nameEs: 'Teoria de Restricciones',
    description: "Goldratt's TOC with CCR identification, Drum-Buffer-Rope, and throughput accounting.",
    descriptionEs: 'TOC de Goldratt con identificacion CCR, Tambor-Amortiguador-Cuerda y contabilidad de rendimiento.',
    features: ['Constraint (CCR) identification', 'Drum-Buffer-Rope scheduling', 'Throughput accounting (T, NP, ROI)', 'WIP gauges per work center'],
    featuresEs: ['Identificacion de restriccion (CCR)', 'Programacion Tambor-Amortiguador-Cuerda', 'Contabilidad de rendimiento (T, NP, ROI)', 'Indicadores WIP por centro de trabajo'],
    whenToSuggest: ['User mentions bottleneck, constraint, or TOC', 'User asks about throughput, WIP limits, or DBR scheduling'],
    tips: ['Define work centers with capacity data, then identify the CCR'],
    tipsEs: ['Define centros de trabajo con datos de capacidad, luego identifica el CCR'],
  },
  {
    url: '/conwip',
    name: 'CONWIP & Heijunka',
    nameEs: 'CONWIP y Heijunka',
    description: 'CONWIP token board and Heijunka production leveling.',
    descriptionEs: 'Tablero de tokens CONWIP y nivelacion de produccion Heijunka.',
    features: ['Visual token board with colored tokens per stage', 'Heijunka grid box with leveling gauge', 'Mix deviation analysis', 'Shift plan generation'],
    featuresEs: ['Tablero visual de tokens con tokens coloreados por etapa', 'Caja Heijunka con indicador de nivelacion', 'Analisis de desviacion de mezcla', 'Generacion de plan de turnos'],
    whenToSuggest: ['User mentions CONWIP, WIP limits, kanban cards, or production leveling', 'User asks about product mix or takt time'],
    tips: ['Set up stages and WIP limits, then visualize token flow'],
    tipsEs: ['Configura etapas y limites WIP, luego visualiza el flujo de tokens'],
  },
  {
    url: '/doe',
    name: 'Design of Experiments',
    nameEs: 'Diseno de Experimentos',
    description: 'Full factorial, fractional, Taguchi, Box-Behnken, and CCD designs with ANOVA.',
    descriptionEs: 'Disenos factorial completo, fraccionado, Taguchi, Box-Behnken y CCD con ANOVA.',
    features: ['5 design types with experiment matrix', 'ANOVA with F-test, p-values, contribution %', 'Main effects and interaction plots', 'Desirability optimization (multi-response)'],
    featuresEs: ['5 tipos de diseno con matriz experimental', 'ANOVA con prueba F, valores p, contribucion %', 'Graficos de efectos principales e interacciones', 'Optimizacion de deseabilidad (multi-respuesta)'],
    whenToSuggest: ['User mentions DOE, experiments, factorial design, or Taguchi', 'User asks about factor analysis, ANOVA, or response surface'],
    tips: ['Define factors and responses in the wizard, then generate and fill the matrix'],
    tipsEs: ['Define factores y respuestas en el asistente, luego genera y llena la matriz'],
  },
  {
    url: '/fsm',
    name: 'State Machine Simulator',
    nameEs: 'Simulador de Maquina de Estados',
    description: 'Manufacturing FSM with 9 states, PLC Structured Text export, and bridges to simulation/VSM/TOC.',
    descriptionEs: 'FSM de manufactura con 9 estados, exportacion PLC Texto Estructurado y puentes a simulacion/VSM/TOC.',
    features: ['9 manufacturing state types (idle, processing, queued, changeover, etc.)', '4 pre-built templates (CNC, Conveyor, AGV, Order Processing)', 'Visual state diagram with transition arrows', 'PLC Structured Text code export'],
    featuresEs: ['9 tipos de estado de manufactura (inactivo, procesando, en cola, cambio, etc.)', '4 plantillas pre-construidas (CNC, Transportador, AGV, Procesamiento de Ordenes)', 'Diagrama visual de estados con flechas de transicion', 'Exportacion de codigo PLC Texto Estructurado'],
    whenToSuggest: ['User mentions state machine, FSM, PLC, or machine states', 'User asks about machine availability, transitions, or downtime analysis'],
    tips: ['Start with a template (CNC Machine is a great starting point), then customize'],
    tipsEs: ['Comienza con una plantilla (Maquina CNC es un buen punto de partida), luego personaliza'],
  },
  {
    url: '/docs',
    name: 'Documentation Viewer',
    nameEs: 'Visor de Documentacion',
    description: 'In-app documentation browser with all guides, commands, and architecture diagrams.',
    descriptionEs: 'Navegador de documentacion en la app con todas las guias, comandos y diagramas de arquitectura.',
    features: ['All documentation in one place', 'Mermaid diagram rendering', 'Searchable content', 'Tab-based navigation'],
    featuresEs: ['Toda la documentacion en un solo lugar', 'Renderizado de diagramas Mermaid', 'Contenido buscable', 'Navegacion por pestanas'],
    whenToSuggest: ['User asks about documentation, help, or how things work', 'User needs reference material'],
    tips: ['Use the tabs to navigate between different doc sections'],
    tipsEs: ['Usa las pestanas para navegar entre diferentes secciones de documentacion'],
  },
];

// ── Prompt Generation ────────────────────────────────────────

/**
 * Build the web UI awareness prompt for injection into the system prompt.
 * This teaches clauded to proactively suggest web UIs in the right context.
 */
export function buildWebUIAwarenessPrompt(): string {
  const lines = WEB_UI_GUIDES.map((g) => {
    const triggers = g.whenToSuggest.join('; ');
    return `- **${g.url}** (${g.name}): ${g.description} → Suggest when: ${triggers}`;
  });

  return `## Web Dashboard Awareness — Proactive Suggestions

You have ${WEB_UI_GUIDES.length} web dashboards available. PROACTIVELY suggest the relevant dashboard when the conversation matches. Don't just list capabilities — guide the user to the visual tool.

Instead of: "I can help you with task management."
Say: "You can manage tasks visually at \`/board.html\` — it has drag-and-drop columns and priority colors. Want me to show you how it works?"

Instead of: "I have production simulation capabilities."
Say: "Open \`/sim\` in your browser — you can configure operations, run Monte Carlo simulations, and optimize with MiniZinc. Want a quick tour?"

Available dashboards:
${lines.join('\n')}

When a user asks "how do I use [dashboard]?" or "what can I do with [feature]?", provide the onboarding guidance: features, tips, and workflow. Always respond in the user's language.`;
}

/**
 * Get the onboarding guide for a specific web UI.
 * Called when user asks "how do I use /sim?" or "explain the board".
 */
export function getWebUIOnboarding(url: string, lang: 'en' | 'es' = 'en'): string | null {
  const guide = WEB_UI_GUIDES.find((g) => url.includes(g.url) || url.toLowerCase().includes(g.name.toLowerCase()));
  if (!guide) return null;

  const name = lang === 'es' ? guide.nameEs : guide.name;
  const desc = lang === 'es' ? guide.descriptionEs : guide.description;
  const features = lang === 'es' ? guide.featuresEs : guide.features;
  const tips = lang === 'es' ? guide.tipsEs : guide.tips;
  const header = lang === 'es' ? 'Guia de' : 'Guide for';
  const featLabel = lang === 'es' ? 'Funciones principales' : 'Key features';
  const tipsLabel = lang === 'es' ? 'Consejos' : 'Tips';

  const featureList = features.map((f) => `  - ${f}`).join('\n');
  const tipList = tips.map((t) => `  - ${t}`).join('\n');

  return `**${header} ${name}** (\`${guide.url}\`)

${desc}

**${featLabel}:**
${featureList}

**${tipsLabel}:**
${tipList}`;
}
