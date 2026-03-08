import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider, clearOllamaHistory } from './ollama.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getSession,
  setSession,
  updateSessionProvider,
  updateSessionOllamaModel,
  clearSession,
} from '../db.js';
import { getSkillSystemPrompt, getSkillAllowedTools } from '../skills.js';

const LANGUAGE_HINT = 'Always respond in the same language the user\'s latest message is written in. If they switch languages, you switch too — immediately, without being asked.';

/**
 * Claude-specific prompt that teaches it about document capabilities.
 * The platform layer parses uploaded files and injects their text into messages,
 * and detects DocGenRequest JSON blocks in responses to generate real files.
 * Claude just needs to know the JSON schema to trigger document generation.
 */
const CLAUDE_DOCUMENT_PROMPT = `## Document Capabilities

### Reading Files
When a user uploads a document (PDF, DOCX, XLSX, CSV, PPTX, JSON, MD, TXT), the system extracts its text content and includes it in the message as "[Document: filename]" followed by the parsed content. You can analyze, summarize, and answer questions about this content directly.

### Generating Documents
When the user asks you to create or generate a document (spreadsheet, report, PDF, CSV), respond with a JSON code block in this exact format. The system will detect it and generate the actual file.

**For spreadsheets (XLSX or CSV):**
\`\`\`json
{
  "format": "xlsx",
  "filename": "descriptive-name.xlsx",
  "title": "Optional Title",
  "content": {
    "type": "spreadsheet",
    "sheets": [{
      "name": "Sheet1",
      "headers": ["Column A", "Column B", "Column C"],
      "rows": [
        ["value1", 2, true],
        ["value2", 3, false]
      ]
    }]
  }
}
\`\`\`

**For documents (DOCX or PDF):**
\`\`\`json
{
  "format": "docx",
  "filename": "descriptive-name.docx",
  "title": "Document Title",
  "content": {
    "type": "document",
    "sections": [{
      "heading": "Section Title",
      "paragraphs": ["Paragraph text here."],
      "bulletPoints": ["Point 1", "Point 2"],
      "table": {
        "headers": ["Col A", "Col B"],
        "rows": [["val1", "val2"]]
      }
    }]
  }
}
\`\`\`

**Charts in documents (PDF or DOCX):**
Sections can include a "chart" field to render a visual chart. Supported types: bar, line, pie, doughnut, scatter, radar, bubble, polarArea.

\`\`\`json
{
  "format": "pdf",
  "filename": "report.pdf",
  "title": "Sales Report",
  "content": {
    "type": "document",
    "sections": [
      {
        "heading": "Revenue Overview",
        "paragraphs": ["Quarterly revenue breakdown:"],
        "chart": {
          "type": "bar",
          "title": "Quarterly Revenue",
          "data": {
            "labels": ["Q1", "Q2", "Q3", "Q4"],
            "datasets": [{
              "label": "Revenue ($K)",
              "data": [120, 190, 150, 220],
              "backgroundColor": ["#4BC0C0", "#FF6384", "#36A2EB", "#FFCE56"]
            }]
          }
        }
      }
    ]
  }
}
\`\`\`

Supported formats: \`xlsx\`, \`docx\`, \`pdf\`, \`csv\`. Use \`csv\` format with spreadsheet content type for simple tabular data. Include any explanatory text outside the JSON code block — it will be sent alongside the file.`;

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

    // Resolve active skill for this chat
    const skillPrompt = getSkillSystemPrompt(chatId);
    const allowedTools = getSkillAllowedTools(chatId);

    // Inject document capabilities for both providers; language hint for Claude only (Ollama has its own)
    const systemPrompt = provider.name === 'claude'
      ? [params.systemPrompt, skillPrompt, CLAUDE_DOCUMENT_PROMPT, LANGUAGE_HINT].filter(Boolean).join('\n\n')
      : [params.systemPrompt, skillPrompt, CLAUDE_DOCUMENT_PROMPT].filter(Boolean).join('\n\n') || undefined;

    // When a skill is active, don't resume Claude sessions — the skill's system prompt
    // needs a fresh session to take effect (resumed sessions keep their original system prompt)
    const effectiveSessionId = (provider.name === 'claude' && skillPrompt) ? undefined : sessionId;

    // Per-chat Ollama model override
    const modelOverride = provider.name === 'ollama' && session?.ollama_model
      ? session.ollama_model
      : undefined;

    const response = await provider.sendMessage({
      ...params,
      sessionId: effectiveSessionId,
      systemPrompt,
      allowedTools: allowedTools ?? undefined,
      modelOverride,
    });

    // Handle stale Claude session — clear and retry without --resume
    if (response.staleSession && sessionId) {
      logger.warn({ chatId, sessionId }, 'Stale Claude session detected, retrying without --resume');
      clearSession(chatId);

      const retryResponse = await provider.sendMessage({
        ...params,
        sessionId: undefined,
        systemPrompt,
        allowedTools: allowedTools ?? undefined,
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

  /**
   * List available Ollama models (excluding embedding models).
   */
  async listOllamaModels(): Promise<{ name: string; size: string; family: string }[]> {
    return this.ollama.listModels();
  }

  /**
   * Switch the Ollama model for a specific chat.
   * Validates the model exists locally before switching.
   */
  async switchOllamaModel(chatId: string, model: string): Promise<string> {
    const exists = await this.ollama.modelExists(model);
    if (!exists) {
      return `Model "${model}" not found locally. Use /models to see available models.`;
    }

    const session = getSession(chatId);
    if (session) {
      updateSessionOllamaModel(chatId, model);
    } else {
      setSession(chatId, '', 'ollama');
      updateSessionOllamaModel(chatId, model);
    }

    logger.info({ chatId, model }, 'Switched Ollama model');
    return model;
  }

  /**
   * Get the active Ollama model for a chat (per-chat override or config default).
   */
  getOllamaModel(chatId: string): string {
    const session = getSession(chatId);
    return session?.ollama_model || config.OLLAMA_CHAT_MODEL;
  }
}
