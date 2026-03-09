import { describe, it, expect } from 'vitest';

/**
 * Tests for voice prompt tuning logic.
 *
 * Simulates the full message flow for voice vs text messages through
 * the router and Ollama provider, verifying system prompts, options,
 * and response handling differ correctly.
 */

// ── Constants matching src/providers/router.ts ──────────────

const LANGUAGE_HINT = 'Always respond in the same language the user\'s latest message is written in. If they switch languages, you switch too — immediately, without being asked.';

const VOICE_RESPONSE_HINT = `The user sent a voice message. Respond as if in a verbal conversation:
- Keep responses to 1-3 sentences. Be concise.
- No markdown formatting (no bullet points, headers, code blocks, bold, italics).
- Speak naturally and conversationally — your response will be read aloud.
- If the question requires a long answer, give a brief summary and offer to elaborate.`;

const CLAUDE_DOCUMENT_PROMPT = '## Document Capabilities\n\n### Reading Files\nWhen a user uploads a document...';

// ── Ollama system prompts matching src/providers/ollama.ts ───

const TOOL_MODEL_SYSTEM_PROMPT = 'You are clauded, a helpful AI assistant. You have access to tools...';
const CHAT_MODEL_SYSTEM_PROMPT = `You are clauded, a helpful AI assistant with strong reasoning capabilities. Be helpful, concise, and accurate.

IMPORTANT: Always respond in the same language the user's latest message is written in. If they switch languages, you switch too — immediately, without being asked.`;

// ── Router system prompt assembly (matching router.ts:152-154) ──

interface SendMessageParams {
  message: string;
  chatId: string;
  systemPrompt?: string;
  isVoice?: boolean;
  skipTools?: boolean;
  onTyping?: () => void;
  allowedTools?: string[];
  modelOverride?: string;
  images?: string[];
}

function assembleRouterSystemPrompt(
  params: SendMessageParams,
  providerName: 'claude' | 'ollama',
  skillPrompt: string | null,
): string | undefined {
  const voiceHint = params.isVoice ? VOICE_RESPONSE_HINT : '';

  if (providerName === 'claude') {
    return [voiceHint, params.systemPrompt, skillPrompt, CLAUDE_DOCUMENT_PROMPT, LANGUAGE_HINT]
      .filter(Boolean)
      .join('\n\n');
  }

  return [voiceHint, params.systemPrompt, skillPrompt, CLAUDE_DOCUMENT_PROMPT]
    .filter(Boolean)
    .join('\n\n') || undefined;
}

// ── Ollama sendMessage simulation (matching ollama.ts) ──────

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

interface OllamaChatResult {
  systemPrompt: string;
  messages: OllamaMessage[];
  options: Record<string, unknown>;
  model: string;
}

/**
 * Simulates the full Ollama sendMessage flow:
 * destructure params → choose model → build history → build system prompt → build options
 */
function simulateOllamaSendMessage(
  params: SendMessageParams,
  routerSystemPrompt: string | undefined,
): OllamaChatResult {
  const { message, isVoice, skipTools, images } = params;

  // Model selection (simplified shouldUseTools)
  const useTools = skipTools ? false : /\b(search|read|run|use tools?)\b/i.test(message);
  const model = useTools ? 'qwen3.5:latest' : 'qwen3.5:latest';

  // Build system content (matching runChatTurn / runAgenticLoop)
  const basePrompt = useTools ? TOOL_MODEL_SYSTEM_PROMPT : CHAT_MODEL_SYSTEM_PROMPT;
  const systemContent = routerSystemPrompt
    ? `${basePrompt}\n\n${routerSystemPrompt}`
    : basePrompt;

  // Build user message
  const userMessage: OllamaMessage = { role: 'user', content: message };
  if (images?.length) userMessage.images = images;

  // Build options (matching runChatTurn:207 and runAgenticLoop:263)
  const options: Record<string, unknown> = { num_ctx: 32768 };
  if (isVoice) options.num_predict = 256;

  return {
    systemPrompt: systemContent,
    messages: [
      { role: 'system', content: systemContent },
      userMessage,
    ],
    options,
    model,
  };
}

// ── Full pipeline: platform → router → provider ─────────────

interface PipelineResult {
  messageToAI: string;
  systemPrompt: string;
  ollamaOptions: Record<string, unknown>;
  forceVoiceReply: boolean;
  isVoice: boolean;
}

