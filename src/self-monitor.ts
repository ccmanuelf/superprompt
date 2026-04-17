import type { AIResponse } from './providers/types.js';
import { logger } from './logger.js';
import { getKnex } from './db-knex.js';

/**
 * Self-monitoring system for AI response quality.
 *
 * Detects response quality issues and logs them for analysis.
 * Does NOT automatically retry (that's the caller's job) —
 * it provides signals that the caller can act on.
 *
 * Inspired by Superpowers verification-before-completion:
 * "Evidence before claims, always."
 */

/** Quality check result */
export interface QualityCheck {
  /** Whether the response passed all checks */
  passed: boolean;
  /** List of issues found */
  issues: QualityIssue[];
  /** Quality score 0-100 */
  score: number;
}

export interface QualityIssue {
  /** Issue type */
  type: 'empty' | 'too_short' | 'repetitive' | 'error_response' | 'hallucination_signal' | 'tool_failure';
  /** Human-readable description */
  message: string;
  /** Severity: info, warning, or error */
  severity: 'info' | 'warning' | 'error';
}

/** Minimum reasonable response length (chars) for non-trivial questions */
const MIN_RESPONSE_LENGTH = 20;

/** Maximum ratio of repeated phrases that indicates repetition */
const REPETITION_THRESHOLD = 0.4;

/** Patterns that indicate the AI is fabricating or uncertain */
const HALLUCINATION_SIGNALS = [
  // Contradicting itself
  /\b(actually|wait|correction|I was wrong|let me correct)\b.*\b(actually|wait|correction)\b/i,
  // Fabricated URLs (common pattern)
  /https?:\/\/(?:www\.)?example\.(com|org|net)/i,
  // Admitting lack of knowledge but then answering anyway
  /\b(I don't have|I cannot access|I'm not sure)\b.{0,100}\b(but|however|though)\b.{0,200}\b(the answer is|it's|they are)\b/i,
];

/** Patterns indicating the AI encountered a tool/system error */
const ERROR_PATTERNS = [
  /\bOllama error:/i,
  /\bError:\s*(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed)/i,
  /\btool.*(?:failed|error|unavailable)/i,
  /\bconnection refused\b/i,
  // rc.70 — the Ollama agentic-loop fallback text when MAX_ITERATIONS is
  // exhausted. Belt-and-suspenders alongside AIResponse.hitMaxIterations.
  /\[Max tool iterations reached\./,
  // rc.70 — raw tool-error JSON that sometimes surfaces as the final text
  /^\s*\{\s*"error"\s*:/,
];

/**
 * Check the quality of an AI response.
 * Returns a QualityCheck with issues found and a score.
 *
 * Exported for testing.
 */
export function checkResponseQuality(
  response: AIResponse,
  originalMessage: string,
): QualityCheck {
  const issues: QualityIssue[] = [];
  let score = 100;

  const text = response.text || '';

  // 1. Empty or null response
  if (!text || text.trim().length === 0) {
    issues.push({
      type: 'empty',
      message: 'AI returned an empty response',
      severity: 'error',
    });
    score = 0;
    return { passed: false, issues, score };
  }

  // 2. Suspiciously short response for non-trivial questions
  if (text.length < MIN_RESPONSE_LENGTH && originalMessage.length > 30) {
    issues.push({
      type: 'too_short',
      message: `Response is very short (${text.length} chars) for a substantial question`,
      severity: 'warning',
    });
    score -= 20;
  }

  // 3. Error response from provider (heavy penalty — this is a system failure)
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        type: 'error_response',
        message: 'Response contains a system/tool error',
        severity: 'error',
      });
      score -= 60;
      break;
    }
  }

  // 4. Hallucination signals
  for (const pattern of HALLUCINATION_SIGNALS) {
    if (pattern.test(text)) {
      issues.push({
        type: 'hallucination_signal',
        message: 'Response shows signs of uncertainty or fabrication',
        severity: 'warning',
      });
      score -= 15;
      break;
    }
  }

  // 5. Repetitive content (same phrase repeated many times)
  const repetitionRatio = detectRepetition(text);
  if (repetitionRatio > REPETITION_THRESHOLD) {
    issues.push({
      type: 'repetitive',
      message: `Response is ${Math.round(repetitionRatio * 100)}% repetitive content`,
      severity: 'warning',
    });
    score -= 25;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    passed: score >= 50,
    issues,
    score,
  };
}

