import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bot, Context, InputFile } from 'grammy';
import { config, UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRouter } from '../providers/router.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import { getMemoriesByChatId, createTask, getTasksByChat, getTask, pauseTask, resumeTask, deleteTask, listSkills, getSkillByName, setActiveSkill, clearActiveSkill, getActiveSkill, createSkill, deleteSkill, lockSkill, unlockSkill, insertSkillRevision, updateSkill, listUserTools, getUserToolByName, createUserTool, deleteUserTool, enableUserTool, disableUserTool, lockUserTool, unlockUserTool, insertToolRevision, type UserTool } from '../db.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from '../voice.js';
import { computeNextRun, validateCron } from '../scheduler.js';
import { parseFile } from '../files.js';
import { isDocGenResponse, parseDocGenResponse, generateDocument, stripDocGenBlock } from '../docgen.js';
import { parseSkillMarkdown } from '../forge/skill-parser.js';
import { fixSkill } from '../forge/skill-fixer.js';
import { parseToolMarkdown } from '../forge/tool-parser.js';
import { scanToolCode } from '../forge/safety-scanner.js';
import { registerTool, loadUserTools, listRegisteredTools } from '../forge/tool-registry.js';
import { generateToolCode } from '../forge/tool-generator.js';
import { fixTool } from '../forge/tool-fixer.js';
import { exportSkillToMarkdown, exportToolToMarkdown } from '../forge/exporter.js';
import { buildDigest, getDigestPreference, setDigestPreference, type DigestFrequency } from '../proactive.js';
import { shouldOrchestrate, orchestrateTask } from '../orchestrator.js';
import { checkResponseQuality, logQualityCheck } from '../self-monitor.js';

const TYPING_REFRESH_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

// Per-chat voice mode toggle
const voiceModeChats = new Set<string>();

// ── Auth ────────────────────────────────────────────────────

function isAuthorised(chatId: number): boolean {
  if (!config.ALLOWED_CHAT_ID) return true; // First-run mode
  const allowed = config.ALLOWED_CHAT_ID.split(',').map((id) => id.trim());
  return allowed.includes(String(chatId));
}

// ── Formatting ──────────────────────────────────────────────

/**
 * Convert markdown to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <code>, <pre>, <s>, <a>, <u>
 *
 * Order matters: protect code blocks first, then convert markdown.
 */
export function formatForTelegram(text: string): string {
  // 1. Extract and protect code blocks (``` ... ```)
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 2. Extract and protect inline code (` ... `)
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // 3. Escape HTML in remaining text
  result = escapeHtml(result);

  // 4. Markdown → HTML conversions
  // Bold-italic: ***text*** or ___text___ (must come BEFORE bold and italic)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  result = result.replace(/___(.+?)___/g, '<b><i>$1</i></b>');

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings: # Heading → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Checkboxes
  result = result.replace(/- \[ \]/g, '☐');
  result = result.replace(/- \[x\]/gi, '☑');

  // Strip horizontal rules
  result = result.replace(/^-{3,}$/gm, '');
  result = result.replace(/^\*{3,}$/gm, '');

  // 5. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
  }

  // 6. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return result.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split a message into chunks that fit Telegram's limit.
 * Splits on newlines; never splits mid-word.
 */
export function splitMessage(
  text: string,
  limit: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Find last newline before limit
    let splitIdx = remaining.lastIndexOf('\n', limit);

    // If no newline, find last space
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }

    // If still nothing, hard split at limit
    if (splitIdx <= 0) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) chunks.push(remaining);

  return chunks;
}

// ── Message Pipeline ────────────────────────────────────────

