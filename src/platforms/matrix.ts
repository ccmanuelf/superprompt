import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  LogService,
} from '@vector-im/matrix-bot-sdk';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { config, STORE_DIR, UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { ProviderRouter } from '../providers/router.js';
import { buildMemoryContext, saveConversationTurn } from '../memory.js';
import { getMemoriesByChatId, createTask, getTasksByChat, getTask, pauseTask, resumeTask, deleteTask, listSkills, getSkillByName, setActiveSkill, clearActiveSkill, getActiveSkill, createSkill, deleteSkill, lockSkill, unlockSkill, insertSkillRevision, updateSkill, listUserTools, getUserToolByName, createUserTool, deleteUserTool, enableUserTool, disableUserTool, lockUserTool, unlockUserTool, insertToolRevision } from '../db.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from '../voice.js';
import { computeNextRun, validateCron } from '../scheduler.js';
import { parseFile } from '../files.js';
import { isDocGenResponse, parseDocGenResponse, generateDocument, stripDocGenBlock } from '../docgen.js';
import { fixSkill } from '../forge/skill-fixer.js';
import { fixTool } from '../forge/tool-fixer.js';
import { listRegisteredTools, loadUserTools } from '../forge/tool-registry.js';

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
  // 1. Build memory context (hybrid: FTS5 + vector)
  const memoryContext = await buildMemoryContext(roomId, body);
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

    // 3. Save conversation memory (with embedding, fire-and-forget)
    saveConversationTurn(roomId, body, response.text).catch((err) => {
      logger.warn({ err }, 'Failed to save conversation memory');
    });

    // 3b. Check for document generation request in response
    if (isDocGenResponse(response.text)) {
      const docReq = parseDocGenResponse(response.text);
      if (docReq) {
        try {
          const result = await generateDocument(docReq);
          const mxcUrl = await client.uploadContent(result.buffer, result.mimeType, result.filename);
          await client.sendMessage(roomId, {
            msgtype: 'm.file',
            body: result.filename,
            url: mxcUrl,
            info: { mimetype: result.mimeType, size: result.buffer.length },
          });
          // Send any remaining text
          const remainingText = stripDocGenBlock(response.text);
          if (remainingText) {
            await sendNotice(client, roomId, remainingText);
          }
          return;
        } catch (err) {
          logger.warn({ err }, 'Matrix document generation failed, sending raw response');
        }
      }
    }

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
          '!schedule — Manage scheduled tasks\n' +
          '!skill — Manage AI skills\n' +
          '!tool — Manage tools (list, fix, etc.)\n' +
          '!reload — Reload user tools from DB',
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

    case '!schedule': {
      const schedArgs = command.replace(/^!schedule\s*/, '').trim();
      const schedParts = schedArgs.split(/\s+/);
      const subcommand = schedParts[0]?.toLowerCase() || 'help';

      switch (subcommand) {
        case 'list': {
          const tasks = getTasksByChat(roomId);
          if (tasks.length === 0) {
            await sendNotice(client, roomId, 'No scheduled tasks.');
            return true;
          }
          const lines = tasks.map((t) => {
            const next = new Date(t.next_run).toLocaleString();
            return `${t.id.slice(0, 8)} [${t.status}] ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '...' : ''}\n  ⏰ ${t.schedule} → next: ${next}`;
          });
          await sendNotice(client, roomId, `Scheduled tasks (${tasks.length}):\n\n${lines.join('\n\n')}`);
          return true;
        }

        case 'show': {
          const taskId = schedParts[1];
          if (!taskId) {
            await sendNotice(client, roomId, 'Usage: !schedule show <id>');
            return true;
          }
          const tasks = getTasksByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          const next = new Date(task.next_run).toLocaleString();
          const lastRun = task.last_run ? new Date(task.last_run).toLocaleString() : 'never';
          const lastResult = task.last_result ? task.last_result.slice(0, 500) : '(none)';
          await sendNotice(
            client,
            roomId,
            `Task ${task.id.slice(0, 8)}\nStatus: ${task.status}\nPrompt: ${task.prompt}\nSchedule: ${task.schedule}\nNext run: ${next}\nLast run: ${lastRun}\nLast result:\n${lastResult}`,
          );
          return true;
        }

        case 'create': {
          const match = schedArgs.match(/^create\s+"([^"]+)"\s+"([^"]+)"$/i);
          if (!match) {
            await sendNotice(
              client,
              roomId,
              'Usage: !schedule create "prompt" "cron"\n\nExample:\n!schedule create "What time is it?" "*/5 * * * *"',
            );
            return true;
          }
          const [, prompt, cron] = match;
          const error = validateCron(cron);
          if (error) {
            await sendNotice(client, roomId, `Invalid cron: ${error}`);
            return true;
          }
          const id = randomBytes(8).toString('hex');
          const nextRun = computeNextRun(cron);
          createTask(id, roomId, prompt, cron, nextRun);
          await sendNotice(
            client,
            roomId,
            `Task created: ${id.slice(0, 8)}\nPrompt: ${prompt}\nSchedule: ${cron}\nNext run: ${new Date(nextRun).toLocaleString()}`,
          );
          return true;
        }

        case 'pause': {
          const taskId = schedParts[1];
          if (!taskId) {
            await sendNotice(client, roomId, 'Usage: !schedule pause <id>');
            return true;
          }
          const tasks = getTasksByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          pauseTask(task.id);
          await sendNotice(client, roomId, `Task ${task.id.slice(0, 8)} paused.`);
          return true;
        }

        case 'resume': {
          const taskId = schedParts[1];
          if (!taskId) {
            await sendNotice(client, roomId, 'Usage: !schedule resume <id>');
            return true;
          }
          const tasks = getTasksByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          const nextRun = computeNextRun(task.schedule);
          resumeTask(task.id);
          await sendNotice(
            client,
            roomId,
            `Task ${task.id.slice(0, 8)} resumed.\nNext run: ${new Date(nextRun).toLocaleString()}`,
          );
          return true;
        }

        case 'delete': {
          const taskId = schedParts[1];
          if (!taskId) {
            await sendNotice(client, roomId, 'Usage: !schedule delete <id>');
            return true;
          }
          const tasks = getTasksByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          deleteTask(task.id);
          await sendNotice(client, roomId, `Task ${task.id.slice(0, 8)} deleted.`);
          return true;
        }

        default:
          await sendNotice(
            client,
            roomId,
            'Scheduler commands:\n\n' +
              '!schedule list — Show all tasks\n' +
              '!schedule show <id> — Task details + last result\n' +
              '!schedule create "prompt" "cron" — Create task\n' +
              '!schedule pause <id> — Pause task\n' +
              '!schedule resume <id> — Resume task\n' +
              '!schedule delete <id> — Delete task\n\n' +
              'Cron examples:\n' +
              '*/5 * * * * — every 5 minutes\n' +
              '0 9 * * * — daily at 9am\n' +
              '0 9 * * 1-5 — weekdays at 9am',
          );
          return true;
      }
    }

    case '!skill': {
      const skillArgs = command.replace(/^!skill\s*/, '').trim();
      const skillParts = skillArgs.split(/\s+/);
      const skillSub = skillParts[0]?.toLowerCase() || 'help';

      switch (skillSub) {
        case 'list': {
          const skills = listSkills();
          const lines = skills.map((s) => {
            const builtin = s.is_builtin ? ' (built-in)' : '';
            return `${s.name}${builtin} — ${s.description}`;
          });
          await sendNotice(client, roomId, `Available skills (${skills.length}):\n\n${lines.join('\n')}`);
          return true;
        }

        case 'show': {
          const name = skillParts[1];
          if (!name) {
            await sendNotice(client, roomId, 'Usage: !skill show <name>');
            return true;
          }
          const skill = getSkillByName(name.toLowerCase());
          if (!skill) {
            await sendNotice(client, roomId, 'Skill not found.');
            return true;
          }
          const tools = skill.allowed_tools
            ? JSON.parse(skill.allowed_tools).join(', ')
            : 'all';
          await sendNotice(
            client,
            roomId,
            `Skill: ${skill.name}\nBuilt-in: ${skill.is_builtin ? 'Yes' : 'No'}\nDescription: ${skill.description}\nTools: ${tools}\nSystem prompt:\n${skill.system_prompt.slice(0, 500)}${skill.system_prompt.length > 500 ? '...' : ''}`,
          );
          return true;
        }

        case 'use': {
          const name = skillParts[1];
          if (!name) {
            await sendNotice(client, roomId, 'Usage: !skill use <name>');
            return true;
          }
          const skill = getSkillByName(name.toLowerCase());
          if (!skill) {
            await sendNotice(client, roomId, 'Skill not found. Use !skill list to see available skills.');
            return true;
          }
          setActiveSkill(roomId, skill.id);
          await sendNotice(client, roomId, `Skill activated: ${skill.name}\n${skill.description}`);
          return true;
        }

        case 'off':
          clearActiveSkill(roomId);
          await sendNotice(client, roomId, 'Skill deactivated. Back to default behavior.');
          return true;

        case 'current': {
          const active = getActiveSkill(roomId);
          if (!active) {
            await sendNotice(client, roomId, 'No skill active (using default).');
          } else {
            await sendNotice(client, roomId, `Active skill: ${active.name}\n${active.description}`);
          }
          return true;
        }

        case 'create': {
          const match = skillArgs.match(/^create\s+(\S+)\s+"([^"]+)"\s+"([^"]+)"$/i);
          if (!match) {
            await sendNotice(
              client,
              roomId,
              'Usage: !skill create name "description" "system prompt"\n\nExample:\n!skill create myskill "My custom skill" "You are a helpful pirate assistant."',
            );
            return true;
          }
          const [, skillName, desc, prompt] = match;
          const existing = getSkillByName(skillName.toLowerCase());
          if (existing) {
            await sendNotice(client, roomId, `Skill "${skillName}" already exists.`);
            return true;
          }
          const id = `custom-${skillName.toLowerCase()}`;
          createSkill(id, skillName.toLowerCase(), desc, prompt, null, false);
          await sendNotice(client, roomId, `Custom skill created: ${skillName}\nActivate with: !skill use ${skillName}`);
          return true;
        }

        case 'delete': {
          const name = skillParts[1];
          if (!name) {
            await sendNotice(client, roomId, 'Usage: !skill delete <name>');
            return true;
          }
          const skill = getSkillByName(name.toLowerCase());
          if (!skill) {
            await sendNotice(client, roomId, 'Skill not found.');
            return true;
          }
          try {
            deleteSkill(skill.id);
            await sendNotice(client, roomId, `Skill "${name}" deleted.`);
          } catch (err) {
            await sendNotice(client, roomId, err instanceof Error ? err.message : 'Failed to delete skill.');
          }
          return true;
        }

        case 'fix': {
          const fixName = skillParts[1];
          if (!fixName) {
            await sendNotice(client, roomId, 'Usage: !skill fix <name> <feedback>');
            return true;
          }
          const fixSkillObj = getSkillByName(fixName.toLowerCase());
          if (!fixSkillObj) {
            await sendNotice(client, roomId, 'Skill not found.');
            return true;
          }
          const feedback = skillParts.slice(2).join(' ');
          if (!feedback) {
            await sendNotice(client, roomId, 'Please provide feedback.');
            return true;
          }
          await sendNotice(client, roomId, `Fixing skill "${fixName}"...`);
          const fixResult = await fixSkill(fixSkillObj.id, feedback, roomId, router);
          if ('error' in fixResult) {
            await sendNotice(client, roomId, fixResult.error);
          } else {
            await sendNotice(client, roomId, `${fixResult.summary}\n\nNew prompt preview:\n${fixResult.newPrompt.slice(0, 300)}${fixResult.newPrompt.length > 300 ? '...' : ''}`);
          }
          return true;
        }

        case 'lock': {
          const name = skillParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !skill lock <name>'); return true; }
          const skill = getSkillByName(name.toLowerCase());
          if (!skill) { await sendNotice(client, roomId, 'Skill not found.'); return true; }
          lockSkill(skill.id);
          await sendNotice(client, roomId, `Skill "${name}" locked.`);
          return true;
        }

        case 'unlock': {
          const name = skillParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !skill unlock <name>'); return true; }
          const skill = getSkillByName(name.toLowerCase());
          if (!skill) { await sendNotice(client, roomId, 'Skill not found.'); return true; }
          unlockSkill(skill.id);
          await sendNotice(client, roomId, `Skill "${name}" unlocked.`);
          return true;
        }

        default:
          await sendNotice(
            client,
            roomId,
            'Skill commands:\n\n' +
              '!skill list — Show all skills\n' +
              '!skill show <name> — Skill details\n' +
              '!skill use <name> — Activate a skill\n' +
              '!skill off — Deactivate current skill\n' +
              '!skill current — Show active skill\n' +
              '!skill create name "desc" "prompt" — Create custom skill\n' +
              '!skill fix <name> <feedback> — AI-rewrite skill prompt\n' +
              '!skill lock <name> — Lock skill\n' +
              '!skill unlock <name> — Unlock skill\n' +
              '!skill delete <name> — Delete custom skill',
          );
          return true;
      }
    }

    case '!tool': {
      const toolArgs = command.replace(/^!tool\s*/, '').trim();
      const toolParts = toolArgs.split(/\s+/);
      const toolSub = toolParts[0]?.toLowerCase() || 'help';

      switch (toolSub) {
        case 'list': {
          const allTools = listRegisteredTools();
          const userTools = listUserTools();
          const lines: string[] = [];
          for (const t of allTools) {
            const userInfo = userTools.find((u) => u.name === t.name);
            const extra: string[] = [t.source];
            if (userInfo) {
              if (!userInfo.enabled) extra.push('disabled');
              if (userInfo.locked) extra.push('locked');
            }
            lines.push(`${t.name} — ${t.description} [${extra.join(', ')}]`);
          }
          for (const t of userTools) {
            if (!allTools.some((a) => a.name === t.name)) {
              lines.push(`${t.name} — ${t.description} [${t.tool_type}, disabled]`);
            }
          }
          await sendNotice(client, roomId, `Available tools (${lines.length}):\n\n${lines.join('\n')}`);
          return true;
        }

        case 'show': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool show <name>'); return true; }
          const userTool = getUserToolByName(name.toLowerCase());
          if (userTool) {
            await sendNotice(client, roomId,
              `Tool: ${userTool.name}\nType: ${userTool.tool_type}\nDescription: ${userTool.description}\nEnabled: ${userTool.enabled ? 'Yes' : 'No'}\nLocked: ${userTool.locked ? 'Yes' : 'No'}`);
            return true;
          }
          const builtinMatch = listRegisteredTools().find((t) => t.name === name.toLowerCase());
          if (builtinMatch) {
            await sendNotice(client, roomId, `Tool: ${builtinMatch.name}\nType: ${builtinMatch.source}\nDescription: ${builtinMatch.description}`);
            return true;
          }
          await sendNotice(client, roomId, 'Tool not found.');
          return true;
        }

        case 'enable': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool enable <name>'); return true; }
          const tool = getUserToolByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          enableUserTool(tool.id);
          loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" enabled.`);
          return true;
        }

        case 'disable': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool disable <name>'); return true; }
          const tool = getUserToolByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          disableUserTool(tool.id);
          loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" disabled.`);
          return true;
        }

        case 'lock': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool lock <name>'); return true; }
          const tool = getUserToolByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          lockUserTool(tool.id);
          await sendNotice(client, roomId, `Tool "${name}" locked.`);
          return true;
        }

        case 'unlock': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool unlock <name>'); return true; }
          const tool = getUserToolByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          unlockUserTool(tool.id);
          await sendNotice(client, roomId, `Tool "${name}" unlocked.`);
          return true;
        }

        case 'fix': {
          const fixName = toolParts[1];
          if (!fixName) { await sendNotice(client, roomId, 'Usage: !tool fix <name> <feedback>'); return true; }
          const tool = getUserToolByName(fixName.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          const feedback = toolParts.slice(2).join(' ');
          if (!feedback) { await sendNotice(client, roomId, 'Please provide feedback.'); return true; }
          await sendNotice(client, roomId, `Fixing tool "${fixName}"...`);
          const result = await fixTool(tool.id, feedback, roomId, router);
          if ('error' in result) {
            await sendNotice(client, roomId, result.error);
          } else {
            await sendNotice(client, roomId, result.summary);
          }
          return true;
        }

        case 'delete': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool delete <name>'); return true; }
          const tool = getUserToolByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          if (tool.locked) { await sendNotice(client, roomId, 'Tool is locked. Unlock it first.'); return true; }
          deleteUserTool(tool.id);
          loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" deleted.`);
          return true;
        }

        default:
          await sendNotice(client, roomId,
            'Tool commands:\n\n' +
            '!tool list — Show all tools\n' +
            '!tool show <name> — Tool details\n' +
            '!tool enable <name> — Enable a tool\n' +
            '!tool disable <name> — Disable a tool\n' +
            '!tool lock <name> — Lock tool\n' +
            '!tool unlock <name> — Unlock tool\n' +
            '!tool fix <name> <feedback> — AI-fix tool\n' +
            '!tool delete <name> — Delete user tool');
          return true;
      }
    }

    case '!reload': {
      const count = loadUserTools();
      await sendNotice(client, roomId, `Reloaded. ${count} user tools active.`);
      return true;
    }

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

    // Handle images — download from MXC
    if (msgtype === 'm.image') {
      const caption = (content.body as string) || 'Describe what you see in this photo.';
      const mxcUrl = content.url as string;
      const imageInfo = content.info as Record<string, unknown> | undefined;
      const imageMime = (imageInfo?.mimetype as string) || 'image/jpeg';

      if (mxcUrl) {
        try {
          const imageData = await client.downloadContent(mxcUrl);
          const buffer = Buffer.isBuffer(imageData.data)
            ? imageData.data
            : Buffer.from(imageData.data as ArrayBuffer);

          mkdirSync(UPLOADS_DIR, { recursive: true });
          const ext = imageMime.split('/')[1] || 'jpg';
          const localPath = resolve(UPLOADS_DIR, `${Date.now()}_photo.${ext}`);
          writeFileSync(localPath, buffer);

          logger.info({ roomId, path: localPath }, 'Matrix photo downloaded');

          await handleMessage(
            client,
            roomId,
            `The user sent a photo. It has been saved to: ${localPath}\nPlease read/view this image file and respond to: ${caption}`,
            router,
          );
          return;
        } catch (err) {
          logger.error({ err }, 'Matrix photo handler failed');
        }
      }

      await handleMessage(client, roomId, `[Image received] ${caption}`, router);
      return;
    }

    // Handle files — download and parse
    if (msgtype === 'm.file') {
      const fileName = (content.body as string) || 'unknown';
      const mxcUrl = content.url as string;
      const fileInfo = content.info as Record<string, unknown> | undefined;
      const fileSize = (fileInfo?.size as number) || 0;
      const fileMime = (fileInfo?.mimetype as string) || undefined;

      if (fileSize > 50 * 1024 * 1024) {
        await sendNotice(client, roomId, 'File is too large (max 50MB).');
        return;
      }

      if (mxcUrl) {
        try {
          const fileData = await client.downloadContent(mxcUrl);
          const buffer = Buffer.isBuffer(fileData.data)
            ? fileData.data
            : Buffer.from(fileData.data as ArrayBuffer);

          mkdirSync(UPLOADS_DIR, { recursive: true });
          const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`);
          writeFileSync(localPath, buffer);

          const parsed = await parseFile(localPath, fileMime);

          if (parsed.error) {
            await handleMessage(client, roomId, `[File received: ${fileName}] (Could not parse: ${parsed.error})`, router);
            return;
          }

          const meta: string[] = [`[Document: ${fileName}]`];
          if (parsed.pageCount) meta.push(`Pages: ${parsed.pageCount}`);
          if (parsed.sheetCount) meta.push(`Sheets: ${parsed.sheetCount}`);
          if (parsed.truncated) meta.push('(Content was truncated)');

          await handleMessage(client, roomId, `${meta.join(' | ')}\n\n${parsed.text}`, router);
          return;
        } catch (err) {
          logger.error({ err }, 'Matrix file handler failed');
        }
      }

      await handleMessage(client, roomId, `[File received: ${fileName}]`, router);
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
