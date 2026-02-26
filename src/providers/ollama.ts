import { Ollama, type Message, type Tool } from 'ollama';
import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { toolDefinitions, executeTool } from './tools/index.js';

const MAX_ITERATIONS = 10;
const MAX_HISTORY_TURNS = 20; // 20 turns = 40 messages (user + assistant)
const MAX_HISTORY_MESSAGES = MAX_HISTORY_TURNS * 2;

const TOOL_MODEL_SYSTEM_PROMPT = `You are clauded, a helpful AI assistant. You have access to tools that let you interact with the system.

When the user asks you to do something that requires tools, use them. Don't say you can't do something if there's a tool that can help.

Available tools: web_search, read_file, run_command, query_memory, save_memory, get_time, system_info, summarize_url.

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

  const actionVerbs =
    /\b(search|read|check|find|get|look\s*up|fetch|query|save|remember|run|execute|look)\b/;
  const toolNouns =
    /\b(file|url|web|time|date|memory|system|command|website|page|info|uptime|disk)\b/;

  // Explicit tool requests
  if (/\b(use tools?|search for|read the file|run command|what time|system info)\b/i.test(lower)) {
    return true;
  }

  // Action verb + tool noun combination
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
    // Custom fetch with 10-minute timeout (model loading can be slow)
    const timeoutFetch: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(600_000),
      });
    this.client = new Ollama({
      host: config.OLLAMA_HOST,
      fetch: timeoutFetch,
    });
  }

  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { message, chatId, onTyping } = params;

    const useTools = shouldUseTools(message);
    const model = useTools
      ? config.OLLAMA_TOOL_MODEL
      : config.OLLAMA_CHAT_MODEL;

    logger.debug(
      { chatId, model, useTools },
      'Ollama routing decision',
    );

    const history = getHistory(chatId);

    // Add user message to history
    history.push({ role: 'user', content: message });

    try {
      let result: AIResponse;

      if (useTools) {
        result = await this.runAgenticLoop(
          chatId,
          model,
          history,
          toolDefinitions,
          onTyping,
        );
      } else {
        result = await this.runChatTurn(model, history, onTyping);
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
  ): Promise<AIResponse> {
    if (onTyping) onTyping();

    const messages: Message[] = [
      { role: 'system', content: CHAT_MODEL_SYSTEM_PROMPT },
      ...history,
    ];

    const response = await this.client.chat({
      model,
      messages,
      stream: false,
      think: true,
      options: { num_ctx: 32768 },
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
  ): Promise<AIResponse> {
    // Build message list with system prompt
    const messages: Message[] = [
      { role: 'system', content: TOOL_MODEL_SYSTEM_PROMPT },
      ...history,
    ];

    let iterations = 0;
    let thinkingContent: string | undefined;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (onTyping) onTyping();

      logger.debug(
        { iteration: iterations, model },
        'Agentic loop iteration',
      );

      const response = await this.client.chat({
        model,
        messages,
        tools,
        stream: false,
        think: true,
        options: { num_ctx: 32768 },
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
        // Also add to persistent history
        history.push({
          role: 'assistant',
          content: msg.content,
        });

        return {
          text: msg.content || null,
          provider: 'ollama',
          model,
          thinkingContent,
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

        const result = await executeTool(toolName, toolArgs, chatId);

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
    };
  }
}