async function handleMessage(
  ctx: Context,
  rawText: string,
  router: ProviderRouter,
  forceVoiceReply: boolean = false,
  skipTools: boolean = false,
  isVoice: boolean = false,
): Promise<void> {
  const chatId = String(ctx.chat!.id);

  // 1. Build memory context (hybrid: FTS5 + vector)
  const memoryContext = await buildMemoryContext(chatId, rawText);
  const fullMessage = memoryContext
    ? `${memoryContext}\n\n${rawText}`
    : rawText;

  // 2. Start typing indicator refresh
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  const refreshTyping = () => {
    ctx.replyWithChatAction('typing').catch(() => {
      // Ignore typing errors
    });
  };

  refreshTyping();
  typingInterval = setInterval(refreshTyping, TYPING_REFRESH_MS);

  try {
    // 2b. Check for multi-step orchestration (on raw message, not memory-augmented)
    if (!skipTools && !isVoice && shouldOrchestrate(rawText)) {
      clearInterval(typingInterval);
      typingInterval = undefined;

      const progressFn = async (_chatId: string, text: string) => {
        await ctx.reply(formatForTelegram(text), { parse_mode: 'HTML' });
      };

      const response = await orchestrateTask(router, chatId, fullMessage, progressFn);

      // Save orchestration as conversation memory
      if (response.text) {
        saveConversationTurn(chatId, rawText, response.text).catch((err) => {
          logger.warn({ err }, 'Failed to save orchestration memory');
        });

        const formatted = formatForTelegram(response.text);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch {
            await ctx.reply(chunk);
          }
        }
      }
      return;
    }

    // 3. Send to AI provider
    const response = await router.sendMessage({
      chatId,
      message: fullMessage,
      onTyping: refreshTyping,
      skipTools,
      isVoice,
    });

    // 4. Stop typing
    clearInterval(typingInterval);
    typingInterval = undefined;

    // 4b. Send auto-trigger notice if a skill was activated for this message
    if (response.autoTriggerNotice) {
      await ctx.reply(formatForTelegram(response.autoTriggerNotice), { parse_mode: 'HTML' });
    }

    if (!response.text) {
      await ctx.reply('(No response from AI provider)');
      return;
    }

    // 4c. Quality check (non-blocking — log issues for analysis)
    const quality = checkResponseQuality(response, rawText);
    if (!quality.passed) {
      logQualityCheck(chatId, response.provider, quality.score, quality.issues);
    }

    // 5. Save conversation memory (with embedding, fire-and-forget)
    saveConversationTurn(chatId, rawText, response.text).catch((err) => {
      logger.warn({ err }, 'Failed to save conversation memory');
    });

    // 5b. Check for document generation request in response
    if (isDocGenResponse(response.text)) {
      const docReq = parseDocGenResponse(response.text);
      if (docReq) {
        try {
          const result = await generateDocument(docReq);
          await ctx.replyWithDocument(new InputFile(result.buffer, result.filename));
          // Send any remaining text (outside the JSON block)
          const remainingText = stripDocGenBlock(response.text);
          if (remainingText) {
            const formatted = formatForTelegram(remainingText);
            const chunks = splitMessage(formatted);
            for (const chunk of chunks) {
              await ctx.reply(chunk, { parse_mode: 'HTML' });
            }
          }
          return;
        } catch (err) {
          logger.warn({ err }, 'Document generation failed, sending raw response');
        }
      }
    }

    // 5c. Send any files generated by Ollama tool calls
    if (response.generatedFiles?.length) {
      for (const file of response.generatedFiles) {
        try {
          const fileBuffer = readFileSync(file.path);
          await ctx.replyWithDocument(new InputFile(fileBuffer, file.filename));
        } catch (err) {
          logger.warn({ err, file }, 'Failed to send generated file');
        }
      }
    }

    // 6. Send response
    const shouldVoice =
      forceVoiceReply || voiceModeChats.has(chatId);

    if (shouldVoice) {
      const caps = await voiceCapabilities();
      if (caps.tts) {
        try {
          const audio = await synthesizeSpeech(response.text);
          await ctx.replyWithVoice(new InputFile(audio, 'response.mp3'));
        } catch (err) {
          logger.warn({ err }, 'TTS failed, falling back to text');
        }
      }
    }

    // Always send text (even if voice was sent — serves as caption/fallback)
    const formatted = formatForTelegram(response.text);
    const chunks = splitMessage(formatted);

    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      } catch {
        // HTML parse failed (e.g. malformed tags) — retry as plain text
        await ctx.reply(chunk);
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Message handling failed');
    await ctx.reply('Sorry, something went wrong processing your message.').catch(() => {});
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}

// ── Skill Upload Helper ─────────────────────────────────

async function handleSkillUpload(ctx: Context): Promise<void> {
  // Check for document in current message or replied-to message
  const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) {
    await ctx.reply('Reply to a .md file with /skill upload, or send a .md file with caption /skill upload.');
    return;
  }

  const fileName = doc.file_name || 'unknown';
  if (!fileName.endsWith('.md')) {
    await ctx.reply('Skill files must be .md (Markdown) format.');
    return;
  }

  try {
    const file = await ctx.api.getFile(doc.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply('Could not download file.');
      return;
    }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply('Failed to download file.');
      return;
    }

    const content = await res.text();
    const parsed = parseSkillMarkdown(content);

    if ('error' in parsed) {
      await ctx.reply(`Parse error: ${parsed.error}`);
      return;
    }

    // Check if skill already exists
    const existing = getSkillByName(parsed.name);
    if (existing) {
      if (existing.locked) {
        await ctx.reply(`Skill "${parsed.name}" is locked. Unlock it first.`);
        return;
      }
      // Update existing skill
      updateSkill(existing.id, {
        description: parsed.description,
        systemPrompt: parsed.systemPrompt,
        allowedTools: parsed.tools,
      });
      insertSkillRevision(existing.id, parsed.systemPrompt, `Updated from file: ${fileName}`);
      await ctx.reply(
        `Skill <b>${escapeHtml(parsed.name)}</b> updated from ${escapeHtml(fileName)}.`,
        { parse_mode: 'HTML' },
      );
    } else {
      // Create new skill
      const id = `custom-${parsed.name}`;
      createSkill(id, parsed.name, parsed.description, parsed.systemPrompt, parsed.tools, false, fileName);
      insertSkillRevision(id, parsed.systemPrompt, `Created from file: ${fileName}`);
      await ctx.reply(
        `Skill <b>${escapeHtml(parsed.name)}</b> created from ${escapeHtml(fileName)}.\nActivate with: /skill use ${escapeHtml(parsed.name)}`,
        { parse_mode: 'HTML' },
      );
    }
  } catch (err) {
    logger.error({ err }, 'Skill upload failed');
    await ctx.reply('Failed to upload skill.');
  }
}

// ── Tool Upload Helper ──────────────────────────────────