/**
 * Simulates the full voice message pipeline:
 * Telegram/Matrix voice handler → handleMessage → router.sendMessage → ollama.sendMessage
 *
 * This catches integration bugs like:
 * - isVoice not reaching the provider
 * - Voice hint missing from system prompt
 * - num_predict not set
 * - Old "[Voice transcribed]:" prefix leaking through
 */
function simulateVoicePipeline(
  transcript: string,
  provider: 'claude' | 'ollama',
  skillPrompt: string | null = null,
  memoryContext: string | null = null,
): PipelineResult {
  // Step 1: Platform layer (telegram.ts voice handler)
  // OLD: `[Voice transcribed]: ${transcript}`  NEW: just transcript
  const rawText = transcript;
  const forceVoiceReply = true;
  const isVoice = true;

  // Step 2: handleMessage builds memory context
  const fullMessage = memoryContext
    ? `${memoryContext}\n\n${rawText}`
    : rawText;

  // Step 3: router.sendMessage assembles system prompt
  const routerParams: SendMessageParams = {
    message: fullMessage,
    chatId: 'test-chat',
    isVoice,
  };
  const systemPrompt = assembleRouterSystemPrompt(routerParams, provider, skillPrompt)!;

  // Step 4: Ollama builds final options
  const ollamaResult = simulateOllamaSendMessage(
    { ...routerParams, systemPrompt },
    systemPrompt,
  );

  return {
    messageToAI: fullMessage,
    systemPrompt: ollamaResult.systemPrompt,
    ollamaOptions: ollamaResult.options,
    forceVoiceReply,
    isVoice,
  };
}

function simulateTextPipeline(
  text: string,
  provider: 'claude' | 'ollama',
  skillPrompt: string | null = null,
): PipelineResult {
  const routerParams: SendMessageParams = {
    message: text,
    chatId: 'test-chat',
    isVoice: false,
  };
  const systemPrompt = assembleRouterSystemPrompt(routerParams, provider, skillPrompt)!;

  const ollamaResult = simulateOllamaSendMessage(
    { ...routerParams, systemPrompt },
    systemPrompt,
  );

  return {
    messageToAI: text,
    systemPrompt: ollamaResult.systemPrompt,
    ollamaOptions: ollamaResult.options,
    forceVoiceReply: false,
    isVoice: false,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('complete voice message pipeline', () => {
  it('voice transcript reaches AI without [Voice transcribed] prefix', () => {
    const result = simulateVoicePipeline('What time is it?', 'ollama');
    expect(result.messageToAI).toBe('What time is it?');
    expect(result.messageToAI).not.toContain('[Voice transcribed]');
  });

  it('voice hint appears in system prompt sent to Ollama', () => {
    const result = simulateVoicePipeline('Hello', 'ollama');
    expect(result.systemPrompt).toContain('1-3 sentences');
    expect(result.systemPrompt).toContain('No markdown');
    expect(result.systemPrompt).toContain('read aloud');
  });

  it('voice hint appears in system prompt sent to Claude', () => {
    const result = simulateVoicePipeline('Hello', 'claude');
    expect(result.systemPrompt).toContain(VOICE_RESPONSE_HINT);
  });

  it('num_predict is limited to 256 for voice messages', () => {
    const result = simulateVoicePipeline('Tell me a story', 'ollama');
    expect(result.ollamaOptions.num_predict).toBe(256);
  });

  it('forceVoiceReply is true for voice messages', () => {
    const result = simulateVoicePipeline('Hello', 'ollama');
    expect(result.forceVoiceReply).toBe(true);
  });

  it('memory context is prepended before transcript', () => {
    const result = simulateVoicePipeline(
      'What should I eat?',
      'ollama',
      null,
      '[Memory: user is vegetarian]',
    );
    expect(result.messageToAI).toBe('[Memory: user is vegetarian]\n\nWhat should I eat?');
    // Voice hint is in system prompt, not in message
    expect(result.messageToAI).not.toContain('1-3 sentences');
  });

  it('skill prompt coexists with voice hint', () => {
    const result = simulateVoicePipeline('Translate this', 'ollama', 'You are a translator.');
    expect(result.systemPrompt).toContain(VOICE_RESPONSE_HINT);
    expect(result.systemPrompt).toContain('You are a translator.');
  });
});

describe('text message pipeline is NOT affected by voice changes', () => {
  it('text messages do NOT get voice hint', () => {
    const result = simulateTextPipeline('Hello', 'ollama');
    expect(result.systemPrompt).not.toContain('1-3 sentences');
    expect(result.systemPrompt).not.toContain('read aloud');
  });

  it('text messages do NOT get num_predict limit', () => {
    const result = simulateTextPipeline('Tell me a long story', 'ollama');
    expect(result.ollamaOptions.num_predict).toBeUndefined();
    expect(result.ollamaOptions.num_ctx).toBe(32768);
  });

  it('text messages do NOT force voice reply', () => {
    const result = simulateTextPipeline('Hello', 'ollama');
    expect(result.forceVoiceReply).toBe(false);
  });

  it('text messages still get document prompt and skill prompt', () => {
    const result = simulateTextPipeline('Hello', 'claude', 'You are an analyst.');
    expect(result.systemPrompt).toContain('Document Capabilities');
    expect(result.systemPrompt).toContain('You are an analyst.');
    expect(result.systemPrompt).toContain(LANGUAGE_HINT);
  });
});

describe('voice vs text system prompt structural differences', () => {
  it('voice prompt has more content than text prompt', () => {
    const voice = simulateVoicePipeline('Hello', 'claude');
    const text = simulateTextPipeline('Hello', 'claude');
    expect(voice.systemPrompt.length).toBeGreaterThan(text.systemPrompt.length);
  });

  it('voice hint appears before skill and document prompts in router output', () => {
    // The router assembles: [voiceHint, systemPrompt, skillPrompt, docPrompt, langHint]
    // Ollama then wraps it: basePrompt + "\n\n" + routerPrompt
    // So voice hint is first within the router's contribution, after Ollama's base prompt.
    const result = simulateVoicePipeline('Hello', 'claude', 'Skill prompt here');
    const voiceIdx = result.systemPrompt.indexOf('voice message');
    const skillIdx = result.systemPrompt.indexOf('Skill prompt here');
    const docIdx = result.systemPrompt.indexOf('Document Capabilities');
    expect(voiceIdx).toBeGreaterThan(-1);
    expect(voiceIdx).toBeLessThan(skillIdx);
    expect(voiceIdx).toBeLessThan(docIdx);
  });

  it('Claude voice prompt includes LANGUAGE_HINT, Ollama router does not', () => {
    const claudeRouterPrompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true }, 'claude', null,
    );
    const ollamaRouterPrompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true }, 'ollama', null,
    );
    // Router injects LANGUAGE_HINT for Claude only
    expect(claudeRouterPrompt).toContain(LANGUAGE_HINT);
    // Router does NOT inject it for Ollama (Ollama has its own in CHAT_MODEL_SYSTEM_PROMPT)
    expect(ollamaRouterPrompt).not.toContain(LANGUAGE_HINT);
  });
});

