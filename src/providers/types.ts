export interface SendMessageParams {
  message: string;
  sessionId?: string;
  chatId: string;
  systemPrompt?: string;
  onTyping?: () => void;
}

export interface AIResponse {
  text: string | null;
  newSessionId?: string;
  provider: 'claude' | 'ollama';
  model?: string;
  thinkingContent?: string;
  /** Set when Claude CLI reports a stale/missing session ID */
  staleSession?: boolean;
}

export interface AIProvider {
  name: 'claude' | 'ollama';
  sendMessage(params: SendMessageParams): Promise<AIResponse>;
}