async function handleToolUpload(ctx: Context, router: ProviderRouter): Promise<void> {
  const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) {
    await ctx.reply('Reply to a .md file with /tool upload, or send a .md file with caption /tool upload.');
    return;
  }

  const fileName = doc.file_name || 'unknown';
  if (!fileName.endsWith('.md')) {
    await ctx.reply('Tool files must be .md (Markdown) format.');
    return;
  }

  try {
    const file = await ctx.api.getFile(doc.file_id);
    const filePath = file.file_path;
    if (!filePath) { await ctx.reply('Could not download file.'); return; }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) { await ctx.reply('Failed to download file.'); return; }

    const content = await res.text();
    const parsed = parseToolMarkdown(content);

    if ('error' in parsed) {
      await ctx.reply(`Parse error: ${parsed.error}`);
      return;
    }

    // For generated_code: check safety or generate code
    if (parsed.type === 'generated_code') {
      if (parsed.code) {
        const scan = scanToolCode(parsed.code);
        if (!scan.safe) {
          await ctx.reply(`Safety check failed:\n${scan.issues.join('\n')}`);
          return;
        }
      } else {
        // Generate code via AI
        await ctx.reply('Generating tool code via AI...');
        const chatId = String(ctx.chat!.id);
        const genResult = await generateToolCode(
          parsed.name,
          parsed.description,
          parsed.parameters,
          chatId,
          router,
        );
        if ('error' in genResult) {
          await ctx.reply(genResult.error);
          return;
        }
        parsed.code = genResult.code;
      }
    }

    // Build config to store
    const toolConfig = JSON.stringify({
      parameters: parsed.parameters,
      endpoint: parsed.endpoint,
      code: parsed.code,
    });

    // Check existing
    const existing = getUserToolByName(parsed.name);
    if (existing) {
      if (existing.locked) {
        await ctx.reply(`Tool "${parsed.name}" is locked. Unlock it first.`);
        return;
      }
      // Update
      const { updateUserTool } = await import('../db.js');
      updateUserTool(existing.id, { description: parsed.description, config: toolConfig });
      insertToolRevision(existing.id, toolConfig, `Updated from file: ${fileName}`);
      loadUserTools();
      await ctx.reply(
        `Tool <b>${escapeHtml(parsed.name)}</b> updated from ${escapeHtml(fileName)}.`,
        { parse_mode: 'HTML' },
      );
    } else {
      const id = `user-tool-${parsed.name}`;
      createUserTool(id, parsed.name, parsed.description, parsed.type, toolConfig, fileName);
      insertToolRevision(id, toolConfig, `Created from file: ${fileName}`);
      loadUserTools();
      await ctx.reply(
        `Tool <b>${escapeHtml(parsed.name)}</b> created from ${escapeHtml(fileName)}.`,
        { parse_mode: 'HTML' },
      );
    }
  } catch (err) {
    logger.error({ err }, 'Tool upload failed');
    await ctx.reply('Failed to upload tool.');
  }
}

// ── Bot Factory ─────────────────────────────────────────────