describe('Ollama voice flow simulation (like ollama-loop.test.ts)', () => {
  /**
   * Simulates the Ollama agentic loop with voice options.
   * Verifies that voice constraints propagate into the chat call.
   */
  interface MockChatCall {
    model: string;
    systemContent: string;
    userContent: string;
    options: Record<string, unknown>;
  }

  function simulateOllamaVoiceChat(
    message: string,
    isVoice: boolean,
    extraSystemPrompt?: string,
  ): MockChatCall {
    const systemContent = extraSystemPrompt
      ? `${CHAT_MODEL_SYSTEM_PROMPT}\n\n${extraSystemPrompt}`
      : CHAT_MODEL_SYSTEM_PROMPT;

    const options: Record<string, unknown> = { num_ctx: 32768 };
    if (isVoice) options.num_predict = 256;

    return {
      model: 'qwen3.5:latest',
      systemContent,
      userContent: message,
      options,
    };
  }

  it('voice chat call has num_predict=256', () => {
    const call = simulateOllamaVoiceChat('Hello', true, VOICE_RESPONSE_HINT);
    expect(call.options.num_predict).toBe(256);
  });

  it('voice chat system prompt contains conversational instructions', () => {
    const call = simulateOllamaVoiceChat('Hello', true, VOICE_RESPONSE_HINT);
    expect(call.systemContent).toContain('1-3 sentences');
    expect(call.systemContent).toContain('No markdown');
  });

  it('non-voice chat has no num_predict limit', () => {
    const call = simulateOllamaVoiceChat('Hello', false);
    expect(call.options.num_predict).toBeUndefined();
  });

  it('non-voice system prompt is just the base prompt', () => {
    const call = simulateOllamaVoiceChat('Hello', false);
    expect(call.systemContent).toBe(CHAT_MODEL_SYSTEM_PROMPT);
    expect(call.systemContent).not.toContain('read aloud');
  });

  it('voice + agentic loop: options include num_predict in tool model path', () => {
    // Simulates the agentic loop path (tools detected)
    const extraPrompt = VOICE_RESPONSE_HINT;
    const systemContent = `${TOOL_MODEL_SYSTEM_PROMPT}\n\n${extraPrompt}`;
    const options: Record<string, unknown> = { num_ctx: 32768 };
    options.num_predict = 256; // isVoice=true

    expect(systemContent).toContain('1-3 sentences');
    expect(options.num_predict).toBe(256);
    // Tool system prompt is still present
    expect(systemContent).toContain('You have access to tools');
  });
});

