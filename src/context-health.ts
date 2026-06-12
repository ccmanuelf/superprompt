/**
 * Context Health Monitoring — detect conversation degradation.
 *
 * Tracks conversation quality indicators and proactively suggests
 * fresh starts when degradation is detected. Works for both providers.
 *
 * Inspired by iannuttall/ralph's context health indicators
 * (green/yellow/red based on capacity and error patterns).
 *
 * Indicators:
 * 1. Conversation length (message count)
 * 2. Error frequency (tool errors, low quality responses)
 * 3. Repetition detection (user asking same thing multiple times)
 * 4. Response quality trend (declining scores over recent messages)
 */

// ── Types ────────────────────────────────────────────────────

export type HealthStatus = 'green' | 'yellow' | 'red';

export interface HealthReport {
  status: HealthStatus;
  messageCount: number;
  errorCount: number;
  repetitionCount: number;
  avgQualityScore: number;
  suggestion?: string;
}

interface ChatHealth {
  messages: number;
  errors: number;
  recentQueries: string[];
  qualityScores: number[];
  lastReportedAt: number;
}

// ── Configuration ────────────────────────────────────────────

export interface HealthConfig {
  /** Messages before yellow warning */
  yellowThreshold: number;
  /** Messages before red warning */
  redThreshold: number;
  /** Max errors in window before yellow */
  errorYellowThreshold: number;
  /** Max errors in window before red */
  errorRedThreshold: number;
  /** Similarity threshold for repetition (0-1) */
  repetitionSimilarity: number;
  /** Minimum messages before health checks activate */
  minMessagesForCheck: number;
  /** Cooldown between health suggestions (ms) */
  suggestionCooldownMs: number;
}

const DEFAULT_CONFIG: HealthConfig = {
  yellowThreshold: 30,
  redThreshold: 50,
  errorYellowThreshold: 3,
  errorRedThreshold: 6,
  repetitionSimilarity: 0.7,
  minMessagesForCheck: 10,
  suggestionCooldownMs: 10 * 60 * 1000, // 10 minutes
};

// ── Context Health Monitor ───────────────────────────────────

export class ContextHealthMonitor {
  private chats = new Map<string, ChatHealth>();
  private config: HealthConfig;