/**
 * Detect repetitive content in text.
 * Returns a ratio 0-1 where higher means more repetitive.
 *
 * Splits into sentences and checks how many are near-duplicates.
 *
 * Exported for testing.
 */
export function detectRepetition(text: string): number {
  // Split into sentences
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 10);

  if (sentences.length < 3) return 0;

  // Count near-duplicate sentences
  let duplicates = 0;
  const seen = new Set<string>();

  for (const sentence of sentences) {
    // Normalize: remove extra spaces, take first 50 chars
    const normalized = sentence.replace(/\s+/g, ' ').slice(0, 50);
    if (seen.has(normalized)) {
      duplicates++;
    } else {
      seen.add(normalized);
    }
  }

  return duplicates / sentences.length;
}

/**
 * Log a quality check result to the database for analysis.
 */
export async function logQualityCheck(
  chatId: string,
  provider: string,
  score: number,
  issues: QualityIssue[],
): Promise<void> {
  if (issues.length === 0) return;

  const db = getKnex();

  // Ensure table exists (lazy migration)
  const exists = await db.schema.hasTable('quality_log');
  if (!exists) {
    await db.schema.createTable('quality_log', (t) => {
      t.increments('id').primary();
      t.text('chat_id').notNullable();
      t.text('provider').notNullable();
      t.integer('score').notNullable();
      t.text('issues').notNullable();
      t.integer('created_at').notNullable();
    });
  }

  await db('quality_log').insert({
    chat_id: chatId,
    provider,
    score,
    issues: JSON.stringify(issues),
    created_at: Date.now(),
  });

  if (score < 50) {
    logger.warn(
      { chatId, provider, score, issueCount: issues.length },
      'Low quality AI response detected',
    );
  } else {
    logger.debug(
      { chatId, provider, score, issueCount: issues.length },
      'Response quality check completed',
    );
  }
}

/**
 * Get quality statistics for a chat over a time period.
 *
 * Exported for testing.
 */
export async function getQualityStats(
  chatId: string,
  periodMs: number,
): Promise<{ avgScore: number; totalChecks: number; issueBreakdown: Record<string, number> }> {
  const db = getKnex();
  const since = Date.now() - periodMs;

  // Ensure table exists
  const exists = await db.schema.hasTable('quality_log');
  if (!exists) {
    await db.schema.createTable('quality_log', (t) => {
      t.increments('id').primary();
      t.text('chat_id').notNullable();
      t.text('provider').notNullable();
      t.integer('score').notNullable();
      t.text('issues').notNullable();
      t.integer('created_at').notNullable();
    });
  }

  const rows = await db('quality_log')
    .where('chat_id', chatId)
    .where('created_at', '>', since)
    .select('score', 'issues') as Array<{ score: number; issues: string }>;

  if (rows.length === 0) {
    return { avgScore: 100, totalChecks: 0, issueBreakdown: {} };
  }

  const avgScore = Math.round(rows.reduce((sum, r) => sum + r.score, 0) / rows.length);

  const issueBreakdown: Record<string, number> = {};
  for (const row of rows) {
    try {
      const issues = JSON.parse(row.issues) as QualityIssue[];
      for (const issue of issues) {
        issueBreakdown[issue.type] = (issueBreakdown[issue.type] || 0) + 1;
      }
    } catch { /* ignore parse errors */ }
  }

  return { avgScore, totalChecks: rows.length, issueBreakdown };
}
