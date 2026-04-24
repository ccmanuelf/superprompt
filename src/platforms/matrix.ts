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
import { generateTraceId, withTrace, getTraceId } from '../trace.js';
import type { PlatformContext } from '../core/context.js';
import type { CardStatus, CardAssignee } from '../kanban.js';
import type { DigestFrequency } from '../proactive.js';

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
  ctx: PlatformContext,
  isVoice: boolean = false,
): Promise<void> {
  return withTrace(generateTraceId(), () => handleMessageInner(client, roomId, body, ctx, isVoice));
}

async function handleMessageInner(
  client: MatrixClient,
  roomId: string,
  body: string,
  ctx: PlatformContext,
  isVoice: boolean = false,
): Promise<void> {
  const router = ctx.router;

  // 0. Check for pending auto-skill proposal response
  const pendingProposal = await ctx.autoSkills.getPending(roomId);
  if (pendingProposal) {
    const proposalAction = ctx.autoSkills.detectResponse(body);
    if (proposalAction) {
      const confirmation = await ctx.autoSkills.handleResponse(roomId, proposalAction === 'approve');
      await client.sendMessage(roomId, {
        msgtype: 'm.notice',
        body: confirmation,
        format: 'org.matrix.custom.html',
        formatted_body: formatForMatrix(confirmation),
      });
      return;
    }
    ctx.autoSkills.expirePending(roomId);
  }

  // 0a. Check for pending tool confirmation (SA4 policy engine)
  const pendingToolConfirm = ctx.policyEngine.getPendingConfirmation(roomId);
  if (pendingToolConfirm) {
    const confirmAction = ctx.policyEngine.detectConfirmation(body);
    if (confirmAction) {
      const { executeTool } = await import('../providers/tools/index.js');
      const confirmResult = await ctx.policyEngine.handleConfirmation(roomId, confirmAction, executeTool);
      if (confirmResult.message) {
        await client.sendMessage(roomId, {
          msgtype: 'm.notice', body: confirmResult.message,
          format: 'org.matrix.custom.html', formatted_body: formatForMatrix(confirmResult.message),
        });
      }
      if (confirmResult.executed && confirmResult.result) {
        const aiResponse = await router.sendMessage({
          chatId: roomId,
          message: `Tool "${pendingToolConfirm.toolName}" executed. Result: ${JSON.stringify(confirmResult.result)}`,
          skipTools: true,
          skipTurnLog: true,
          platform: 'matrix',
        });
        if (aiResponse.text) {
          await client.sendMessage(roomId, {
            msgtype: 'm.notice', body: aiResponse.text,
            format: 'org.matrix.custom.html', formatted_body: formatForMatrix(aiResponse.text),
          });
        }
      }
      return;
    }
    ctx.policyEngine.clearPendingConfirmation(roomId);
  }

  // 0b. Skill self-healing: detect user corrections when a skill is active
  const activeSkillForHealing = await ctx.skills.getActive(roomId);
  if (activeSkillForHealing && ctx.autoSkills.detectCorrection(body)) {
    try {
      const healResult = await ctx.autoSkills.heal(
        activeSkillForHealing,
        `User corrected the approach: "${body}"`,
        body,
        router,
        roomId,
      );
      if (healResult.patched) {
        await client.sendMessage(roomId, {
          msgtype: 'm.notice',
          body: healResult.summary,
          format: 'org.matrix.custom.html',
          formatted_body: formatForMatrix(healResult.summary),
        });
      }
    } catch {
      // Non-blocking
    }
  }

  // 1. Build memory context (hybrid: FTS5 + vector)
  const memoryContext = await ctx.memory.buildContext(roomId, body);
  const fullMessage = memoryContext
    ? `${memoryContext}\n\n${body}`
    : body;

  try {
    // 1b. Check for multi-step orchestration (on raw message, not memory-augmented)
    if (!isVoice && ctx.orchestrator.shouldOrchestrate(body)) {
      const progressFn = async (_chatId: string, text: string) => {
        await sendNotice(client, roomId, text);
      };

      const response = await ctx.orchestrator.orchestrateTask(router, roomId, fullMessage, progressFn);

      if (response.text) {
        ctx.memory.saveConversationTurn(roomId, body, response.text).catch((err) => {
          logger.warn({ err }, 'Failed to save orchestration memory');
        });

        const plain = response.text;
        const html = formatForMatrix(response.text);
        await client.sendMessage(roomId, {
          msgtype: 'm.notice',
          body: plain,
          format: 'org.matrix.custom.html',
          formatted_body: html,
        });
      }
      return;
    }

    // 2. Send to AI provider
    const response = await router.sendMessage({
      chatId: roomId,
      message: fullMessage,
      rawUserMessage: body,
      isVoice,
      platform: 'matrix',
    });

    // Send auto-trigger notice if a skill was activated for this message
    if (response.autoTriggerNotice) {
      await sendNotice(client, roomId, response.autoTriggerNotice);
    }

    if (!response.text) {
      await sendNotice(client, roomId, '(No response from AI provider)');
      return;
    }

    // 2c. Quality check (non-blocking)
    const quality = ctx.selfMonitor.checkQuality(response, body);
    if (!quality.passed) {
      ctx.selfMonitor.logCheck(roomId, response.provider, quality.score, quality.issues);
    }

    // 2b. Skill self-healing: if a skill was active and quality was low, patch it
    const currentSkillForHealing = await ctx.skills.getActive(roomId);
    if (currentSkillForHealing && ctx.autoSkills.shouldHeal(currentSkillForHealing, quality.score ?? (quality.passed ? 80 : 40))) {
      try {
        const healResult = await ctx.autoSkills.heal(
          currentSkillForHealing,
          `Low quality response (score: ${quality.score ?? 'unknown'})`,
          `User asked: "${body}"\nAI responded: "${response.text?.slice(0, 500) || '(empty)'}"`,
          router,
          roomId,
        );
        if (healResult.patched) {
          await client.sendMessage(roomId, {
            msgtype: 'm.notice',
            body: healResult.summary,
            format: 'org.matrix.custom.html',
            formatted_body: formatForMatrix(healResult.summary),
          });
        }
      } catch {
        // Non-blocking
      }
    }

    // 2c. Auto-skill detection for single-turn tool chains (3+ distinct tools)
    // rc.70: skip failed workflows — max iterations or 2+ tool errors.
    const workflowFailed = response.hitMaxIterations || (response.toolErrorCount ?? 0) >= 2;
    if (response.toolsUsed && response.toolsUsed.length >= 3 && !workflowFailed) {
      try {
        const candidate = await ctx.autoSkills.detectCandidate({
          toolsUsed: response.toolsUsed,
          qualityScore: quality.passed ? 80 : quality.score ?? 0,
          chatId: roomId,
          originalRequest: body,
        });
        if (candidate) {
          const proposal = await ctx.autoSkills.draftDefinition(candidate, router, roomId);
          if (proposal) {
            ctx.autoSkills.insertProposal(proposal);
            const proposalMsg = ctx.autoSkills.proposeToUser(proposal);
            await client.sendMessage(roomId, {
              msgtype: 'm.notice',
              body: proposalMsg,
              format: 'org.matrix.custom.html',
              formatted_body: formatForMatrix(proposalMsg),
            });
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Auto-skill detection skipped (non-blocking)');
      }
    }

    // 3. Save conversation memory (with embedding, fire-and-forget)
    ctx.memory.saveConversationTurn(roomId, body, response.text).catch((err) => {
      logger.warn({ err }, 'Failed to save conversation memory');
    });

    // 3b. Process structured actions in response (docgen, kanban)
    let responseText = response.text;

    if (ctx.docgen.isResponse(responseText)) {
      const docReq = ctx.docgen.parseResponse(responseText);
      if (docReq) {
        try {
          const result = await ctx.docgen.generate(docReq);
          const mxcUrl = await client.uploadContent(result.buffer, result.mimeType, result.filename);
          await client.sendMessage(roomId, {
            msgtype: 'm.file',
            body: result.filename,
            url: mxcUrl,
            info: { mimetype: result.mimeType, size: result.buffer.length },
          });
          responseText = ctx.docgen.stripBlock(responseText);
        } catch (err) {
          logger.warn({ err }, 'Matrix document generation failed, sending raw response');
        }
      }
    }

    // rc.74: Only auto-execute when user's current message actually
    // asked for a board/task/kanban operation (English OR Spanish).
    if (responseText && ctx.kanban.isKanbanAction(responseText)) {
      const userWantsKanban =
        /\b(board|kanban|task|card|ticket|todo|to-?do|tablero|tarea|tarjeta|pendiente|pendientes|por hacer)\b/i.test(body);
      if (userWantsKanban) {
        const kanbanReq = ctx.kanban.parseKanbanAction(responseText);
        if (kanbanReq) {
          const kanbanResult = await ctx.kanban.executeKanbanAction(roomId, kanbanReq);
          await sendNotice(client, roomId, kanbanResult);
          responseText = ctx.kanban.stripKanbanBlock(responseText);
        }
      } else {
        logger.debug({ roomId }, 'Kanban JSON in response but user did not request board/task action — stripping without creating');
        responseText = ctx.kanban.stripKanbanBlock(responseText);
      }
    }

    response.text = responseText;
    if (!response.text) return;

    // 4. Voice reply if enabled (force when message was voice)
    const shouldVoice = isVoice || voiceModeRooms.has(roomId);
    if (shouldVoice) {
      const caps = await ctx.voice.capabilities();
      if (caps.tts) {
        try {
          const audio = await ctx.voice.synthesize(response.text);
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
    const traceId = getTraceId();
    const traceSuffix = traceId ? ` (trace: ${traceId})` : '';
    await sendNotice(client, roomId, `Sorry, something went wrong processing your message.${traceSuffix}`).catch(() => {});
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

/**
 * Render feature-contributed help blocks from the feature-awareness
 * registry (rc.92). Lazy-imported here to keep matrix.ts agnostic
 * about which features are loaded.
 */
async function renderMatrixFeatureBlocks(): Promise<string> {
  const { renderMatrixHelpSections } = await import('../core/feature-awareness.js');
  const blocks = renderMatrixHelpSections();
  return blocks ? blocks + '\n\n' : '';
}

async function handleCommand(
  client: MatrixClient,
  roomId: string,
  command: string,
  ctx: PlatformContext,
): Promise<boolean> {
  const router = ctx.router;
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '!start':
    case '!help':
      await sendNotice(
        client,
        roomId,
        'Luna — Command Reference\n\n' +

          '💬 Chat & AI\n' +
          '!newchat — Clear conversation history\n' +
          '!memory — Show stored memories\n' +
          '!claude / !ollama / !auto — Switch provider\n' +
          '!provider — Show current provider\n' +
          '!models — List Ollama models\n' +
          '!model <name> — Switch Ollama model\n\n' +

          '🎤 Voice\n' +
          '!voice — Toggle always-voice replies\n\n' +

          '🧠 Skills & Tools\n' +
          '!skill list|use|create|fix|off — Manage skills\n' +
          '!tool list|show|upload|generate|fix — Manage tools\n' +
          '!careful — Safety guardrails mode\n' +
          '!reload — Reload user tools\n\n' +

          '📋 Productivity\n' +
          '!board — Kanban board (view|move|assign|priority|due)\n' +
          '!schedule — Tasks (create|list|pause|resume|delete)\n' +
          '!digest — Digests (daily|weekly|now|off)\n' +
          '!learn — Learning coach (plan|session|status)\n' +
          '!research — Search academic papers\n' +
          '!cite — Manage citations\n\n' +

          '🏭 Manufacturing — Web Dashboards\n' +
          '!sim — Production simulation\n' +
          '!capacity — Capacity planning\n' +
          '!sequence — Job sequencing\n' +
          '!vsm — Value Stream Mapping\n' +
          '!toc — Theory of Constraints\n' +
          '!conwip — CONWIP / Heijunka\n' +
          '!doe — Design of Experiments\n' +
          '!fsm — State Machine simulator\n\n' +

          '🏭 Manufacturing — Chat Tools\n' +
          '!sigma <USL> <LSL> <project> — Six Sigma\n' +
          '!balance <takt_sec> <project> — Line balancing\n' +
          '!inventory <project> — Inventory planning\n' +
          '!spc — SPC / Control Plans\n' +
          '!fmea — FMEA analysis\n' +
          '!rca — Root Cause Analysis\n\n' +

          '📦 Domain Packs\n' +
          '!pack list — Installed packs\n' +
          '!pack info <name> — Pack details\n' +
          '!pack create <name> "desc" — Scaffold new pack\n\n' +

          (await renderMatrixFeatureBlocks()) +

          '🔧 System\n' +
          '!chatid — Show chat ID\n' +
          '!start — Welcome message',
      );
      return true;

    case '!newchat':
    case '!forget':
      await router.newChat(roomId);
      await sendNotice(client, roomId, 'Session cleared. Starting fresh.');
      return true;

    case '!memory': {
      const memories = await ctx.memory.getMemoriesByChatId(roomId);
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
        const caps = await ctx.voice.capabilities();
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
      const result = await router.switchProvider(roomId, 'claude');
      await sendNotice(client, roomId, `Switched to ${result} provider.`);
      return true;
    }

    case '!ollama': {
      const result = await router.switchProvider(roomId, 'ollama');
      await sendNotice(client, roomId, `Switched to ${result} provider.`);
      return true;
    }

    case '!auto': {
      const enabled = await router.toggleAutoRoute(roomId);
      await sendNotice(
        client,
        roomId,
        `Auto-routing ${enabled ? 'enabled' : 'disabled'}.` +
          (enabled
            ? ' Provider will be selected automatically per message. Use !claude or !ollama to switch back to manual.'
            : ' Use !claude or !ollama to set provider manually.'),
      );
      return true;
    }

    case '!provider': {
      const status = await router.getProviderStatus(roomId);
      const modeLabel = status.mode === 'auto' ? 'auto' : 'manual';
      let msg = `Provider: ${status.provider}\nRouting: ${modeLabel}`;
      if (status.model) {
        msg += `\nModel: ${status.model}`;
      }
      await sendNotice(client, roomId, msg);
      return true;
    }

    case '!careful':
    case '!safe': {
      const skill = await ctx.skills.getByName('careful');
      if (!skill) {
        await sendNotice(client, roomId, 'Safety skill not found.');
        return true;
      }
      const currentSkill = await ctx.skills.getActive(roomId);
      if (currentSkill?.name === 'careful') {
        await ctx.skills.clearActive(roomId);
        await sendNotice(client, roomId, 'Safety mode disabled.');
      } else {
        await ctx.skills.setActive(roomId, skill.id);
        await sendNotice(client, roomId, 'Safety mode enabled. I will warn before destructive actions and verify results.');
      }
      return true;
    }

    case '!board': {
      const boardArgs = command.replace(/^!board\s*/, '').trim();
      const boardParts = boardArgs.split(/\s+/);
      const boardSub = boardParts[0]?.toLowerCase() || 'list';

      if (boardSub === 'list' || boardSub === 'show') {
        await sendNotice(client, roomId, await ctx.kanban.formatBoard(roomId));
      } else if (boardSub === 'add') {
        const title = boardParts.slice(1).join(' ');
        if (!title) { await sendNotice(client, roomId, 'Usage: !board add <title>'); return true; }
        const card = await ctx.kanban.createCard(roomId, title, { source: 'user' });
        await sendNotice(client, roomId, `Card created: "${card.title}" — ID: ${card.id.slice(0, 8)}`);
      } else if (boardSub === 'move') {
        const card = await ctx.kanban.getCardByPrefix(roomId, boardParts[1] || '');
        if (!card) { await sendNotice(client, roomId, 'Card not found.'); return true; }
        const updated = await ctx.kanban.moveCard(card.id, (boardParts[2] || '') as CardStatus);
        if (!updated) { await sendNotice(client, roomId, 'Invalid status.'); return true; }
        await sendNotice(client, roomId, `Moved "${updated.title}" → ${updated.status}`);
      } else if (boardSub === 'assign') {
        const card = await ctx.kanban.getCardByPrefix(roomId, boardParts[1] || '');
        if (!card) { await sendNotice(client, roomId, 'Card not found.'); return true; }
        const updated = await ctx.kanban.assignCard(card.id, (boardParts[2] || '') as CardAssignee);
        if (!updated) { await sendNotice(client, roomId, 'Invalid assignee.'); return true; }
        await sendNotice(client, roomId, `Assigned "${updated.title}" → ${updated.assignee}`);
      } else if (boardSub === 'delete') {
        const card = await ctx.kanban.getCardByPrefix(roomId, boardParts[1] || '');
        if (!card) { await sendNotice(client, roomId, 'Card not found.'); return true; }
        await ctx.kanban.deleteCard(card.id);
        await sendNotice(client, roomId, `Deleted: "${card.title}"`);
      } else {
        await sendNotice(client, roomId, 'Usage: !board [list|add|move|assign|delete]');
      }
      return true;
    }

    case '!compress': {
      // Compress last response into 5 decision-relevant sentences
      return false; // Let handleMessage process it with the compress prompt
    }

    case '!digest': {
      const digestArgs = command.replace(/^!digest\s*/, '').trim().toLowerCase();
      if (digestArgs === 'daily' || digestArgs === 'weekly' || digestArgs === 'off') {
        ctx.proactive.setPreference(roomId, digestArgs as DigestFrequency);
        await sendNotice(client, roomId, digestArgs === 'off'
          ? 'Digest disabled.'
          : `Digest set to ${digestArgs}.`);
      } else if (digestArgs === 'now') {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const digest = await ctx.proactive.buildDigest(roomId, DAY_MS);
        await sendNotice(client, roomId, digest);
      } else {
        const current = ctx.proactive.getPreference(roomId);
        await sendNotice(client, roomId,
          `Digest: ${current}\n\nUsage: !digest daily|weekly|off|now`);
      }
      return true;
    }

    case '!schedule': {
      const schedArgs = command.replace(/^!schedule\s*/, '').trim();
      const schedParts = schedArgs.split(/\s+/);
      const subcommand = schedParts[0]?.toLowerCase() || 'help';

      switch (subcommand) {
        case 'list': {
          const tasks = await ctx.tasks.getByChat(roomId);
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
          const tasks = await ctx.tasks.getByChat(roomId);
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
          const error = ctx.tasks.validateCron(cron);
          if (error) {
            await sendNotice(client, roomId, `Invalid cron: ${error}`);
            return true;
          }
          const id = randomBytes(8).toString('hex');
          const nextRun = ctx.tasks.computeNextRun(cron);
          await ctx.tasks.create(id, roomId, prompt, cron, nextRun);
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
          const tasks = await ctx.tasks.getByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          await ctx.tasks.pause(task.id);
          await sendNotice(client, roomId, `Task ${task.id.slice(0, 8)} paused.`);
          return true;
        }

        case 'resume': {
          const taskId = schedParts[1];
          if (!taskId) {
            await sendNotice(client, roomId, 'Usage: !schedule resume <id>');
            return true;
          }
          const tasks = await ctx.tasks.getByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          const nextRun = ctx.tasks.computeNextRun(task.schedule);
          await ctx.tasks.resume(task.id);
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
          const tasks = await ctx.tasks.getByChat(roomId);
          const task = tasks.find((t) => t.id.startsWith(taskId));
          if (!task) {
            await sendNotice(client, roomId, 'Task not found.');
            return true;
          }
          await ctx.tasks.delete(task.id);
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
          const skills = await ctx.skills.list();
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
          const skill = await ctx.skills.getByName(name.toLowerCase());
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
          const skill = await ctx.skills.getByName(name.toLowerCase());
          if (!skill) {
            await sendNotice(client, roomId, 'Skill not found. Use !skill list to see available skills.');
            return true;
          }
          await ctx.skills.setActive(roomId, skill.id);
          await sendNotice(client, roomId, `Skill activated: ${skill.name}\n${skill.description}`);
          return true;
        }

        case 'off':
          await ctx.skills.clearActive(roomId);
          await sendNotice(client, roomId, 'Skill deactivated. Back to default behavior.');
          return true;

        case 'current': {
          const active = await ctx.skills.getActive(roomId);
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
          const existing = await ctx.skills.getByName(skillName.toLowerCase());
          if (existing) {
            await sendNotice(client, roomId, `Skill "${skillName}" already exists.`);
            return true;
          }
          const id = `custom-${skillName.toLowerCase()}`;
          await ctx.skills.create(id, skillName.toLowerCase(), desc, prompt, null, false);
          await sendNotice(client, roomId, `Custom skill created: ${skillName}\nActivate with: !skill use ${skillName}`);
          return true;
        }

        case 'delete': {
          const name = skillParts[1];
          if (!name) {
            await sendNotice(client, roomId, 'Usage: !skill delete <name>');
            return true;
          }
          const skill = await ctx.skills.getByName(name.toLowerCase());
          if (!skill) {
            await sendNotice(client, roomId, 'Skill not found.');
            return true;
          }
          try {
            await ctx.skills.delete(skill.id);
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
          const fixSkillObj = await ctx.skills.getByName(fixName.toLowerCase());
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
          const fixResult = await ctx.forge.fixSkill(fixSkillObj.id, feedback, roomId, router);
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
          const skill = await ctx.skills.getByName(name.toLowerCase());
          if (!skill) { await sendNotice(client, roomId, 'Skill not found.'); return true; }
          ctx.skills.lock(skill.id);
          await sendNotice(client, roomId, `Skill "${name}" locked.`);
          return true;
        }

        case 'unlock': {
          const name = skillParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !skill unlock <name>'); return true; }
          const skill = await ctx.skills.getByName(name.toLowerCase());
          if (!skill) { await sendNotice(client, roomId, 'Skill not found.'); return true; }
          ctx.skills.unlock(skill.id);
          await sendNotice(client, roomId, `Skill "${name}" unlocked.`);
          return true;
        }

        case 'export': {
          const name = skillParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !skill export <name>'); return true; }
          const skill = await ctx.skills.getByName(name.toLowerCase());
          if (!skill) { await sendNotice(client, roomId, 'Skill not found.'); return true; }
          const filepath = ctx.forge.exportSkillToMarkdown(skill);
          await sendNotice(client, roomId, `Skill "${name}" exported to: ${filepath}`);
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
              '!skill export <name> — Export skill to forge/skills/\n' +
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
          const allTools = ctx.tools.listRegistered();
          const userTools = await ctx.tools.listUserTools();
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
          const userTool = await ctx.tools.getByName(name.toLowerCase());
          if (userTool) {
            await sendNotice(client, roomId,
              `Tool: ${userTool.name}\nType: ${userTool.tool_type}\nDescription: ${userTool.description}\nEnabled: ${userTool.enabled ? 'Yes' : 'No'}\nLocked: ${userTool.locked ? 'Yes' : 'No'}`);
            return true;
          }
          const builtinMatch = ctx.tools.listRegistered().find((t) => t.name === name.toLowerCase());
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
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          await ctx.tools.enable(tool.id);
          ctx.tools.loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" enabled.`);
          return true;
        }

        case 'disable': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool disable <name>'); return true; }
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          await ctx.tools.disable(tool.id);
          ctx.tools.loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" disabled.`);
          return true;
        }

        case 'lock': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool lock <name>'); return true; }
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          await ctx.tools.lock(tool.id);
          await sendNotice(client, roomId, `Tool "${name}" locked.`);
          return true;
        }

        case 'unlock': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool unlock <name>'); return true; }
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          await ctx.tools.unlock(tool.id);
          await sendNotice(client, roomId, `Tool "${name}" unlocked.`);
          return true;
        }

        case 'fix': {
          const fixName = toolParts[1];
          if (!fixName) { await sendNotice(client, roomId, 'Usage: !tool fix <name> <feedback>'); return true; }
          const tool = await ctx.tools.getByName(fixName.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          const feedback = toolParts.slice(2).join(' ');
          if (!feedback) { await sendNotice(client, roomId, 'Please provide feedback.'); return true; }
          await sendNotice(client, roomId, `Fixing tool "${fixName}"...`);
          const result = await ctx.forge.fixTool(tool.id, feedback, roomId, router);
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
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found.'); return true; }
          if (tool.locked) { await sendNotice(client, roomId, 'Tool is locked. Unlock it first.'); return true; }
          await ctx.tools.delete(tool.id);
          ctx.tools.loadUserTools();
          await sendNotice(client, roomId, `Tool "${name}" deleted.`);
          return true;
        }

        case 'export': {
          const name = toolParts[1];
          if (!name) { await sendNotice(client, roomId, 'Usage: !tool export <name>'); return true; }
          const tool = await ctx.tools.getByName(name.toLowerCase());
          if (!tool) { await sendNotice(client, roomId, 'User tool not found. Only user-created tools can be exported.'); return true; }
          const filepath = ctx.forge.exportToolToMarkdown(tool);
          await sendNotice(client, roomId, `Tool "${name}" exported to: ${filepath}`);
          return true;
        }

        default:
          await sendNotice(client, roomId,
            'Tool commands:\n\n' +
            '!tool list — Show all tools\n' +
            '!tool show <name> — Tool details\n' +
            '!tool export <name> — Export tool to forge/tools/\n' +
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
      const count = ctx.tools.loadUserTools();
      await sendNotice(client, roomId, `Reloaded. ${count} user tools active.`);
      return true;
    }

    case '!pack': {
      const packParts = parts.slice(1);
      const packSub = packParts[0]?.toLowerCase() || 'help';
      const { getLoadedPacks, getPackByName, scaffoldPack } = await import('../packs.js');

      if (packSub === 'list') {
        const packs = getLoadedPacks();
        if (packs.length === 0) {
          await sendNotice(client, roomId, 'No domain packs installed.\n\nCreate one with: !pack create name "description"\nSee docs/customization-guide.md for the full guide.');
          return true;
        }
        const lines = packs.map(
          (p) => `${p.displayName} (${p.name} v${p.version})\n  ${p.description}\n  Tools: ${p.toolCount} | Skills: ${p.skillCount} | Templates: ${p.templateFiles.length}`,
        );
        await sendNotice(client, roomId, `Domain Packs (${packs.length})\n\n${lines.join('\n\n')}`);
      } else if (packSub === 'info') {
        const name = packParts[1];
        if (!name) { await sendNotice(client, roomId, 'Usage: !pack info <name>'); return true; }
        const pack = getPackByName(name);
        if (!pack) { await sendNotice(client, roomId, `Pack not found: ${name}`); return true; }
        await sendNotice(client, roomId,
          `${pack.displayName} (v${pack.version})\n${pack.description}\n\nTools: ${pack.toolCount} | Skills: ${pack.skillCount} | Templates: ${pack.templateFiles.length}\nIntent patterns: ${pack.intentPatterns.length}\nCommands: ${pack.commands.map((c) => `!${c.name}`).join(', ') || '(none)'}`,
        );
      } else if (packSub === 'create') {
        const name = packParts[1];
        if (!name) { await sendNotice(client, roomId, 'Usage: !pack create <name> "description"'); return true; }
        const descMatch = command.match(/"([^"]+)"|'([^']+)'/);
        const description = descMatch ? (descMatch[1] || descMatch[2]) : `${name} domain tools`;
        try {
          scaffoldPack(name, description);
          await sendNotice(client, roomId,
            `Pack scaffolded: packs/${name}/\n\nNext: edit pack.yaml, add tools, restart Luna, verify with !pack info ${name}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendNotice(client, roomId, `Failed: ${msg}`);
        }
      } else {
        await sendNotice(client, roomId,
          '!pack — Domain Pack Management\n\n!pack list — Show installed packs\n!pack info <name> — Pack details\n!pack create <name> "description" — Scaffold new pack\n!pack templates <name> — List templates\n\nSee docs/customization-guide.md for the full guide.',
        );
      }
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
  ctx: PlatformContext,
): Promise<void> {
  const caps = await ctx.voice.capabilities();
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

    // Transcribe (returns text + detected language)
    const { text: transcript } = await ctx.voice.transcribe(localPath);
    logger.info({ roomId, transcript }, 'Matrix voice transcribed');

    // Process as text with voice prompt tuning
    await handleMessage(
      client,
      roomId,
      transcript,
      ctx,
      true,
    );
  } catch (err) {
    logger.error({ err }, 'Matrix voice handler failed');
    await sendNotice(client, roomId, 'Failed to process voice message.').catch(() => {});
  }
}

// ── Bot Factory ─────────────────────────────────────────────

export async function createMatrixBot(
  ctx: PlatformContext,
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
      await handleVoiceMessage(client, roomId, event, ctx);
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
            ctx,
          );
          return;
        } catch (err) {
          logger.error({ err }, 'Matrix photo handler failed');
        }
      }

      await handleMessage(client, roomId, `[Image received] ${caption}`, ctx);
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

          const parsed = await ctx.files.parse(localPath, fileMime);

          if (parsed.error) {
            await handleMessage(client, roomId, `[File received: ${fileName}] (Could not parse: ${parsed.error})`, ctx);
            return;
          }

          const meta: string[] = [`[Document: ${fileName}]`];
          if (parsed.pageCount) meta.push(`Pages: ${parsed.pageCount}`);
          if (parsed.sheetCount) meta.push(`Sheets: ${parsed.sheetCount}`);
          if (parsed.truncated) meta.push('(Content was truncated)');

          await handleMessage(client, roomId, `${meta.join(' | ')}\n\n${parsed.text}`, ctx);
          return;
        } catch (err) {
          logger.error({ err }, 'Matrix file handler failed');
        }
      }

      await handleMessage(client, roomId, `[File received: ${fileName}]`, ctx);
      return;
    }

    // Only process m.text (ignore m.notice to prevent bot loops)
    if (msgtype !== 'm.text') return;

    const body = (content.body as string) || '';
    if (!body) return;

    // Check for commands (! prefix)
    if (body.startsWith('!')) {
      const handled = await handleCommand(client, roomId, body, ctx);
      if (handled) return;
    }

    // Regular message
    await handleMessage(client, roomId, body, ctx);
  });

  return client;
}