  constructor(config?: Partial<HealthConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a message exchange for a chat.
   * Call after every user message + AI response.
   */
  recordMessage(chatId: string, userMessage: string, qualityScore?: number): void {
    let health = this.chats.get(chatId);
    if (!health) {
      health = { messages: 0, errors: 0, recentQueries: [], qualityScores: [], lastReportedAt: 0 };
      this.chats.set(chatId, health);
    }

    health.messages++;

    // Track recent queries for repetition detection (keep last 10)
    const normalized = userMessage.toLowerCase().trim().slice(0, 200);
    health.recentQueries.push(normalized);
    if (health.recentQueries.length > 10) health.recentQueries.shift();

    // Track quality scores (keep last 10)
    if (qualityScore !== undefined) {
      health.qualityScores.push(qualityScore);
      if (health.qualityScores.length > 10) health.qualityScores.shift();
    }
  }

  /**
   * Record an error (tool failure, low quality, etc.).
   */
  recordError(chatId: string): void {
    const health = this.chats.get(chatId);
    if (health) health.errors++;
  }

  /**
   * Get health report for a chat.
   */
  getHealth(chatId: string): HealthReport {
    const health = this.chats.get(chatId);
    if (!health) {
      return { status: 'green', messageCount: 0, errorCount: 0, repetitionCount: 0, avgQualityScore: 100 };
    }

    const repetitions = this.countRepetitions(health.recentQueries);
    const avgQuality = health.qualityScores.length > 0
      ? health.qualityScores.reduce((a, b) => a + b, 0) / health.qualityScores.length
      : 100;

    let status: HealthStatus = 'green';

    // Check message count
    if (health.messages >= this.config.redThreshold) status = 'red';
    else if (health.messages >= this.config.yellowThreshold) status = 'yellow';

    // Check error count (can upgrade status)
    if (health.errors >= this.config.errorRedThreshold && status !== 'red') status = 'red';
    else if (health.errors >= this.config.errorYellowThreshold && status === 'green') status = 'yellow';

    // Check repetitions (sign of confusion)
    if (repetitions >= 3 && status === 'green') status = 'yellow';

    // Check declining quality trend
    if (health.qualityScores.length >= 5) {
      const recentAvg = health.qualityScores.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const olderAvg = health.qualityScores.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(1, health.qualityScores.length - 3);
      if (recentAvg < olderAvg * 0.7 && status === 'green') status = 'yellow';
    }

    return {
      status,
      messageCount: health.messages,
      errorCount: health.errors,
      repetitionCount: repetitions,
      avgQualityScore: Math.round(avgQuality),
    };
  }

  /**
   * Check if a health suggestion should be shown to the user.
   * Returns bilingual suggestion or null if not needed.
   */
  checkAndSuggest(chatId: string): string | null {
    const health = this.chats.get(chatId);
    if (!health || health.messages < this.config.minMessagesForCheck) return null;

    // Cooldown — don't spam suggestions
    const now = Date.now();
    if (now - health.lastReportedAt < this.config.suggestionCooldownMs) return null;

    const report = this.getHealth(chatId);

    if (report.status === 'red') {
      health.lastReportedAt = now;
      return buildHealthSuggestion('red', report);
    }

    if (report.status === 'yellow') {
      health.lastReportedAt = now;
      return buildHealthSuggestion('yellow', report);
    }

    return null;
  }

  /**
   * Reset health tracking for a chat (on /newchat).
   */
  resetChat(chatId: string): void {
    this.chats.delete(chatId);
  }

  /**
   * Format health status for display (bilingual).
   */
  formatHealth(chatId: string): string {
    const report = this.getHealth(chatId);
    const emoji = { green: '🟢', yellow: '🟡', red: '🔴' }[report.status];

    return [
      `[EN] Context health: ${emoji} ${report.status.toUpperCase()}`,
      `  Messages: ${report.messageCount}`,
      `  Errors: ${report.errorCount}`,
      `  Repetitions: ${report.repetitionCount}`,
      `  Avg quality: ${report.avgQualityScore}/100`,
      `[ES] Salud del contexto: ${emoji} ${report.status.toUpperCase()}`,
      `  Mensajes: ${report.messageCount}`,
      `  Errores: ${report.errorCount}`,
      `  Repeticiones: ${report.repetitionCount}`,
      `  Calidad promedio: ${report.avgQualityScore}/100`,
    ].join('\n');
  }

  // ── Internal ───────────────────────────────────────────────

  private countRepetitions(queries: string[]): number {
    let reps = 0;
    for (let i = 1; i < queries.length; i++) {
      if (this.isSimilar(queries[i], queries[i - 1])) reps++;
    }
    return reps;
  }

  private isSimilar(a: string, b: string): boolean {
    if (a === b) return true;
    // Simple word overlap similarity
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    if (wordsA.size === 0 || wordsB.size === 0) return false;
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return intersection / union >= this.config.repetitionSimilarity;
  }
}

// ── Suggestion Builder ───────────────────────────────────────

function buildHealthSuggestion(level: 'yellow' | 'red', report: HealthReport): string {
  if (level === 'red') {
    return [
      `[EN] ⚠️ Context health is degraded (${report.messageCount} messages, ${report.errorCount} errors).`,
      `This conversation is very long — response quality may be declining.`,
      `Consider starting fresh with /newchat. Your memories and skills are preserved.`,
      `[ES] ⚠️ La salud del contexto esta degradada (${report.messageCount} mensajes, ${report.errorCount} errores).`,
      `Esta conversacion es muy larga — la calidad de las respuestas puede estar disminuyendo.`,
      `Considera empezar de nuevo con /newchat. Tus memorias y habilidades se preservan.`,
    ].join('\n');
  }

  return [
    `[EN] 💡 This conversation is getting long (${report.messageCount} messages).`,
    `If responses seem less focused, try /newchat for a fresh start. Memories are preserved.`,
    `[ES] 💡 Esta conversacion se esta alargando (${report.messageCount} mensajes).`,
    `Si las respuestas parecen menos enfocadas, prueba /newchat para empezar de nuevo. Las memorias se preservan.`,
  ].join('\n');
}

// ── Singleton ────────────────────────────────────────────────

let instance: ContextHealthMonitor | null = null;

export function getContextHealthMonitor(): ContextHealthMonitor {
  if (!instance) {
    instance = new ContextHealthMonitor();
  }
  return instance;
}
