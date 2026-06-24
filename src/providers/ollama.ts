import { Agent } from 'undici';
import { Ollama, type Message, type Tool } from 'ollama';
import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getToolDefinitions, executeTool } from './tools/index.js';
import { getOllamaTimeoutMs, buildOllamaTimeoutError } from '../circuit-breaker.js';

const MAX_HISTORY_TURNS = 20; // 20 turns = 40 messages (user + assistant)
const MAX_HISTORY_MESSAGES = MAX_HISTORY_TURNS * 2;

// rc.82 — cap idle model residency. Ollama's default is 5m; on a Mac
// running Docker + Speaches + Chrome, holding a 9GB model in RAM for
// 5m blows through available memory and pushes macOS into heavy swap.
// 3m is long enough that a back-and-forth conversation keeps the model
// warm, short enough that an abandoned turn reclaims RAM promptly.
const MODEL_KEEP_ALIVE = '3m';

// rc.72 — model-size-aware agentic ceilings. Small models hallucinate
// more and spiral longer in tool loops, so we tighten their leash:
// fewer iterations, lower temperature (less creativity-induced drift),
// and a num_predict cap to prevent runaway generations. Bigger models
// keep the generous defaults. Tier is resolved from the `parameter_size`
// returned by `ollama.list()` (e.g. "9.7B", "2.0B", "137M") and cached
// per-model for the process lifetime.
export interface ModelTier {
  maxIterations: number;
  numPredict?: number;
  temperature: number;
}

const DEFAULT_TIER: ModelTier = { maxIterations: 10, temperature: 0.7 };

/**
 * Parse Ollama's `parameter_size` string into billions-of-params as a
 * number. "9.7B" → 9.7, "137M" → 0.137. Unknown formats return
 * Number.POSITIVE_INFINITY so the caller treats the model as large
 * (no restrictions) — fail-open on unknown metadata.
 */
