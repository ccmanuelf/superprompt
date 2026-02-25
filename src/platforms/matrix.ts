import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  LogService,
} from '@vector-im/matrix-bot-sdk';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { config, STORE_DIR, UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRouter } from '../providers/router.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import { getMemoriesByChatId } from '../db.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from '../voice.js';

// Per-room voice mode toggle
const voiceModeRooms = new Set<string>();

// ── Auth ────────────────────────────────────────────────────

function isAuthorised(userId: string): boolean {
  if (!config.MATRIX_ALLOWED_USERS) return true; // First-run mode
  const allowed = config.MATRIX_ALLOWED_USERS.split(',').map((u) => u.trim());
  return allowed.includes(userId);
}

// ── Formatting ──────────────────────────────────────────────

/**
 * Convert markdown to Matrix-compatible HTML.
 * Matrix supports org.matrix.custom.html with a broad HTML subset.
 */
export function formatForMatrix(text: string): string {
  // 1. Protect code blocks
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 2. Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // 3. Escape HTML
  result = escapeHtml(result);

  // 4. Markdown → HTML
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<em>$1</em>');
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');
  result = result.replace(/- \[ \]/g, '☐');
  result = result.replace(/- \[x\]/gi, '☑');
  result = result.replace(/^-{3,}$/gm, '<hr/>');
  result = result.replace(/^\*{3,}$/gm, '<hr/>');

  // Convert newlines to <br/> for proper display
  result = result.replace(/\n/g, '<br/>');

  // 5. Restore inline code + code blocks
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split a message for Matrix. Matrix has a generous limit but
 * very long messages can cause display issues in clients.
 */
function splitMessage(text: string, limit: number = 16384): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', limit);
    if (splitIdx <= 0) splitIdx = limit;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Message Pipeline ────────────────────────────────────────

async function handleMessage(
  client: MatrixClient,
  roomId: string,
  body: string,
  router: ProviderRouter,
): Promise<void> {
  // 1. Build memory context
  const memoryContext = buildMemoryContext(roomId, body);
  const fullMessage = memoryContext
    ? `${memoryContext}\n\n${body}`
    : body;

  try {
    // 2. Send to AI provider
    const response = await router.sendMessage({
      chatId: roomId,
      message: fullMessage,
    });

    if (!response.text) {
      await sendNotice(client, roomId, '(No response from AI provider)');
      return;
    }

    // 3. Save conversation memory
    saveConversationTurn(roomId, body, response.text);

    // 4. Voice reply if enabled
    const shouldVoice = voiceModeRooms.has(roomId);
    if (shouldVoice) {
      const caps = await voiceCapabilities();
      if (caps.tts) {
        try {
          const audio = await synthesizeSpeech(response.text);
          // Upload audio to Matrix media repo, then send as m.audio
          const mxcUrl = await client.uploadContent(audio, 'audio/mpeg', 'response.mp3');
          await client.sendMessage(roomId, {
            msgtype: 'm.audio',
            body: 'response.mp3',
            url: mxcUrl,
            info: { mimetype: 'audio/mpeg', size: audio.length },
          });
        } catch (err) {
          logger.warn({ err }, 'Matrix TTS failed, falling back to text');
        }
      }
    }

    // 5. Send text response as m.notice
    const plain = response.text;
    const html = formatForMatrix(response.text);
    const chunks = splitMessage(plain);
    const htmlChunks = splitMessage(html);

    for (let i = 0; i < chunks.length; i++) {
      await client.sendMessage(roomId, {
        msgtype: 'm.notice',
        body: chunks[i],
        format: 'org.matrix.custom.html',
        formatted_body: htmlChunks[i] || escapeHtml(chunks[i]),
      });
    }
  } catch (err) {
    logger.error({ err, roomId }, 'Matrix message handling failed');
    await sendNotice(client, roomId, 'Sorry, something went wrong processing your message.').catch(() => {});
  }
}

async function sendNotice(
  client: MatrixClient,
  roomId: string,
  text: string,
): Promise<void> {
  await client.sendMessage(roomId, {
    msgtype: 'm.notice',
    body: text,
  });
}

// ── Command Handlers ────────────────────────────────────────

async function handleCommand(
  client: MatrixClient,
  roomId: string,
  command: string,
  router: ProviderRouter,
): Promise<boolean> {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '!start':
    case '!help':
      await sendNotice(
        client,
        roomId,
        'Hello! I\'m clauded, your AI assistant.\n\n' +
          'Commands:\n' +
          '!newchat — Start a fresh session\n' +
          '!memory — Show stored memories\n' +
          '!voice — Toggle voice replies\n' +
          '!claude — Switch to Claude\n' +
          '!ollama — Switch to Ollama\n' +
          '!schedule — Manage scheduled tasks',
      );
      return true;

    case '!newchat':
    case '!forget':
      router.newChat(roomId);
      await sendNotice(client, roomId, 'Session cleared. Starting fresh.');
      return true;

    case '!memory': {
      const memories = getMemoriesByChatId(roomId);
      if (memories.length === 0) {
        await sendNotice(client, roomId, 'No memories stored yet.');
        return true;
      }
      const lines = memories.slice(0, 20).map(
        (m) =>
          `• [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''} (salience: ${m.salience.toFixed(2)})`,
      );
      await sendNotice(
        client,
        roomId,
        `Memories (${memories.length} total):\n\n${lines.join('\n')}`,
      );
      return true;
    }

    case '!voice': {
      if (voiceModeRooms.has(roomId)) {
        voiceModeRooms.delete(roomId);
        await sendNotice(client, roomId, 'Voice replies disabled.');
      } else {
        const caps = await voiceCapabilities();
        if (!caps.tts) {
          await sendNotice(
            client,
            roomId,
            'Voice service (Speaches) is not available. Start it with:\ndocker compose -f docker/speaches.yml up -d',
          );
          return true;
        }
        voiceModeRooms.add(roomId);
        await sendNotice(client, roomId, 'Voice replies enabled. Send !voice again to disable.');
      }
      return true;
    }

    case '!claude': {
      const result = router.switchProvider(roomId, 'claude');
      await sendNotice(client, roomId, `Switched to ${result} provider.`);
      return true;
    }

    case '!ollama': {
      const result = router.switchProvider(roomId, 'ollama');
      await sendNotice(client, roomId, `Switched to ${result} provider.`);
      return true;
    }

    case '!schedule':
      await sendNotice(
        client,
        roomId,
        'Scheduler commands:\n' +
          '!schedule list — Show active tasks\n' +
          '!schedule create "prompt" "cron" — Create task\n' +
          '!schedule pause <id> — Pause task\n' +
          '!schedule resume <id> — Resume task\n' +
          '!schedule delete <id> — Delete task',
      );
      return true;

    default:
      return false;
  }
}

