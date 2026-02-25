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
}

export interface AIProvider {
  name: 'claude' | 'ollama';
  sendMessage(params: SendMessageParams): Promise<AIResponse>;
}