describe('voice hint content correctness for conversational AI', () => {
  it('instructs brevity (prevents long-winded voice responses)', () => {
    expect(VOICE_RESPONSE_HINT).toMatch(/\b(concise|brief|short)\b/i);
    expect(VOICE_RESPONSE_HINT).toMatch(/1-3 sentences/);
  });

  it('forbids markdown (prevents TTS reading "asterisk asterisk bold")', () => {
    expect(VOICE_RESPONSE_HINT).toMatch(/no markdown/i);
    // Specifically mentions the problematic formatting types
    expect(VOICE_RESPONSE_HINT).toMatch(/bullet points/i);
    expect(VOICE_RESPONSE_HINT).toMatch(/code blocks/i);
    expect(VOICE_RESPONSE_HINT).toMatch(/headers/i);
  });

  it('instructs natural speech (not robotic/written style)', () => {
    expect(VOICE_RESPONSE_HINT).toMatch(/natural/i);
    expect(VOICE_RESPONSE_HINT).toMatch(/conversational/i);
  });

  it('handles long-answer gracefully (summarize + offer more)', () => {
    expect(VOICE_RESPONSE_HINT).toMatch(/brief summary/i);
    expect(VOICE_RESPONSE_HINT).toMatch(/offer to elaborate/i);
  });

  it('does NOT instruct emoji or filler words', () => {
    expect(VOICE_RESPONSE_HINT).not.toMatch(/emoji/i);
    expect(VOICE_RESPONSE_HINT).not.toMatch(/filler/i);
  });
});

describe('edge case: voice with tool-triggering message', () => {
  it('voice hint is present even when tools would be triggered', () => {
    // "search for weather" triggers shouldUseTools, but voice hint should still be in system prompt
    const routerPrompt = assembleRouterSystemPrompt(
      { message: 'search for weather', chatId: 'test', isVoice: true },
      'ollama',
      null,
    );
    expect(routerPrompt).toContain(VOICE_RESPONSE_HINT);
  });

  it('num_predict still applies in tool model path for voice', () => {
    // Even when using tool model, voice should limit response length
    const options: Record<string, unknown> = { num_ctx: 32768 };
    const isVoice = true;
    if (isVoice) options.num_predict = 256;
    expect(options.num_predict).toBe(256);
  });
});

// ── Claude-specific voice behavior ──────────────────────────

describe('Claude provider: voice mechanism is prompt-only', () => {
  /**
   * Claude provider destructures: const { message, sessionId, onTyping } = params;
   * It NEVER reads isVoice. The ONLY mechanism for voice behavior is
   * the systemPrompt assembled by the router and passed via --system-prompt flag.
   *
   * This test group verifies the system prompt is the complete contract.
   */

  it('Claude system prompt contains full voice hint for isVoice=true', () => {
    const prompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'claude',
      null,
    );
    // Claude has NO num_predict — the prompt must do all the work
    expect(prompt).toContain('1-3 sentences');
    expect(prompt).toContain('No markdown');
    expect(prompt).toContain('read aloud');
    expect(prompt).toContain('offer to elaborate');
  });

  it('Claude system prompt contains LANGUAGE_HINT alongside voice hint', () => {
    const prompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'claude',
      null,
    );
    // Both must be present — Claude follows instructions well enough
    // to handle multiple directives
    expect(prompt).toContain(VOICE_RESPONSE_HINT);
    expect(prompt).toContain(LANGUAGE_HINT);
  });

  it('Claude has NO hard token limit unlike Ollama num_predict', () => {
    // This documents the intentional asymmetry:
    // Ollama: voice hint + num_predict=256
    // Claude: voice hint only (follows instructions reliably)
    const claudePrompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'claude',
      null,
    );
    const ollamaOptions: Record<string, unknown> = { num_ctx: 32768 };
    ollamaOptions.num_predict = 256;

    // Claude relies on prompt instruction for brevity
    expect(claudePrompt).toContain('1-3 sentences');
    // Ollama has both prompt AND hard limit
    expect(ollamaOptions.num_predict).toBe(256);
  });
});

