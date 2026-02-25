import { Bot, Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRouter } from '../providers/router.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import { getMemoriesByChatId } from '../db.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from '../voice.js';

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
): Promise<void> {
  const chatId = String(ctx.chat!.id);

  // 1. Build memory context
  const memoryContext = buildMemoryContext(chatId, rawText);
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
    // 3. Send to AI provider
    const response = await router.sendMessage({
      chatId,
      message: fullMessage,
      onTyping: refreshTyping,
    });

    // 4. Stop typing
    clearInterval(typingInterval);
    typingInterval = undefined;

    if (!response.text) {
      await ctx.reply('(No response from AI provider)');
      return;
    }

    // 5. Save conversation memory
    saveConversationTurn(chatId, rawText, response.text);

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
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Message handling failed');
    await ctx.reply('Sorry, something went wrong processing your message.').catch(() => {});
  } finally {
    if (typingInterval) clearInterval(typingInterval);
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
        '/schedule — Manage scheduled tasks',
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
    await ctx.reply(`Switched to <b>${result}</b> provider.`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('schedule', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    // Placeholder — full implementation in Phase 7
    await ctx.reply(
      'Scheduler commands:\n' +
        '/schedule list — Show active tasks\n' +
        '/schedule create "prompt" "cron" — Create task\n' +
        '/schedule pause <id> — Pause task\n' +
        '/schedule resume <id> — Resume task\n' +
        '/schedule delete <id> — Delete task',
    );
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

      // Process as text with voice reply forced
      await handleMessage(
        ctx,
        `[Voice transcribed]: ${transcript}`,
        router,
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
    const caption = ctx.message.caption || 'User sent a photo. Describe what you see.';
    // Photo analysis will be enhanced in Phase 8 (Media)
    await handleMessage(ctx, `[Photo received] ${caption}`, router);
  });

  // ── Document Handler ──────────────────────────────────────

  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const doc = ctx.message.document;
    const caption = ctx.message.caption || '';
    const fileName = doc.file_name || 'unknown';
    // Document handling will be enhanced in Phase 8 (Media)
    await handleMessage(
      ctx,
      `[Document received: ${fileName}] ${caption}`,
      router,
    );
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
