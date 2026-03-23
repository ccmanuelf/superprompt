import { Agent } from 'undici';
import { Ollama, type Message, type Tool } from 'ollama';
import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getToolDefinitions, executeTool } from './tools/index.js';

const MAX_ITERATIONS = 10;
const MAX_HISTORY_TURNS = 20; // 20 turns = 40 messages (user + assistant)
const MAX_HISTORY_MESSAGES = MAX_HISTORY_TURNS * 2;

const TOOL_MODEL_SYSTEM_PROMPT = `You are clauded, a helpful AI assistant. You have access to tools that let you interact with the system.

IMPORTANT: You DO have access to real-time web search via the web_search tool. When the user asks about current events, recent news, real-time data, or anything beyond your training cutoff, you MUST call web_search instead of saying you cannot access the internet. Never claim you lack internet access — you have it through your tools.

When the user asks you to do something that requires tools, use them. Don't say you can't do something if there's a tool that can help.

Available built-in tools: web_search, read_file, run_command, query_memory, save_memory, get_time, system_info, summarize_url, parse_file, generate_document, read_bot_logs, create_reminder, github_list_repos, github_read_file, github_list_issues, github_list_prs, github_clone_repo, github_diff, github_commit_push, github_create_pr, render_list_services, render_deploy_status, render_get_logs, take_screenshot, kanban_manage, search_papers, manage_citations, review_report.

IMPORTANT: When you identify tasks, ideas, or opportunities during conversation, proactively create kanban cards using kanban_manage. Default assignee is always "noted" (visible but unassigned). Only set assignee to "bot" or "me" when the user explicitly requests it.

Additional user-created tools may also be available. Check the tool list for the full set of tools you can use.

When you learn something important about the user, use save_memory to remember it.
When you need information from past conversations, use query_memory.

Always provide a final text response after using tools — don't end with just a tool call.

IMPORTANT: Always respond in the same language the user's latest message is written in. If they switch languages, you switch too — immediately, without being asked.`;

const CHAT_MODEL_SYSTEM_PROMPT = `You are clauded, a helpful AI assistant with strong reasoning capabilities. Be helpful, concise, and accurate.

IMPORTANT: Always respond in the same language the user's latest message is written in. If they switch languages, you switch too — immediately, without being asked.`;

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

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const;
  private client: Ollama;

  constructor() {
    // Custom fetch with 10-minute timeout.
    // Node's built-in undici has a default headersTimeout of ~5min which
    // causes premature timeout on slow Ollama inference. Use explicit Agent.
    const dispatcher = new Agent({
      headersTimeout: 600_000,
      bodyTimeout: 600_000,
    });

    const timeoutFetch: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(600_000),
        // @ts-expect-error dispatcher is a valid undici option for Node's fetch
        dispatcher,
      });
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

      if (useTools) {
        result = await this.runAgenticLoop(
          chatId,
          model,
          history,
          tools,
          onTyping,
          params.systemPrompt,
          isVoice,
        );
      } else {
        result = await this.runChatTurn(model, history, onTyping, params.systemPrompt, isVoice);
      }

      trimHistory(history);
      return result;
    } catch (err) {
      // Remove the user message we just added if we fail
      history.pop();

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

    const options: Record<string, unknown> = { num_ctx: 32768 };
    if (isVoice) options.num_predict = 256;

    const response = await this.client.chat({
      model,
      messages,
      stream: false,
      think: true,
      options,
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

    let iterations = 0;
    let thinkingContent: string | undefined;
    const generatedFiles: { path: string; filename: string; mimeType: string }[] = [];
    let kanbanToolCalled = false;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (onTyping) onTyping();

      logger.debug(
        { iteration: iterations, model },
        'Agentic loop iteration',
      );

      const agenticOptions: Record<string, unknown> = { num_ctx: 32768 };
      if (isVoice) agenticOptions.num_predict = 256;

      const response = await this.client.chat({
        model,
        messages,
        tools,
        stream: false,
        think: true,
        options: agenticOptions,
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
        };
      }

      // Execute each tool call
      for (const toolCall of msg.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = (toolCall.function.arguments ?? {}) as Record<string, unknown>;

        logger.debug(
          { tool: toolName, args: toolArgs, iteration: iterations },
          'Executing tool call',
        );

        if (toolName === 'kanban_manage') kanbanToolCalled = true;
        const result = await executeTool(toolName, toolArgs, chatId);

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
      }
    }

    // Max iterations reached
    logger.warn(
      { chatId, iterations: MAX_ITERATIONS },
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
    };
  }
}