export function createTelegramBot(router: ProviderRouter): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ── Commands ──────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await ctx.reply(
      'Hello! I\'m <b>clauded</b>, your AI assistant.\n\n' +
        'Commands:\n' +
        '/chatid — Show your chat ID\n' +
        '/newchat — Start a fresh session\n' +
        '/memory — Show stored memories\n' +
        '/voice — Toggle voice replies\n' +
        '/claude — Switch to Claude\n' +
        '/ollama — Switch to Ollama\n' +
        '/auto — Toggle automatic provider routing\n' +
        '/provider — Show current provider &amp; routing mode\n' +
        '/models — List available Ollama models\n' +
        '/model &lt;name&gt; — Switch Ollama model\n' +
        '/schedule — Manage scheduled tasks\n' +
        '/skill — Manage AI skills\n' +
        '/tool — Manage tools (list, upload, fix)\n' +
        '/careful — Toggle safety guardrails mode\n' +
        '/digest — Activity digests (daily/weekly/now)\n' +
        '/reload — Reload user tools from DB',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
    });
  });

  bot.command(['newchat', 'forget'], async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    router.newChat(String(ctx.chat.id));
    await ctx.reply('Session cleared. Starting fresh.');
  });

  bot.command('memory', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const memories = getMemoriesByChatId(String(ctx.chat.id));
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.');
      return;
    }
    const lines = memories.slice(0, 20).map(
      (m) =>
        `• [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''} (salience: ${m.salience.toFixed(2)})`,
    );
    const text = `<b>Memories (${memories.length} total):</b>\n\n${lines.join('\n')}`;
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  });

  bot.command('voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId);
      await ctx.reply('Voice replies disabled.');
    } else {
      const caps = await voiceCapabilities();
      if (!caps.tts) {
        await ctx.reply(
          'Voice service (Speaches) is not available. Start it with:\n' +
            '<code>docker compose -f docker/speaches.yml up -d</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      voiceModeChats.add(chatId);
      await ctx.reply('Voice replies enabled. Send /voice again to disable.');
    }
  });

  bot.command('claude', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const result = router.switchProvider(String(ctx.chat.id), 'claude');
    await ctx.reply(`Switched to <b>${result}</b> provider.`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('ollama', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const result = router.switchProvider(String(ctx.chat.id), 'ollama');
    const model = router.getOllamaModel(String(ctx.chat.id));
    await ctx.reply(`Switched to <b>${result}</b> provider.\nModel: <code>${escapeHtml(model)}</code>`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('auto', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const enabled = router.toggleAutoRoute(String(ctx.chat.id));
    const emoji = enabled ? '🟢' : '🔴';
    await ctx.reply(
      `${emoji} Auto-routing <b>${enabled ? 'enabled' : 'disabled'}</b>.\n` +
        (enabled
          ? 'Provider will be selected automatically per message.\nUse /claude or /ollama to switch back to manual.'
          : 'Use /claude or /ollama to set provider manually.'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('provider', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const status = router.getProviderStatus(String(ctx.chat.id));
    const modeLabel = status.mode === 'auto' ? '🟢 auto' : '🔵 manual';
    let msg = `Provider: <b>${status.provider}</b>\nRouting: ${modeLabel}`;
    if (status.model) {
      msg += `\nModel: <code>${escapeHtml(status.model)}</code>`;
    }
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  bot.command(['careful', 'safe'], async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const skill = getSkillByName('careful');
    if (!skill) {
      await ctx.reply('Safety skill not found. Run /reload to refresh skills.');
      return;
    }
    const currentSkill = getActiveSkill(chatId);
    if (currentSkill?.name === 'careful') {
      clearActiveSkill(chatId);
      await ctx.reply('Safety mode <b>disabled</b>.', { parse_mode: 'HTML' });
    } else {
      setActiveSkill(chatId, skill.id);
      await ctx.reply(
        '🛡️ Safety mode <b>enabled</b>.\n' +
          'I will warn before destructive actions, verify results, and ask for confirmation.\n' +
          'Use /careful again to disable, or /newchat to reset.',
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command('models', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    try {
      const models = await router.listOllamaModels();
      if (models.length === 0) {
        await ctx.reply('No Ollama models found. Is Ollama running?');
        return;
      }
      const currentModel = router.getOllamaModel(String(ctx.chat.id));
      const lines = models.map((m, i) => {
        const active = m.name === currentModel ? ' ✓' : '';
        return `${i + 1}. <code>${escapeHtml(m.name)}</code> (${escapeHtml(m.size)}, ${escapeHtml(m.family)})${active}`;
      });
      await ctx.reply(
        `<b>Available Ollama models:</b>\n\n${lines.join('\n')}\n\nSwitch with: /model &lt;name&gt;`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.error({ err }, 'Failed to list Ollama models');
      await ctx.reply('Failed to list models. Is Ollama running?');
    }
  });

  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const modelName = text.replace(/^\/model(@\w+)?/, '').trim();

    if (!modelName) {
      const current = router.getOllamaModel(chatId);
      await ctx.reply(
        `Current Ollama model: <code>${escapeHtml(current)}</code>\n\nUsage: /model &lt;name&gt;\nList models: /models`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const result = await router.switchOllamaModel(chatId, modelName);
      if (result === modelName) {
        // Also switch to ollama provider if not already
        router.switchProvider(chatId, 'ollama');
        await ctx.reply(
          `Switched to model: <code>${escapeHtml(modelName)}</code>`,
          { parse_mode: 'HTML' },
        );
      } else {
        // result contains error message
        await ctx.reply(result);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to switch Ollama model');
      await ctx.reply('Failed to switch model. Is Ollama running?');
    }
  });

  bot.command('schedule', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    // Strip "/schedule" prefix and trim
    const args = text.replace(/^\/schedule(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const tasks = getTasksByChat(chatId);
        if (tasks.length === 0) {
          await ctx.reply('No scheduled tasks.');
          return;
        }
        const lines = tasks.map((t) => {
          const next = new Date(t.next_run).toLocaleString();
          return `<code>${t.id.slice(0, 8)}</code> [<b>${t.status}</b>] ${escapeHtml(t.prompt.slice(0, 50))}${t.prompt.length > 50 ? '...' : ''}\n  ⏰ <code>${t.schedule}</code> → next: ${next}`;
        });
        const msg = `<b>Scheduled tasks (${tasks.length}):</b>\n\n${lines.join('\n\n')}`;
        const chunks = splitMessage(msg);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
        return;
      }

      case 'show': {
        const taskId = parts[1];
        if (!taskId) {
          await ctx.reply('Usage: /schedule show &lt;id&gt;', { parse_mode: 'HTML' });
          return;
        }
        // Match by prefix
        const tasks = getTasksByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        const next = new Date(task.next_run).toLocaleString();
        const lastRun = task.last_run ? new Date(task.last_run).toLocaleString() : 'never';
        const lastResult = task.last_result ? escapeHtml(task.last_result.slice(0, 500)) : '(none)';
        const msg =
          `<b>Task</b> <code>${task.id.slice(0, 8)}</code>\n` +
          `<b>Status:</b> ${task.status}\n` +
          `<b>Prompt:</b> ${escapeHtml(task.prompt)}\n` +
          `<b>Schedule:</b> <code>${task.schedule}</code>\n` +
          `<b>Next run:</b> ${next}\n` +
          `<b>Last run:</b> ${lastRun}\n` +
          `<b>Last result:</b>\n${lastResult}`;
        const chunks = splitMessage(msg);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
        return;
      }

      case 'create': {
        // Extract two quoted strings: "prompt" "cron"
        const match = args.match(/^create\s+"([^"]+)"\s+"([^"]+)"$/i);
        if (!match) {
          await ctx.reply(
            'Usage: /schedule create "prompt" "cron"\n\n' +
              'Example:\n<code>/schedule create "What time is it?" "*/5 * * * *"</code>',
            { parse_mode: 'HTML' },
          );
          return;
        }
        const [, prompt, cron] = match;
        const error = validateCron(cron);
        if (error) {
          await ctx.reply(`Invalid cron: ${escapeHtml(error)}`, { parse_mode: 'HTML' });
          return;
        }
        const id = randomBytes(8).toString('hex');
        const nextRun = computeNextRun(cron);
        createTask(id, chatId, prompt, cron, nextRun);
        await ctx.reply(
          `Task created: <code>${id.slice(0, 8)}</code>\n` +
            `Prompt: ${escapeHtml(prompt)}\n` +
            `Schedule: <code>${cron}</code>\n` +
            `Next run: ${new Date(nextRun).toLocaleString()}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'pause': {
        const taskId = parts[1];
        if (!taskId) {
          await ctx.reply('Usage: /schedule pause &lt;id&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tasks = getTasksByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        pauseTask(task.id);
        await ctx.reply(`Task <code>${task.id.slice(0, 8)}</code> paused.`, { parse_mode: 'HTML' });
        return;
      }

      case 'resume': {
        const taskId = parts[1];
        if (!taskId) {
          await ctx.reply('Usage: /schedule resume &lt;id&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tasks = getTasksByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        const nextRun = computeNextRun(task.schedule);
        resumeTask(task.id);
        await ctx.reply(
          `Task <code>${task.id.slice(0, 8)}</code> resumed.\nNext run: ${new Date(nextRun).toLocaleString()}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'delete': {
        const taskId = parts[1];
        if (!taskId) {
          await ctx.reply('Usage: /schedule delete &lt;id&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tasks = getTasksByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        deleteTask(task.id);
        await ctx.reply(`Task <code>${task.id.slice(0, 8)}</code> deleted.`, { parse_mode: 'HTML' });
        return;
      }

      default:
        await ctx.reply(
          '<b>Scheduler commands:</b>\n\n' +
            '/schedule list — Show all tasks\n' +
            '/schedule show &lt;id&gt; — Task details + last result\n' +
            '/schedule create "prompt" "cron" — Create task\n' +
            '/schedule pause &lt;id&gt; — Pause task\n' +
            '/schedule resume &lt;id&gt; — Resume task\n' +
            '/schedule delete &lt;id&gt; — Delete task\n\n' +
            '<b>Cron examples:</b>\n' +
            '<code>*/5 * * * *</code> — every 5 minutes\n' +
            '<code>0 9 * * *</code> — daily at 9am\n' +
            '<code>0 9 * * 1-5</code> — weekdays at 9am',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Skill Command ────────────────────────────────────────

  bot.command('skill', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/skill(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const skills = listSkills();
        const lines = skills.map((s) => {
          const builtin = s.is_builtin ? ' (built-in)' : '';
          return `<code>${s.name}</code>${builtin} — ${escapeHtml(s.description)}`;
        });
        await ctx.reply(
          `<b>Available skills (${skills.length}):</b>\n\n${lines.join('\n')}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'show': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill show &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        const tools = skill.allowed_tools
          ? JSON.parse(skill.allowed_tools).join(', ')
          : 'all';
        const builtin = skill.is_builtin ? 'Yes' : 'No';
        await ctx.reply(
          `<b>Skill:</b> ${escapeHtml(skill.name)}\n` +
            `<b>Built-in:</b> ${builtin}\n` +
            `<b>Description:</b> ${escapeHtml(skill.description)}\n` +
            `<b>Tools:</b> ${tools}\n` +
            `<b>System prompt:</b>\n${escapeHtml(skill.system_prompt.slice(0, 500))}${skill.system_prompt.length > 500 ? '...' : ''}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'use': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill use &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found. Use /skill list to see available skills.');
          return;
        }
        setActiveSkill(chatId, skill.id);
        await ctx.reply(
          `Skill activated: <b>${escapeHtml(skill.name)}</b>\n${escapeHtml(skill.description)}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'off': {
        clearActiveSkill(chatId);
        await ctx.reply('Skill deactivated. Back to default behavior.');
        return;
      }

      case 'current': {
        const active = getActiveSkill(chatId);
        if (!active) {
          await ctx.reply('No skill active (using default).');
        } else {
          await ctx.reply(
            `Active skill: <b>${escapeHtml(active.name)}</b>\n${escapeHtml(active.description)}`,
            { parse_mode: 'HTML' },
          );
        }
        return;
      }

      case 'create': {
        // /skill create name "description" "system prompt"
        const match = args.match(/^create\s+(\S+)\s+"([^"]+)"\s+"([^"]+)"$/i);
        if (!match) {
          await ctx.reply(
            'Usage: /skill create name "description" "system prompt"\n\nExample:\n<code>/skill create myskill "My custom skill" "You are a helpful pirate assistant."</code>',
            { parse_mode: 'HTML' },
          );
          return;
        }
        const [, skillName, desc, prompt] = match;
        const existing = getSkillByName(skillName.toLowerCase());
        if (existing) {
          await ctx.reply(`Skill "${skillName}" already exists.`);
          return;
        }
        const id = `custom-${skillName.toLowerCase()}`;
        createSkill(id, skillName.toLowerCase(), desc, prompt, null, false);
        await ctx.reply(
          `Custom skill created: <b>${escapeHtml(skillName)}</b>\nActivate with: /skill use ${escapeHtml(skillName)}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'delete': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill delete &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        try {
          deleteSkill(skill.id);
          await ctx.reply(`Skill "${name}" deleted.`);
        } catch (err) {
          await ctx.reply(err instanceof Error ? err.message : 'Failed to delete skill.');
        }
        return;
      }

      case 'fix': {
        // /skill fix <name> <feedback>
        const fixName = parts[1];
        if (!fixName) {
          await ctx.reply('Usage: /skill fix &lt;name&gt; &lt;feedback&gt;', { parse_mode: 'HTML' });
          return;
        }
        const fixSkillObj = getSkillByName(fixName.toLowerCase());
        if (!fixSkillObj) {
          await ctx.reply('Skill not found.');
          return;
        }
        const feedback = parts.slice(2).join(' ');
        if (!feedback) {
          await ctx.reply('Please provide feedback. E.g.: /skill fix translator "also handle French"');
          return;
        }
        await ctx.reply(`Fixing skill "${fixName}"...`);
        const fixResult = await fixSkill(fixSkillObj.id, feedback, chatId, router);
        if ('error' in fixResult) {
          await ctx.reply(fixResult.error);
        } else {
          const preview = fixResult.newPrompt.slice(0, 300);
          await ctx.reply(
            `${fixResult.summary}\n\n<b>New prompt preview:</b>\n${escapeHtml(preview)}${fixResult.newPrompt.length > 300 ? '...' : ''}`,
            { parse_mode: 'HTML' },
          );
        }
        return;
      }

      case 'upload': {
        // Handle skill upload from a .md file attachment
        await handleSkillUpload(ctx);
        return;
      }

      case 'lock': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill lock &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        lockSkill(skill.id);
        await ctx.reply(`Skill "${name}" locked. It cannot be edited, fixed, or deleted until unlocked.`);
        return;
      }

      case 'unlock': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill unlock &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        unlockSkill(skill.id);
        await ctx.reply(`Skill "${name}" unlocked.`);
        return;
      }

      case 'export': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill export &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = getSkillByName(name);
        if (!skill) {
          await ctx.reply(`Skill "${name}" not found.`);
          return;
        }
        const filepath = exportSkillToMarkdown(skill);
        await ctx.replyWithDocument(new InputFile(filepath), {
          caption: `Skill "${name}" exported`,
        });
        return;
      }

      default:
        await ctx.reply(
          '<b>Skill commands:</b>\n\n' +
            '/skill list — Show all skills\n' +
            '/skill show &lt;name&gt; — Skill details\n' +
            '/skill use &lt;name&gt; — Activate a skill\n' +
            '/skill off — Deactivate current skill\n' +
            '/skill current — Show active skill\n' +
            '/skill create name "desc" "prompt" — Create custom skill\n' +
            '/skill upload — Reply to a .md file to upload a skill\n' +
            '/skill export &lt;name&gt; — Export skill to forge/skills/\n' +
            '/skill lock &lt;name&gt; — Lock skill (prevent edits)\n' +
            '/skill unlock &lt;name&gt; — Unlock skill\n' +
            '/skill fix &lt;name&gt; &lt;feedback&gt; — AI-rewrite skill prompt\n' +
            '/skill delete &lt;name&gt; — Delete custom skill',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Reload Command ──────────────────────────────────────

  bot.command('reload', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const count = loadUserTools();
    await ctx.reply(`Reloaded. ${count} user tools active.`);
  });

  // ── Digest Command ──────────────────────────────────────

  bot.command('digest', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/digest(@\w+)?/, '').trim().toLowerCase();

    if (args === 'daily' || args === 'weekly' || args === 'off') {
      setDigestPreference(chatId, args as DigestFrequency);
      if (args === 'off') {
        await ctx.reply('Digest disabled.');
      } else {
        await ctx.reply(`Digest set to <b>${args}</b>. I'll send you activity summaries.`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (args === 'now') {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const digest = buildDigest(chatId, DAY_MS);
      await ctx.reply(formatForTelegram(digest), { parse_mode: 'HTML' });
      return;
    }

    // Show current setting
    const current = getDigestPreference(chatId);
    await ctx.reply(
      `Digest: <b>${current}</b>\n\n` +
        'Usage:\n' +
        '/digest daily — Daily activity summary\n' +
        '/digest weekly — Weekly activity summary\n' +
        '/digest off — Disable digests\n' +
        '/digest now — Show digest right now',
      { parse_mode: 'HTML' },
    );
  });

  // ── Tool Command ────────────────────────────────────────

  bot.command('tool', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/tool(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const allTools = listRegisteredTools();
        const userTools = listUserTools();
        const lines: string[] = [];

        for (const t of allTools) {
          const userInfo = userTools.find((u) => u.name === t.name);
          const extra: string[] = [`${t.source}`];
          if (userInfo) {
            if (!userInfo.enabled) extra.push('disabled');
            if (userInfo.locked) extra.push('locked');
          }
          lines.push(`<code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.description)} [${extra.join(', ')}]`);
        }

        // Also show disabled user tools not in registry
        for (const t of userTools) {
          if (!allTools.some((a) => a.name === t.name)) {
            lines.push(`<code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.description)} [${t.tool_type}, disabled]`);
          }
        }

        await ctx.reply(
          `<b>Available tools (${lines.length}):</b>\n\n${lines.join('\n')}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'show': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /tool show &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }

        // Check user tools first
        const userTool = getUserToolByName(name.toLowerCase());
        if (userTool) {
          const toolConfig = JSON.parse(userTool.config);
          const configPreview = JSON.stringify(toolConfig, null, 2).slice(0, 500);
          await ctx.reply(
            `<b>Tool:</b> ${escapeHtml(userTool.name)}\n` +
              `<b>Type:</b> ${userTool.tool_type}\n` +
              `<b>Description:</b> ${escapeHtml(userTool.description)}\n` +
              `<b>Enabled:</b> ${userTool.enabled ? 'Yes' : 'No'}\n` +
              `<b>Locked:</b> ${userTool.locked ? 'Yes' : 'No'}\n` +
              `<b>Source:</b> ${userTool.source_file || 'manual'}\n` +
              `<b>Config:</b>\n<pre>${escapeHtml(configPreview)}${configPreview.length >= 500 ? '...' : ''}</pre>`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        // Check builtin tools via registry
        const allTools = listRegisteredTools();
        const builtinMatch = allTools.find((t) => t.name === name.toLowerCase());
        if (builtinMatch) {
          await ctx.reply(
            `<b>Tool:</b> ${escapeHtml(builtinMatch.name)}\n<b>Type:</b> ${builtinMatch.source}\n<b>Description:</b> ${escapeHtml(builtinMatch.description)}`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        await ctx.reply('Tool not found.');
        return;
      }

      case 'fix': {
        const fixName = parts[1];
        if (!fixName) {
          await ctx.reply('Usage: /tool fix &lt;name&gt; &lt;feedback&gt;', { parse_mode: 'HTML' });
          return;
        }
        const fixToolObj = getUserToolByName(fixName.toLowerCase());
        if (!fixToolObj) {
          await ctx.reply('User tool not found. (Only user-created tools can be fixed.)');
          return;
        }
        const fixFeedback = parts.slice(2).join(' ');
        if (!fixFeedback) {
          await ctx.reply('Please provide feedback. E.g.: /tool fix weather "wrong response format"');
          return;
        }
        const chatId = String(ctx.chat!.id);
        await ctx.reply(`Fixing tool "${fixName}"...`);
        const fixResult = await fixTool(fixToolObj.id, fixFeedback, chatId, router);
        if ('error' in fixResult) {
          await ctx.reply(fixResult.error);
        } else {
          await ctx.reply(fixResult.summary);
        }
        return;
      }

      case 'upload': {
        await handleToolUpload(ctx, router);
        return;
      }

      case 'enable': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool enable &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = getUserToolByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        enableUserTool(tool.id);
        loadUserTools();
        await ctx.reply(`Tool "${name}" enabled.`);
        return;
      }

      case 'disable': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool disable &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = getUserToolByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        disableUserTool(tool.id);
        loadUserTools();
        await ctx.reply(`Tool "${name}" disabled.`);
        return;
      }

      case 'lock': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool lock &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = getUserToolByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        lockUserTool(tool.id);
        await ctx.reply(`Tool "${name}" locked.`);
        return;
      }

      case 'unlock': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool unlock &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = getUserToolByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        unlockUserTool(tool.id);
        await ctx.reply(`Tool "${name}" unlocked.`);
        return;
      }

      case 'delete': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = getUserToolByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        if (tool.locked) { await ctx.reply('Tool is locked. Unlock it first.'); return; }
        deleteUserTool(tool.id);
        loadUserTools();
        await ctx.reply(`Tool "${name}" deleted.`);
        return;
      }

      case 'export': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /tool export &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tool = getUserToolByName(name);
        if (!tool) {
          await ctx.reply(`User tool "${name}" not found. Only user-created tools can be exported.`);
          return;
        }
        const filepath = exportToolToMarkdown(tool);
        await ctx.replyWithDocument(new InputFile(filepath), {
          caption: `Tool "${name}" exported`,
        });
        return;
      }

      default:
        await ctx.reply(
          '<b>Tool commands:</b>\n\n' +
            '/tool list — Show all tools\n' +
            '/tool show &lt;name&gt; — Tool details\n' +
            '/tool upload — Reply to a .md file to upload a tool\n' +
            '/tool export &lt;name&gt; — Export tool to forge/tools/\n' +
            '/tool enable &lt;name&gt; — Enable a tool\n' +
            '/tool disable &lt;name&gt; — Disable a tool\n' +
            '/tool lock &lt;name&gt; — Lock tool (prevent edits)\n' +
            '/tool unlock &lt;name&gt; — Unlock tool\n' +
            '/tool fix &lt;name&gt; &lt;feedback&gt; — AI-fix tool\n' +
            '/tool delete &lt;name&gt; — Delete user tool',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Voice Handler ─────────────────────────────────────────

  bot.on('message:voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;

    const caps = await voiceCapabilities();
    if (!caps.stt) {
      await ctx.reply('Voice transcription is not available (Speaches not running).');
      return;
    }

    try {
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply('Could not download voice note.');
        return;
      }

      // Download to workspace/uploads/
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await ctx.reply('Failed to download voice note.');
        return;
      }

      const { UPLOADS_DIR } = await import('../config.js');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      mkdirSync(UPLOADS_DIR, { recursive: true });
      const ext = filePath.split('.').pop() || 'oga';
      const localPath = resolve(
        UPLOADS_DIR,
        `${Date.now()}_voice.${ext}`,
      );
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buffer);

      // Transcribe
      const transcript = await transcribeAudio(localPath);
      logger.info({ chatId: ctx.chat.id, transcript }, 'Voice transcribed');

      // Process as text with voice reply forced and voice prompt tuning
      await handleMessage(
        ctx,
        transcript,
        router,
        true,
        false,
        true,
      );
    } catch (err) {
      logger.error({ err }, 'Voice handler failed');
      await ctx.reply('Failed to process voice note.').catch(() => {});
    }
  });

  // ── Photo Handler ─────────────────────────────────────────

  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const caption = ctx.message.caption || 'Describe what you see in this photo.';

    try {
      // Get highest-resolution photo (last in array)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const filePath = file.file_path;

      if (!filePath) {
        await handleMessage(ctx, `[Photo received] ${caption}`, router);
        return;
      }

      // Download to workspace/uploads/
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await handleMessage(ctx, `[Photo received] ${caption}`, router);
        return;
      }

      const { UPLOADS_DIR } = await import('../config.js');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      mkdirSync(UPLOADS_DIR, { recursive: true });
      const ext = filePath.split('.').pop() || 'jpg';
      const localPath = resolve(UPLOADS_DIR, `${Date.now()}_photo.${ext}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buffer);

      logger.info({ chatId: ctx.chat.id, path: localPath }, 'Photo downloaded');

      // Branch based on provider: Ollama gets base64 images, Claude gets file path
      const providerName = router.getProviderName(String(ctx.chat.id));

      if (providerName === 'ollama') {
        // Ollama vision: pass image as base64 via images param
        const base64Image = buffer.toString('base64');
        const chatId = String(ctx.chat.id);
        const memoryContext = await buildMemoryContext(chatId, caption);
        const fullMessage = memoryContext
          ? `${memoryContext}\n\n${caption}`
          : caption;

        let typingInterval: ReturnType<typeof setInterval> | undefined;
        const refreshTyping = () => {
          ctx.replyWithChatAction('typing').catch(() => {});
        };
        refreshTyping();
        typingInterval = setInterval(refreshTyping, TYPING_REFRESH_MS);

        try {
          const response = await router.sendMessage({
            chatId,
            message: fullMessage,
            onTyping: refreshTyping,
            images: [base64Image],
          });

          clearInterval(typingInterval);
          typingInterval = undefined;

          if (!response.text) {
            await ctx.reply('(No response from AI provider)');
            return;
          }

          saveConversationTurn(chatId, `[Photo] ${caption}`, response.text).catch((err) => {
            logger.warn({ err }, 'Failed to save conversation memory');
          });

          const formatted = formatForTelegram(response.text);
          const chunks = splitMessage(formatted);
          for (const chunk of chunks) {
            try {
              await ctx.reply(chunk, { parse_mode: 'HTML' });
            } catch {
              await ctx.reply(chunk);
            }
          }
        } finally {
          if (typingInterval) clearInterval(typingInterval);
        }
      } else {
        // Claude: pass file path so CLI can read the image via its Read tool
        await handleMessage(
          ctx,
          `The user sent a photo. It has been saved to: ${localPath}\nPlease read/view this image file and respond to: ${caption}`,
          router,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Photo handler failed');
      await handleMessage(ctx, `[Photo received] ${caption}`, router);
    }
  });

  // ── Document Handler ──────────────────────────────────────

  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const doc = ctx.message.document;
    const caption = (ctx.message.caption || '').trim();
    const fileName = doc.file_name || 'unknown';

    // Intercept /skill upload and /tool upload captions
    if (caption.startsWith('/skill upload')) {
      await handleSkillUpload(ctx);
      return;
    }
    if (caption.startsWith('/tool upload')) {
      await handleToolUpload(ctx, router);
      return;
    }

    // Check file size (Telegram API limit is 20MB for bot downloads)
    if (doc.file_size && doc.file_size > 50 * 1024 * 1024) {
      await ctx.reply('File is too large (max 50MB).');
      return;
    }

    try {
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, router);
        return;
      }

      // Download to workspace/uploads/
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, router);
        return;
      }

      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      mkdirSync(UPLOADS_DIR, { recursive: true });
      const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buffer);

      // Parse the file
      const parsed = await parseFile(localPath, doc.mime_type);

      if (parsed.error) {
        // Parsing failed — fall back to basic message
        await handleMessage(
          ctx,
          `[Document received: ${fileName}] ${caption}\n\n(Could not parse: ${parsed.error})`,
          router,
        );
        return;
      }

      // Build message with parsed content
      const meta: string[] = [`[Document: ${fileName}]`];
      if (parsed.pageCount) meta.push(`Pages: ${parsed.pageCount}`);
      if (parsed.sheetCount) meta.push(`Sheets: ${parsed.sheetCount}`);
      if (parsed.truncated) meta.push('(Content was truncated)');

      const message = `${meta.join(' | ')}\n\n${parsed.text}${caption ? `\n\nUser caption: ${caption}` : ''}`;
      await handleMessage(ctx, message, router, false, true);
    } catch (err) {
      logger.error({ err }, 'Document handler failed');
      await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, router);
    }
  });

  // ── Text Handler (catch-all) ──────────────────────────────

  bot.on('message:text', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await handleMessage(ctx, ctx.message.text, router);
  });

  // ── Error Handler ─────────────────────────────────────────

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.chat?.id }, 'Bot error');
  });

  return bot;
}