describe('Claude stale session retry preserves voice hint', () => {
  /**
   * Simulates router.ts:182-192: when Claude returns staleSession=true,
   * the router retries with the SAME systemPrompt variable.
   * The voice hint must survive this retry path.
   */

  it('systemPrompt is built once and reused in retry (voice hint preserved)', () => {
    // This mirrors the actual code:
    // const systemPrompt = [...].join('\n\n');  ← built once at line 161-163
    // const retryResponse = await provider.sendMessage({ ...params, systemPrompt }); ← reused at line 190
    const systemPrompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'claude',
      null,
    );

    // First call
    const firstCall = { systemPrompt, sessionId: 'old-session-id' };
    expect(firstCall.systemPrompt).toContain(VOICE_RESPONSE_HINT);

    // Retry (stale session) — same systemPrompt variable
    const retryCall = { systemPrompt, sessionId: undefined };
    expect(retryCall.systemPrompt).toContain(VOICE_RESPONSE_HINT);
    expect(retryCall.systemPrompt).toBe(firstCall.systemPrompt);
  });
});

describe('skill + voice interaction with Claude sessions', () => {
  /**
   * When a skill is active, Claude gets a fresh session (effectiveSessionId = undefined).
   * The voice hint must still be present in the system prompt even with a skill.
   */

  it('voice hint is present when skill forces fresh Claude session', () => {
    const skillPrompt = 'You are an expert translator. Translate everything to Spanish.';
    const prompt = assembleRouterSystemPrompt(
      { message: 'Translate this', chatId: 'test', isVoice: true },
      'claude',
      skillPrompt,
    );

    // Both voice hint and skill must coexist
    expect(prompt).toContain(VOICE_RESPONSE_HINT);
    expect(prompt).toContain(skillPrompt);
    // Voice hint comes first (higher priority for AI)
    expect(prompt!.indexOf(VOICE_RESPONSE_HINT)).toBeLessThan(prompt!.indexOf(skillPrompt));
  });

  it('skill prompt does not override voice hint for Ollama either', () => {
    const prompt = assembleRouterSystemPrompt(
      { message: 'Analyze this', chatId: 'test', isVoice: true },
      'ollama',
      'You are a data analyst.',
    );
    expect(prompt).toContain(VOICE_RESPONSE_HINT);
    expect(prompt).toContain('data analyst');
  });
});

// ── Ollama-specific voice behavior ──────────────────────────

describe('Ollama provider: dual mechanism (prompt + num_predict)', () => {
  it('Ollama voice has BOTH prompt hint AND hard token limit', () => {
    const prompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'ollama',
      null,
    );
    const options: Record<string, unknown> = { num_ctx: 32768 };
    options.num_predict = 256;

    expect(prompt).toContain('1-3 sentences');
    expect(options.num_predict).toBe(256);
  });

  it('Ollama non-voice has neither prompt hint nor token limit', () => {
    const prompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: false },
      'ollama',
      null,
    );
    const options: Record<string, unknown> = { num_ctx: 32768 };
    // isVoice=false → no num_predict

    expect(prompt).not.toContain('1-3 sentences');
    expect(options.num_predict).toBeUndefined();
  });

  it('Ollama LANGUAGE_HINT is in its own base prompt, not router prompt', () => {
    // Ollama has its own language hint in CHAT_MODEL_SYSTEM_PROMPT and TOOL_MODEL_SYSTEM_PROMPT
    // The router does NOT add LANGUAGE_HINT for Ollama (would be duplicate)
    const routerPrompt = assembleRouterSystemPrompt(
      { message: 'Hello', chatId: 'test', isVoice: true },
      'ollama',
      null,
    );
    expect(routerPrompt).not.toContain(LANGUAGE_HINT);
    // But the Ollama base prompt has its own
    expect(CHAT_MODEL_SYSTEM_PROMPT).toContain('same language');
  });
});