// ── Voice Message Handler ───────────────────────────────────

async function handleVoiceMessage(
  client: MatrixClient,
  roomId: string,
  event: Record<string, unknown>,
  router: ProviderRouter,
): Promise<void> {
  const caps = await voiceCapabilities();
  if (!caps.stt) {
    await sendNotice(client, roomId, 'Voice transcription is not available (Speaches not running).');
    return;
  }

  try {
    const content = event.content as Record<string, unknown>;
    const mxcUrl = content.url as string;
    if (!mxcUrl) {
      await sendNotice(client, roomId, 'Could not get audio URL.');
      return;
    }

    // Download audio
    const audioData = await client.downloadContent(mxcUrl);
    const buffer = Buffer.isBuffer(audioData.data)
      ? audioData.data
      : Buffer.from(audioData.data as ArrayBuffer);

    mkdirSync(UPLOADS_DIR, { recursive: true });
    const localPath = resolve(UPLOADS_DIR, `${Date.now()}_voice.ogg`);
    writeFileSync(localPath, buffer);

    // Transcribe
    const transcript = await transcribeAudio(localPath);
    logger.info({ roomId, transcript }, 'Matrix voice transcribed');

    // Process as text
    await handleMessage(
      client,
      roomId,
      `[Voice transcribed]: ${transcript}`,
      router,
    );
  } catch (err) {
    logger.error({ err }, 'Matrix voice handler failed');
    await sendNotice(client, roomId, 'Failed to process voice message.').catch(() => {});
  }
}

// ── Bot Factory ─────────────────────────────────────────────

export async function createMatrixBot(
  router: ProviderRouter,
): Promise<MatrixClient> {
  // Silence the SDK's built-in logging
  LogService.setLevel({ includes: () => false } as never);

  const storage = new SimpleFsStorageProvider(
    resolve(STORE_DIR, 'matrix-bot.json'),
  );

  const client = new MatrixClient(
    config.MATRIX_HOMESERVER,
    config.MATRIX_ACCESS_TOKEN,
    storage,
  );

  // Auto-join rooms when invited
  AutojoinRoomsMixin.setupOnClient(client);

  const startTime = Date.now();
  const botUserId = await client.getUserId();

  logger.info({ botUserId }, 'Matrix bot initialized');

  // ── Event Handler ───────────────────────────────────────

  client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
    // Ignore own messages
    if (event.sender === botUserId) return;

    // Ignore messages from before bot started
    if ((event.origin_server_ts as number) < startTime) return;

    // Auth check
    if (!isAuthorised(event.sender as string)) return;

    const content = event.content as Record<string, unknown>;
    const msgtype = content?.msgtype as string;

    // Handle voice messages (m.audio with voice flag)
    if (msgtype === 'm.audio') {
      await handleVoiceMessage(client, roomId, event, router);
      return;
    }

    // Handle images
    if (msgtype === 'm.image') {
      const body = (content.body as string) || 'User sent an image.';
      await handleMessage(client, roomId, `[Image received] ${body}`, router);
      return;
    }

    // Handle files
    if (msgtype === 'm.file') {
      const body = (content.body as string) || 'unknown';
      await handleMessage(client, roomId, `[File received: ${body}]`, router);
      return;
    }

    // Only process m.text (ignore m.notice to prevent bot loops)
    if (msgtype !== 'm.text') return;

    const body = (content.body as string) || '';
    if (!body) return;

    // Check for commands (! prefix)
    if (body.startsWith('!')) {
      const handled = await handleCommand(client, roomId, body, router);
      if (handled) return;
    }

    // Regular message
    await handleMessage(client, roomId, body, router);
  });

  return client;
}