export function parseParameterSize(sizeStr: string | undefined | null): number {
  if (!sizeStr) return Number.POSITIVE_INFINITY;
  const match = sizeStr.trim().match(/^([\d.]+)\s*([BM])$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return match[2].toUpperCase() === 'B' ? n : n / 1000;
}

/**
 * Resolve agentic-loop knobs for a given model size in billions.
 *   ≤2B   → strict: 4 iterations, 512 token cap, temp 0.2
 *   ≤4B   → medium: 6 iterations, 1024 cap, temp 0.3
 *   >4B   → default: current 10 iterations, no cap, temp 0.7
 * Boundaries inclusive at the small end (2B fits in the strict tier).
 */
export function resolveModelTier(paramsInBillions: number): ModelTier {
  if (paramsInBillions <= 2) {
    return { maxIterations: 4, numPredict: 512, temperature: 0.2 };
  }
  if (paramsInBillions <= 4) {
    return { maxIterations: 6, numPredict: 1024, temperature: 0.3 };
  }
  return DEFAULT_TIER;
}

export const TOOL_MODEL_SYSTEM_PROMPT = `You are Luna (Inge Luna in Spanish), a helpful AI assistant. You have access to tools that let you interact with the system.

IMPORTANT: You DO have access to real-time web search via the web_search tool. When the user asks about current events, recent news, real-time data, or anything beyond your training cutoff, you MUST call web_search instead of saying you cannot access the internet. Never claim you lack internet access — you have it through your tools.

DELIVERABLE RULE (critical): If the user requests a specific output format — a PDF, DOCX, XLSX, PPTX, CSV, report, document, informe, reporte, archivo, or any downloadable file (English or Spanish) — calling \`generate_document\` is your REQUIRED primary action. Read the underlying data first via \`parse_file\` if needed, then call \`generate_document\`. Do NOT respond with analysis, suggestions, questions, or kanban proposals INSTEAD of the document. Generate the file first; a short summary may follow.

VERIFY BEFORE CONCLUDING: When a task requires producing a file or artifact, confirm it was actually created — the tool must return a file path or success — before you tell the user it is done. Never claim a deliverable exists if no tool confirmed it.

When the user asks you to do something that requires tools, use them. Don't say you can't do something if there's a tool that can help.

Available tools include: web_search, read_file, run_command, query_memory, save_memory, get_time, system_info, summarize_url, parse_file, generate_document, read_bot_logs, create_reminder, take_screenshot, kanban_manage, search_papers, manage_citations, review_report, github_list_repos, github_read_file, github_list_issues, github_list_prs, github_clone_repo, github_diff, github_commit_push, github_create_pr, render_list_services, render_deploy_status, render_get_logs, capacity_planning, job_sequencer, value_stream_map, toc_analysis, conwip_heijunka, design_of_experiments, state_machine_simulator, production_simulation, minizinc_optimize, line_balance, sigma_analysis, inventory_plan, spc_setup, fmea_manage, rca_manage.

IMPORTANT: When you identify tasks, ideas, or opportunities during conversation, proactively create kanban cards using kanban_manage. Default assignee is always "noted" (visible but unassigned). Only set assignee to "bot" or "me" when the user explicitly requests it.

Additional user-created tools may also be available. Check the tool list for the full set of tools you can use.

When you learn something important about the user, use save_memory to remember it.
When you need information from past conversations, use query_memory.

Always provide a final text response after using tools — don't end with just a tool call.

IMPORTANT: Always respond in the same language the user's latest message is written in. If they switch languages, you switch too — immediately, without being asked.`;

const CHAT_MODEL_SYSTEM_PROMPT = `You are Luna (Inge Luna in Spanish), a helpful AI assistant with strong reasoning capabilities. Be helpful, concise, and accurate.

For complex questions: Think through the key variables and trade-offs before answering. For recommendations: also state the strongest counter-argument. For vague requests: ask who the audience is and what format is most useful before generating content.

IMPORTANT: Always respond in the same language the user's latest message is written in. If they switch languages, you switch too — immediately, without being asked.`;

/**
 * Recovery guidance injected after a tool error so the model adapts instead of
 * blindly repeating the same failing call (Opportunity B2, from Self-Harness's
 * retained Qwen3.5 edits). The circuit breaker stops repetition at 3; this
 * redirects earlier, before the breaker trips.
 */
export function buildToolErrorRecoveryNote(toolName: string): string {
  return `The tool "${toolName}" returned an error. Inspect the error and change your approach — `
    + `do not call the same tool with the same arguments again. If you cannot recover, explain the `
    + `problem to the user instead of repeating the call.`;
}

/**
 * Heuristic to detect if a message likely needs tool calls.
 * Routes to tool model when detected, chat model otherwise.
 */
function shouldUseTools(message: string): boolean {
  const lower = message.toLowerCase();

  // Explicit tool requests
  if (/\b(use tools?|search for|search the web|read the file|run command|what time|system info|generate|create|export as|make a)\b/i.test(lower)) {
    return true;
  }

  // Questions that need live/current data (weather, news, prices, scores, etc.)
  if (/\b(weather|forecast|news|latest|current|today'?s|price of|stock|score)\b/i.test(lower) &&
      /\b(what|how|tell|show|give|is the|in |at )\b/i.test(lower)) {
    return true;
  }

  // Action verb + tool noun combination
  const actionVerbs =
    /\b(search|read|check|find|get|look\s*up|fetch|query|save|remember|run|execute|look|generate|create|export|build|make|produce|write)\b/;
  const toolNouns =
    /\b(file|url|web|time|date|memory|system|command|website|page|info|uptime|disk|document|spreadsheet|pdf|csv|xlsx|docx)\b/;

  if (actionVerbs.test(lower) && toolNouns.test(lower)) {
    return true;
  }

  return false;
}

/** Per-chat conversation history (in-memory) */
const chatHistories = new Map<string, Message[]>();

function getHistory(chatId: string): Message[] {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  return chatHistories.get(chatId)!;
}

function trimHistory(messages: Message[]): void {
  // Count only user/assistant pairs, not system/tool messages
  while (messages.length > MAX_HISTORY_MESSAGES) {
    messages.shift();
  }
}

export function clearOllamaHistory(chatId: string): void {
  chatHistories.delete(chatId);
}

/**
 * Replace the in-memory conversation history for a chat with the given
 * turns. Used by the router to rebuild Ollama context from chat_log
 * before each send so cross-provider turns are visible to the model
 * (rc.69 continuity bridge). Pass an empty array to effectively reset
 * — identical to clearOllamaHistory but explicit about intent.
 */
export function seedOllamaHistory(chatId: string, messages: Message[]): void {
  chatHistories.set(chatId, [...messages]);
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const;
  private client: Ollama;
  /** Cache of resolved tier per model name. Populated lazily via getModelTier(). */
  private tierCache = new Map<string, ModelTier>();

  constructor() {
    // Hard request timeout. The ollama SDK passes its own AbortSignal to
    // fetch (for its .abort() API), so a bare `init?.signal ??` fallback
    // never arms — we must compose our hard deadline with AbortSignal.any
    // so the request cannot hang past this budget.
    const timeoutMs = getOllamaTimeoutMs();
    const dispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const timeoutFetch: typeof fetch = (input, init) => {
      const hard = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, hard]) : hard;
      return fetch(input, {
        ...init,
        signal,
        // @ts-expect-error dispatcher is a valid undici option for Node's fetch
        dispatcher,
      });
    };
    this.client = new Ollama({
      host: config.OLLAMA_HOST,
      fetch: timeoutFetch,
    });
  }

  async listModels(): Promise<{ name: string; size: string; family: string }[]> {
    const response = await this.client.list();
    return response.models
      .filter((m) => !m.name.includes('nomic-embed-text'))
      .map((m) => ({
        name: m.name,
        size: m.details?.parameter_size || 'unknown',
        family: m.details?.family || 'unknown',
      }));
  }

  async modelExists(name: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.name === name);
  }

  /**
   * Resolve the agentic-loop tier for a model (cached). Failure-safe:
   * if /api/tags can't be reached or the model isn't listed, returns
   * the default tier (no restrictions). Small-model tuning is strictly
   * a quality-of-life feature — it must never block inference.
   */
  async getModelTier(model: string): Promise<ModelTier> {
    const cached = this.tierCache.get(model);
    if (cached) return cached;

    try {
      const models = await this.listModels();
      const entry = models.find((m) => m.name === model);
      const params = parseParameterSize(entry?.size);
      const tier = resolveModelTier(params);
      this.tierCache.set(model, tier);
      logger.debug(
        { model, paramSize: entry?.size, paramsInBillions: params, tier },
        'Ollama model tier resolved',
      );
      return tier;
    } catch (err) {
      logger.warn({ err, model }, 'Failed to resolve model tier, using default');
      return DEFAULT_TIER;
    }
  }

  /**
   * Names of models currently resident in Ollama's memory (/api/ps).
   * Returns the exact names as reported by the server — useful for
   * verifying that an unload actually freed memory.
   */
  async listLoadedModels(): Promise<string[]> {
    const response = await this.client.ps();
    return response.models.map((m) => m.name);
  }

  /**
   * Size in bytes of a loaded model, or 0 if not currently loaded.
   * Used to log how much memory an eviction actually freed.
   */
  async getLoadedModelSize(model: string): Promise<number> {
    const response = await this.client.ps();
    return response.models.find((m) => m.name === model)?.size ?? 0;
  }

  /**
   * Ask Ollama to release a model from memory immediately.
   * Implemented as an empty /api/generate with keep_alive=0 — Ollama
   * treats this as an eviction signal regardless of normal keep-alive.
   * Safe to call when the model isn't loaded (Ollama responds with an
   * empty generation and no-op on the runner). Errors are swallowed
   * with a warn so the caller can still proceed to verify via /api/ps.
   */
  async unloadModel(model: string): Promise<void> {
    try {
      await this.client.generate({
        model,
        prompt: '',
        keep_alive: 0,
      });
    } catch (err) {
      logger.warn({ err, model }, 'Ollama unload request failed (will verify via /api/ps)');
    }
  }

  /**
   * Ask Ollama to load a model into memory without generating any tokens.
   * Used by the voice-web greeting flow so the first user utterance after
   * connect doesn't eat a 2-3 min cold-load delay. Empty prompt + explicit
   * keep_alive — Ollama interprets this as "load and hold".
   *
   * Best-effort. Swallows errors because a warmup failure must never
   * block the session — the user can still chat, they just get the
   * original cold-load wait on their first turn.
   */
  async preloadModel(model: string, keepAlive: string = '10m'): Promise<boolean> {
    try {
      await this.client.generate({
        model,
        prompt: '',
        keep_alive: keepAlive,
      });
      logger.info({ model, keepAlive }, 'Ollama model preloaded');
      return true;
    } catch (err) {
      logger.warn({ err, model }, 'Ollama preload failed — user will see cold-load on first turn');
      return false;
    }
  }

  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { message, chatId, onTyping, allowedTools, modelOverride, images, skipTools, isVoice } = params;

    const useTools = skipTools ? false : shouldUseTools(message);
    const model = modelOverride
      ? modelOverride
      : useTools
        ? config.OLLAMA_TOOL_MODEL
        : config.OLLAMA_CHAT_MODEL;

    logger.info(
      { chatId, model, useTools },
      'Ollama routing decision',
    );

    const history = getHistory(chatId);

    // Add user message to history (with images if provided)
    const userMessage: Message = { role: 'user', content: message };
    if (images?.length) {
      userMessage.images = images;
    }
    history.push(userMessage);

    try {
      let result: AIResponse;

      // Filter tools by skill's allowedTools list
      const tools = getToolDefinitions(allowedTools || undefined);

      // rc.69: systemPromptAppend carries the cross-provider conversation
      // recap when the router detects a provider change. Fold it onto
      // the extra system prompt here so both run paths see it.
      const extraSystemPrompt = [params.systemPrompt, params.systemPromptAppend]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join('\n\n') || undefined;

      if (useTools) {
        result = await this.runAgenticLoop(
          chatId,
          model,
          history,
          tools,
          onTyping,
          extraSystemPrompt,
          isVoice,
        );
      } else {
        result = await this.runChatTurn(model, history, onTyping, extraSystemPrompt, isVoice);
      }

      trimHistory(history);
      return result;
    } catch (err) {
      // Remove the user message we just added if we fail
      history.pop();

      const isTimeout =
        err instanceof Error &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          /timeout|aborted|headers timeout|body timeout/i.test(err.message));

      if (isTimeout) {
        const timeoutMs = getOllamaTimeoutMs();
        logger.error({ err, model, timeoutMs }, 'Ollama request timed out');
        return {
          text: buildOllamaTimeoutError(timeoutMs, model),
          provider: 'ollama',
          model,
        };
      }

      logger.error({ err, model }, 'Ollama request failed');
      return {
        text: `Ollama error: ${err instanceof Error ? err.message : String(err)}`,
        provider: 'ollama',
        model,
      };
    }
  }

  private async runChatTurn(
    model: string,
    history: Message[],
    onTyping?: () => void,
    extraSystemPrompt?: string,
    isVoice?: boolean,
  ): Promise<AIResponse> {
    if (onTyping) onTyping();

    const systemContent = extraSystemPrompt
      ? `${CHAT_MODEL_SYSTEM_PROMPT}\n\n${extraSystemPrompt}`
      : CHAT_MODEL_SYSTEM_PROMPT;

    const messages: Message[] = [
      { role: 'system', content: systemContent },
      ...history,
    ];

    // rc.72: tier-aware generation options. Small models get a
    // tighter num_predict cap and lower temperature; voice mode still
    // takes the stricter 256-token ceiling.
    const tier = await this.getModelTier(model);
    const options: Record<string, unknown> = {
      num_ctx: 32768,
      temperature: tier.temperature,
    };
    if (isVoice) {
      options.num_predict = 256;
    } else if (tier.numPredict !== undefined) {
      options.num_predict = tier.numPredict;
    }

    const response = await this.client.chat({
      model,
      messages,
      stream: false,
      think: true,
      options,
      keep_alive: MODEL_KEEP_ALIVE,
    });

    const assistantMsg: Message = {
      role: 'assistant',
      content: response.message.content,
    };
    history.push(assistantMsg);

    return {
      text: response.message.content || null,
      provider: 'ollama',
      model,
      thinkingContent: (response.message as Message & { thinking?: string }).thinking || undefined,
    };
  }

  private async runAgenticLoop(
    chatId: string,
    model: string,
    history: Message[],
    tools: Tool[],
    onTyping?: () => void,
    extraSystemPrompt?: string,
    isVoice?: boolean,
  ): Promise<AIResponse> {
    const systemContent = extraSystemPrompt
      ? `${TOOL_MODEL_SYSTEM_PROMPT}\n\n${extraSystemPrompt}`
      : TOOL_MODEL_SYSTEM_PROMPT;

    // Build message list with system prompt
    const messages: Message[] = [
      { role: 'system', content: systemContent },
      ...history,
    ];

    // rc.72: tier gates the loop ceiling and per-request options. A 2B
    // model that spirals for 10 iterations does more damage than a 2B
    // that bails at 4 and prompts the user to upgrade model.
    const tier = await this.getModelTier(model);

    let iterations = 0;
    const toolsUsedSet = new Set<string>();
    let toolErrorCount = 0;
    let thinkingContent: string | undefined;
    const generatedFiles: { path: string; filename: string; mimeType: string }[] = [];
    let kanbanToolCalled = false;

    // Circuit breaker — detects stagnation, repetition, and cascading errors
    const { CircuitBreaker } = await import('../circuit-breaker.js');
    const breaker = new CircuitBreaker();

    while (iterations < tier.maxIterations && breaker.state !== 'open') {
      iterations++;

      if (onTyping) onTyping();

      logger.debug(
        { iteration: iterations, model },
        'Agentic loop iteration',
      );

      const agenticOptions: Record<string, unknown> = {
        num_ctx: 32768,
        temperature: tier.temperature,
      };
      if (isVoice) {
        agenticOptions.num_predict = 256;
      } else if (tier.numPredict !== undefined) {
        agenticOptions.num_predict = tier.numPredict;
      }

      const response = await this.client.chat({
        model,
        messages,
        tools,
        stream: false,
        think: true,
        options: agenticOptions,
        keep_alive: MODEL_KEEP_ALIVE,
      });

      const msg = response.message;

      // Capture thinking content from first iteration
      if (iterations === 1) {
        thinkingContent = (msg as Message & { thinking?: string }).thinking || undefined;
      }

      // Add assistant response to conversation
      messages.push(msg);

      // If no tool calls, we're done
      if (!msg.tool_calls?.length) {
        let finalText = msg.content || null;

        // If kanban_manage tool was called during this loop, strip any kanban
        // JSON blocks from the response text to prevent double card creation
        if (kanbanToolCalled && finalText) {
          finalText = finalText.replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"kanban_action"\s*:[\s\S]*?\}\s*\n?\s*```/g, '').trim() || finalText;
        }

        // Also add to persistent history
        history.push({
          role: 'assistant',
          content: finalText || '',
        });

        return {
          text: finalText,
          provider: 'ollama',
          model,
          thinkingContent,
          generatedFiles: generatedFiles.length ? generatedFiles : undefined,
          toolsUsed: toolsUsedSet.size > 0 ? [...toolsUsedSet] : undefined,
          toolErrorCount: toolErrorCount > 0 ? toolErrorCount : undefined,
        };
      }

      // Execute each tool call
      for (const toolCall of msg.tool_calls) {
        const toolName = toolCall.function.name;
        toolsUsedSet.add(toolName);
        const toolArgs = (toolCall.function.arguments ?? {}) as Record<string, unknown>;

        logger.debug(
          { tool: toolName, args: toolArgs, iteration: iterations },
          'Executing tool call',
        );

        // Circuit breaker: check before execution
        const breakerCheck = breaker.shouldAllowExecution(toolName, toolArgs);
        if (!breakerCheck.allow) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ status: 'circuit_breaker', message: breakerCheck.reason }),
          });
          continue;
        }

        if (toolName === 'kanban_manage') kanbanToolCalled = true;
        const result = await executeTool(toolName, toolArgs, chatId);

        // SA4: Handle policy confirmation — tool was blocked pending user confirmation
        if (result && (result as Record<string, unknown>)._confirmation_required) {
          const prompt = (result as Record<string, unknown>)._confirmation_prompt as string;

          // Store pending confirmation so platform handler can intercept user response
          const { setPendingConfirmation } = await import('../policy-engine.js');
          setPendingConfirmation(chatId, toolName, toolArgs);

          messages.push({
            role: 'tool',
            content: JSON.stringify({
              status: 'confirmation_required',
              message: prompt,
              tool: toolName,
            }),
          });
          continue; // Skip further processing for this tool call
        }

        // Capture generated files for the platform layer to send
        if (result && typeof result === 'object') {
          if ('__docgen' in result) {
            const docResult = result as { path: string; filename: string; mimeType: string };
            generatedFiles.push({
              path: docResult.path,
              filename: docResult.filename,
              mimeType: docResult.mimeType,
            });
          } else if ('filepath' in result && typeof (result as Record<string, unknown>).filepath === 'string') {
            // Screenshot or other file-producing tools
            const fileResult = result as { filepath: string; filename: string };
            generatedFiles.push({
              path: fileResult.filepath,
              filename: fileResult.filename || 'screenshot.png',
              mimeType: 'image/png',
            });
          }
        }

        messages.push({
          role: 'tool',
          content: JSON.stringify(result),
        });

        // rc.70: track tool errors for failed-workflow detection.
        // A result with an `error` key, or whose content starts with
        // the "Access denied"/error pattern, counts as a failure.
        if (result && typeof result === 'object' && 'error' in result) {
          toolErrorCount++;
          // B2: steer the model to adapt rather than repeat the failing call.
          messages.push({ role: 'system', content: buildToolErrorRecoveryNote(toolName) });
        }

        // Circuit breaker: record result for pattern detection
        breaker.recordResult(toolName, toolArgs, result);
        // Pack tuner recording moved to executeTool() — covers both providers
      }

      // Circuit breaker: record iteration end for stagnation detection
      breaker.recordIterationEnd(msg.content?.length ?? 0);
    }

    // Max iterations reached (tier-dependent; 4 for small models, 10 default)
    logger.warn(
      { chatId, model, iterations: tier.maxIterations, tier },
      'Agentic loop hit max iterations',
    );

    const lastMsg = messages.at(-1);
    const fallbackText =
      lastMsg?.content || '[Max tool iterations reached. Please try a simpler request.]';

    history.push({
      role: 'assistant',
      content: fallbackText,
    });

    return {
      text: fallbackText,
      provider: 'ollama',
      model,
      thinkingContent,
      generatedFiles: generatedFiles.length ? generatedFiles : undefined,
      toolsUsed: toolsUsedSet.size > 0 ? [...toolsUsedSet] : undefined,
      hitMaxIterations: true,
      toolErrorCount: toolErrorCount > 0 ? toolErrorCount : undefined,
    };
  }
}
