import { logger } from './logger.js';

/**
 * Context budget management.
 *
 * Treats the context window as a scarce resource (Slate's "context-as-RAM" concept).
 * Estimates token usage, assigns priorities, and trims low-priority content
 * when approaching the limit.
 *
 * Token estimation: ~4 chars per token for English text (conservative).
 * This is an approximation — actual tokenization varies by model.
 */

/** Characters per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Default context window size in tokens (qwen3.5 = 32768) */
const DEFAULT_CONTEXT_TOKENS = 32768;

/** Reserve tokens for model output (don't fill context completely) */
const OUTPUT_RESERVE_TOKENS = 2048;

/** Priority levels for context components (higher = keep first) */
export enum ContextPriority {
  /** System prompt — always included, never trimmed */
  SYSTEM = 100,
  /** Current user message — always included */
  USER_MESSAGE = 90,
  /** Active skill prompt — always included when active */
  SKILL = 80,
  /** Quality rules + command list — always included */
  QUALITY_RULES = 70,
  /** Document capabilities prompt */
  DOC_CAPABILITIES = 60,
  /** Memory context (semantic memories) — high value, user-specific */
  MEMORY_SEMANTIC = 50,
  /** Episode summaries — compressed conversation context */
  EPISODES = 45,
  /** Memory context (episodic memories) — lower value than semantic */
  MEMORY_EPISODIC = 40,
  /** Recent chat history — most recent turns first */
  CHAT_HISTORY = 30,
  /** Older chat history — lowest priority, trimmed first */
  CHAT_HISTORY_OLD = 10,
}

/** A component of the context with its priority and content */
export interface ContextComponent {
  /** What this component is (for logging) */
  label: string;
  /** The text content */
  content: string;
  /** Priority — higher values are kept first when trimming */
  priority: ContextPriority;
  /** Whether this component can be trimmed (system prompt cannot) */
  trimmable: boolean;
}

/** Result of budget calculation */
export interface BudgetResult {
  /** Total estimated tokens used */
  totalTokens: number;
  /** Available tokens for output */
  availableForOutput: number;
  /** Whether the budget is exceeded (needs trimming) */
  overBudget: boolean;
  /** Per-component token estimates */
  components: Array<{ label: string; tokens: number; priority: number; trimmed: boolean }>;
  /** Percentage of context used */
  usagePercent: number;
}

/**
 * Estimate the number of tokens in a text string.
 * Uses a simple character-based heuristic (~4 chars per token).
 *
 * Exported for testing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Calculate the context budget for a set of components.
 * Returns the budget breakdown and whether trimming is needed.
 *
 * Exported for testing.
 */
export function calculateBudget(
  components: ContextComponent[],
  contextWindowTokens: number = DEFAULT_CONTEXT_TOKENS,
): BudgetResult {
  const maxInputTokens = contextWindowTokens - OUTPUT_RESERVE_TOKENS;

  const componentResults = components.map((c) => ({
    label: c.label,
    tokens: estimateTokens(c.content),
    priority: c.priority,
    trimmable: c.trimmable,
    trimmed: false,
  }));

  const totalTokens = componentResults.reduce((sum, c) => sum + c.tokens, 0);
  const overBudget = totalTokens > maxInputTokens;

  return {
    totalTokens,
    availableForOutput: Math.max(0, contextWindowTokens - totalTokens),
    overBudget,
    components: componentResults,
    usagePercent: Math.round((totalTokens / maxInputTokens) * 100),
  };
}

/**
 * Trim context components to fit within the token budget.
 * Removes content from lowest-priority trimmable components first.
 *
 * Returns the trimmed components and a log of what was trimmed.
 *
 * Exported for testing.
 */
export function trimToBudget(
  components: ContextComponent[],
  contextWindowTokens: number = DEFAULT_CONTEXT_TOKENS,
): { components: ContextComponent[]; trimLog: string[] } {
  const maxInputTokens = contextWindowTokens - OUTPUT_RESERVE_TOKENS;
  const trimLog: string[] = [];

  // Calculate current usage
  let totalTokens = components.reduce((sum, c) => sum + estimateTokens(c.content), 0);

  if (totalTokens <= maxInputTokens) {
    return { components, trimLog };
  }

  // Sort by priority ascending (lowest priority first = trim first)
  const sorted = [...components].sort((a, b) => a.priority - b.priority);
  const result = new Map(components.map((c) => [c.label, { ...c }]));

  for (const component of sorted) {
    if (totalTokens <= maxInputTokens) break;
    if (!component.trimmable) continue;

    const tokensBefore = estimateTokens(component.content);

    if (component.priority <= ContextPriority.CHAT_HISTORY_OLD) {
      // Oldest history: remove entirely
      result.get(component.label)!.content = '';
      totalTokens -= tokensBefore;
      trimLog.push(`Removed ${component.label} (${tokensBefore} tokens)`);
    } else if (component.priority <= ContextPriority.CHAT_HISTORY) {
      // Recent history: keep only last few turns
      const lines = component.content.split('\n');
      const keepLines = Math.max(4, Math.floor(lines.length / 3));
      const trimmed = lines.slice(-keepLines).join('\n');
      const tokensAfter = estimateTokens(trimmed);
      result.get(component.label)!.content = trimmed;
      totalTokens -= (tokensBefore - tokensAfter);
      trimLog.push(`Trimmed ${component.label}: ${tokensBefore} → ${tokensAfter} tokens`);
    } else if (component.priority <= ContextPriority.MEMORY_EPISODIC) {
      // Episodic memories: remove oldest entries
      const lines = component.content.split('\n').filter((l) => l.startsWith('- '));
      const keepCount = Math.max(1, Math.floor(lines.length / 2));
      const trimmed = lines.slice(0, keepCount).join('\n');
      const tokensAfter = estimateTokens(trimmed);
      result.get(component.label)!.content = trimmed;
      totalTokens -= (tokensBefore - tokensAfter);
      trimLog.push(`Trimmed ${component.label}: kept ${keepCount}/${lines.length} entries`);
    }
  }

  // Rebuild in original order
  const finalComponents = components.map((c) => result.get(c.label)!).filter((c) => c.content);

  if (trimLog.length > 0) {
    logger.info({ trimLog, finalTokens: totalTokens, budget: maxInputTokens }, 'Context trimmed to fit budget');
  }

  return { components: finalComponents, trimLog };
}

/**
 * Build a context budget report for the current message.
 * Useful for debugging and the /budget command.
 *
 * Exported for testing.
 */
export function formatBudgetReport(budget: BudgetResult): string {
  const lines = [`**Context Budget: ${budget.usagePercent}% used** (${budget.totalTokens} / ${DEFAULT_CONTEXT_TOKENS - OUTPUT_RESERVE_TOKENS} tokens)\n`];

  for (const c of budget.components.sort((a, b) => b.tokens - a.tokens)) {
    const bar = c.tokens > 0 ? '█'.repeat(Math.max(1, Math.round(c.tokens / 500))) : '';
    const status = c.trimmed ? ' ✂️' : '';
    lines.push(`${bar} ${c.label}: ${c.tokens} tokens${status}`);
  }

  lines.push(`\nAvailable for response: ${budget.availableForOutput} tokens`);

  if (budget.overBudget) {
    lines.push('⚠️ Context exceeds budget — lower-priority content will be trimmed.');
  }

  return lines.join('\n');
}
