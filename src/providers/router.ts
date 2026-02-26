import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider, clearOllamaHistory } from './ollama.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getSession,
  setSession,
  updateSessionProvider,
  clearSession,
} from '../db.js';

const LANGUAGE_HINT = 'Always respond in the same language the user\'s latest message is written in. If they switch languages, you switch too — immediately, without being asked.';

export class ProviderRouter {
  private claude: ClaudeProvider;
  private ollama: OllamaProvider;

  constructor() {
    this.claude = new ClaudeProvider();
    this.ollama = new OllamaProvider();
  }

  /**
   * Get the active provider for a chat.
   * Priority: per-chat override (from DB) > default from config.
   */
  private getProviderForChat(chatId: string): AIProvider {
    const session = getSession(chatId);
    const providerName = session?.provider || config.AI_PROVIDER;

    if (providerName === 'ollama') {
      return this.ollama;
    }
    return this.claude;
  }

  /**
   * Send a message through the appropriate provider.
   * Handles session management (session ID persistence for Claude).
   */
  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { chatId } = params;
    const provider = this.getProviderForChat(chatId);

    // Load existing session ID for Claude
    const session = getSession(chatId);
    const sessionId =
      provider.name === 'claude' ? session?.session_id : undefined;

    logger.info(
      { chatId, provider: provider.name, hasSession: !!sessionId },
      'Routing message',
    );

    // Inject language hint for Claude (Ollama has it in its own system prompts)
    const systemPrompt = provider.name === 'claude'
      ? [params.systemPrompt, LANGUAGE_HINT].filter(Boolean).join('\n\n')
      : params.systemPrompt;

    const response = await provider.sendMessage({
      ...params,
      sessionId,
      systemPrompt,
    });

    // Handle stale Claude session — clear and retry without --resume
    if (response.staleSession && sessionId) {
      logger.warn({ chatId, sessionId }, 'Stale Claude session detected, retrying without --resume');
      clearSession(chatId);

      const retryResponse = await provider.sendMessage({
        ...params,
        sessionId: undefined,
        systemPrompt,
      });

      // Persist new session ID from retry
      if (retryResponse.newSessionId) {
        setSession(chatId, retryResponse.newSessionId, provider.name);
      }

      return retryResponse;
    }

    // Persist new session ID for Claude
    if (response.newSessionId) {
      setSession(chatId, response.newSessionId, provider.name);
    }

    return response;
  }

  /**
   * Switch the provider for a chat.
   * Returns the new provider name.
   */
  switchProvider(chatId: string, providerName: string): string {
    const normalized = providerName.toLowerCase().trim();

    if (normalized !== 'claude' && normalized !== 'ollama') {
      return `Unknown provider "${providerName}". Use "claude" or "ollama".`;
    }

    const session = getSession(chatId);
    if (session) {
      updateSessionProvider(chatId, normalized);
    } else {
      setSession(chatId, '', normalized);
    }

    logger.info({ chatId, provider: normalized }, 'Switched provider');
    return normalized;
  }

  /**
   * Start a new chat session.
   * Clears the session from DB and Ollama history.
   */
  newChat(chatId: string): void {
    clearSession(chatId);
    clearOllamaHistory(chatId);
    logger.info({ chatId }, 'New chat started');
  }

  /**
   * Get the current provider name for a chat.
   */
  getProviderName(chatId: string): string {
    const session = getSession(chatId);
    return session?.provider || config.AI_PROVIDER;
  }
}
