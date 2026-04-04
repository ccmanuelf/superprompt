import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bot, Context, InputFile } from 'grammy';
import { config, UPLOADS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { PlatformContext } from '../core/context.js';
import type { CardStatus, CardAssignee } from '../kanban.js';
import type { DigestFrequency } from '../proactive.js';
import type { CitationFormat } from '../citations.js';

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
  pc: PlatformContext,
  forceVoiceReply: boolean = false,
  skipTools: boolean = false,
  isVoice: boolean = false,
): Promise<void> {
  const chatId = String(ctx.chat!.id);

  // 1. Build memory context (hybrid: FTS5 + vector)
  const memoryContext = await pc.memory.buildContext(chatId, rawText);
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
    // 2a. Learning session gate — route through session handler if active
    // Allow non-learning slash commands to pass through (user can /memory, /board, etc.)
    const isNonLearnCommand = rawText.startsWith('/') && !rawText.startsWith('/learn');
    if (pc.learning.isSessionActive(chatId) && !isNonLearnCommand) {
      // Check for session-ending keywords
      const lowerText = rawText.toLowerCase().trim();
      if (['done', 'stop', 'enough', '/learn done', '/learn stop'].includes(lowerText)) {
        clearInterval(typingInterval);
        typingInterval = undefined;
        const activeSession = pc.learning.getActiveSession(chatId)!;
        const { durationSeconds, needsExpand } = pc.learning.endSession(chatId, 'user_ended');
        const summary = pc.learning.formatSessionSummary(durationSeconds, activeSession.questionsAsked, activeSession.correctAnswers);
        await ctx.reply(formatForTelegram(summary), { parse_mode: 'HTML' });

        // Rolling horizon: expand curriculum if needed
        if (needsExpand) {
          const plan = pc.learning.getPlan(activeSession.planId);
          if (plan) {
            const expandPrompt = pc.learning.buildExpandPrompt(plan);
            const expandResponse = await pc.router.sendMessage({ chatId, message: expandPrompt, skipAutoTrigger: true });
            const newTopics = pc.learning.parsePlanResponse(expandResponse.text || '');
            if (newTopics.length > 0) {
              pc.learning.addExpansionTopics(plan.id, newTopics);
              await ctx.reply(formatForTelegram(`Added ${newTopics.length} new topics to your **${plan.subject}** plan.`), { parse_mode: 'HTML' });
            }
          }
        }
        return;
      }

      if (lowerText === 'snooze' || lowerText === 'later' || lowerText === 'dismiss') {
        clearInterval(typingInterval);
        typingInterval = undefined;
        pc.learning.dismissSession(chatId);
        await ctx.reply('Session dismissed. We\'ll continue later.');
        return;
      }

      // Active session: send message through AI with session system prompt
      pc.learning.touchSession(chatId);
      const sessionPrompt = pc.learning.getSessionSystemPrompt(chatId);
      const response = await pc.router.sendMessage({
        chatId,
        message: fullMessage,
        skipAutoTrigger: true,
        systemPrompt: sessionPrompt ?? undefined,
      });

      if (response.text) {
        // Process assessment markers
        const result = pc.learning.processSessionResponse(chatId, response.text);
        const cleanText = pc.learning.stripMarkers(response.text);

        // Handle assessment results
        const activeSession = pc.learning.getActiveSession(chatId);
        if (result.assessmentPassed && activeSession?.assessmentTarget) {
          const plan = pc.learning.getPlan(activeSession.planId);
          if (plan) {
            pc.learning.completeTopicRemoval(plan.id, activeSession.assessmentTarget);
          }
          pc.learning.endSession(chatId, 'assessment_passed');
          clearInterval(typingInterval);
          typingInterval = undefined;
          await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
          await ctx.reply(formatForTelegram(`**${activeSession.assessmentTarget}** has been deferred from your plan.`), { parse_mode: 'HTML' });
          return;
        }

        if (result.assessmentFailed && activeSession?.assessmentTarget) {
          const rejectMsg = pc.learning.rejectTopicRemoval(activeSession.assessmentTarget);
          pc.learning.endSession(chatId, 'assessment_failed');
          clearInterval(typingInterval);
          typingInterval = undefined;
          await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
          await ctx.reply(formatForTelegram(rejectMsg), { parse_mode: 'HTML' });
          return;
        }

        // Handle topic completion
        if (result.topicComplete) {
          const session = pc.learning.getActiveSession(chatId);
          if (session) {
            const { durationSeconds, needsExpand } = pc.learning.endSession(chatId, 'topic_complete');
            const summary = pc.learning.formatSessionSummary(durationSeconds, session.questionsAsked, session.correctAnswers);
            clearInterval(typingInterval);
            typingInterval = undefined;
            await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
            await ctx.reply(formatForTelegram(summary), { parse_mode: 'HTML' });

            if (needsExpand) {
              const plan = pc.learning.getPlan(session.planId);
              if (plan) {
                const expandPrompt = pc.learning.buildExpandPrompt(plan);
                const expandResponse = await pc.router.sendMessage({ chatId, message: expandPrompt, skipAutoTrigger: true });
                const newTopics = pc.learning.parsePlanResponse(expandResponse.text || '');
                if (newTopics.length > 0) {
                  pc.learning.addExpansionTopics(plan.id, newTopics);
                  await ctx.reply(formatForTelegram(`Added ${newTopics.length} new topics to your plan.`), { parse_mode: 'HTML' });
                }
              }
            }
            return;
          }
        }

        // Normal session response
        pc.memory.saveConversationTurn(chatId, rawText, cleanText).catch((err) => {
          logger.warn({ err }, 'Failed to save learning session memory');
        });

        const formatted = formatForTelegram(cleanText);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch {
            await ctx.reply(chunk);
          }
        }
      }

      clearInterval(typingInterval);
      typingInterval = undefined;
      return;
    }

    // 2b. Check for multi-step orchestration (on raw message, not memory-augmented)
    if (!skipTools && !isVoice && pc.orchestrator.shouldOrchestrate(rawText)) {
      clearInterval(typingInterval);
      typingInterval = undefined;

      const progressFn = async (_chatId: string, text: string) => {
        await ctx.reply(formatForTelegram(text), { parse_mode: 'HTML' });
      };

      const response = await pc.orchestrator.orchestrateTask(pc.router, chatId, fullMessage, progressFn);

      // Save orchestration as conversation memory
      if (response.text) {
        pc.memory.saveConversationTurn(chatId, rawText, response.text).catch((err) => {
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
    const response = await pc.router.sendMessage({
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
    const quality = pc.selfMonitor.checkQuality(response, rawText);
    if (!quality.passed) {
      pc.selfMonitor.logCheck(chatId, response.provider, quality.score, quality.issues);
    }

    // 5. Save conversation memory (with embedding, fire-and-forget)
    pc.memory.saveConversationTurn(chatId, rawText, response.text).catch((err) => {
      logger.warn({ err }, 'Failed to save conversation memory');
    });

    // 5b. Process structured actions in response (docgen, kanban)
    // Both can appear in the same response — process all, don't return early
    let responseText = response.text;

    // 5b1. Document generation
    if (pc.docgen.isResponse(responseText)) {
      const docReq = pc.docgen.parseResponse(responseText);
      if (docReq) {
        try {
          const result = await pc.docgen.generate(docReq);
          await ctx.replyWithDocument(new InputFile(result.buffer, result.filename));
          responseText = pc.docgen.stripBlock(responseText);
        } catch (err) {
          logger.warn({ err }, 'Document generation failed, sending raw response');
        }
      }
    }

    // 5b2. Kanban action (works for BOTH Claude and Ollama)
    // Skip if Ollama already created the card via kanban_manage tool call
    // (the tool sets response.generatedFiles or tool result contains kanban_manage)
    if (responseText && pc.kanban.isKanbanAction(responseText)) {
      const kanbanReq = pc.kanban.parseKanbanAction(responseText);
      if (kanbanReq) {
        const kanbanResult = pc.kanban.executeKanbanAction(chatId, kanbanReq);
        await ctx.reply(formatForTelegram(kanbanResult), { parse_mode: 'HTML' });
        responseText = pc.kanban.stripKanbanBlock(responseText);
      }
    }

    // Update response text after stripping action blocks
    response.text = responseText;
    if (!response.text) return;

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
      const caps = await pc.voice.capabilities();
      if (caps.tts) {
        try {
          const audio = await pc.voice.synthesize(response.text);
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

// ── FMEA CSV Upload Helper ───────────────────────────────

async function handleFmeaCsv(ctx: Context, caption: string): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) { await ctx.reply('Please attach a CSV file.'); return; }

  const docName = caption.replace(/^\/fmea(@\w+)?/, '').trim();
  if (!docName) {
    await ctx.reply('Usage: attach CSV with caption:\n<code>/fmea &lt;document_name&gt;</code>', { parse_mode: 'HTML' });
    return;
  }

  try {
    const file = await ctx.getFile();
    if (!file.file_path) { await ctx.reply('Could not download file.'); return; }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) { await ctx.reply('Failed to download file.'); return; }

    const csvContent = await res.text();
    await ctx.reply(`Running FMEA analysis for "${docName}"...`);

    const { executeFmeaFromCsv, formatFmeaWorksheet, generateRiskHeatmap, generateRpnPareto } = await import('../fmea.js');
    const { doc: fmeaDoc, failureModes, actions } = executeFmeaFromCsv(csvContent, docName);

    // Send formatted worksheet
    const formatted = formatFmeaWorksheet(fmeaDoc, failureModes, actions, true);
    await ctx.reply(formatted, { parse_mode: 'HTML' });

    // Send risk heatmap
    try {
      const heatmapPath = await generateRiskHeatmap(failureModes, docName);
      await ctx.replyWithPhoto(new InputFile(heatmapPath), { caption: `Risk Matrix — ${docName}` });
    } catch (err) { logger.warn({ err }, 'Failed to generate risk heatmap'); }

    // Send RPN Pareto
    try {
      const paretoPath = await generateRpnPareto(failureModes, docName);
      await ctx.replyWithPhoto(new InputFile(paretoPath), { caption: `RPN Pareto — ${docName}` });
    } catch (err) { logger.warn({ err }, 'Failed to generate RPN Pareto'); }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`FMEA error: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  }
}

// ── Inventory CSV Upload Helper ──────────────────────────

async function handleInventoryCsv(ctx: Context, caption: string): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) {
    await ctx.reply('Please attach a CSV file with the /inventory command.');
    return;
  }

  const projectName = caption.replace(/^\/inventory(@\w+)?/, '').trim();
  if (!projectName) {
    await ctx.reply(
      'Usage: attach CSV with caption:\n<code>/inventory &lt;project_name&gt;</code>\n\nExample: <code>/inventory Warehouse Q3</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    if (!file.file_path) { await ctx.reply('Could not download file.'); return; }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) { await ctx.reply('Failed to download file.'); return; }

    const csvContent = await res.text();
    await ctx.reply(`Running inventory analysis for "${projectName}"...`);

    const { executeInventoryAnalysis, formatReplenishmentPlan, generateAbcChart } = await import('../inventory.js');
    const { plans, abc, stockoutRisks } = executeInventoryAnalysis(csvContent, projectName);

    // Send text result
    const formatted = formatReplenishmentPlan(plans, abc, true);
    await ctx.reply(formatted, { parse_mode: 'HTML' });

    // Send ABC chart
    try {
      const abcPath = await generateAbcChart(abc, projectName);
      await ctx.replyWithPhoto(new InputFile(abcPath), { caption: `ABC Classification — ${projectName}` });
    } catch (err) { logger.warn({ err }, 'Failed to generate ABC chart'); }

    // Send stockout warnings
    if (stockoutRisks.length > 0) {
      await ctx.reply(
        `<b>Stockout Risks:</b>\n${stockoutRisks.map((r) => `• ${escapeHtml(r)}`).join('\n')}`,
        { parse_mode: 'HTML' },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Inventory error: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  }
}

// ── Sigma CSV Upload Helper ─────────────────────────────

async function handleSigmaCsv(ctx: Context, caption: string): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) {
    await ctx.reply('Please attach a CSV file with the /sigma command.');
    return;
  }

  // Parse caption: /sigma <usl> <lsl> <project_name> [target=<value>]
  const sigmaArgs = caption.replace(/^\/sigma(@\w+)?/, '').trim();
  const targetMatch = sigmaArgs.match(/\btarget=(\d+(?:\.\d+)?)\b/i);
  const target = targetMatch ? parseFloat(targetMatch[1]) : undefined;
  const cleanArgs = sigmaArgs.replace(/\btarget=\d+(?:\.\d+)?\b/i, '').trim();

  const match = cleanArgs.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) {
    await ctx.reply(
      'Usage: attach CSV with caption:\n<code>/sigma &lt;USL&gt; &lt;LSL&gt; &lt;project_name&gt; [target=value]</code>\n\n' +
        'Example: <code>/sigma 10.5 9.5 Widget Diameter target=10.0</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const usl = parseFloat(match[1]);
  const lsl = parseFloat(match[2]);
  const projectName = match[3].trim();

  if (usl <= lsl) {
    await ctx.reply('USL must be greater than LSL.');
    return;
  }

  try {
    const file = await ctx.getFile();
    if (!file.file_path) { await ctx.reply('Could not download file.'); return; }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) { await ctx.reply('Failed to download file.'); return; }

    const csvContent = await res.text();
    await ctx.reply(`Running Six Sigma analysis for "${projectName}" (USL=${usl}, LSL=${lsl})...`);

    const {
      executeCapabilityAnalysis, formatCapabilityResult,
      generateControlChart, generateCapabilityChart, generateParetoChart,
      paretoAnalysis, getMeasurements,
    } = await import('../sigma.js');

    const { project, capability, controlChart } = executeCapabilityAnalysis(csvContent, usl, lsl, projectName, target);

    // Send text result
    const formatted = formatCapabilityResult(capability, controlChart, projectName, true);
    await ctx.reply(formatted, { parse_mode: 'HTML' });

    // Send capability histogram
    try {
      const measurements = getMeasurements(project.id);
      const values = measurements.map((m) => m.value);
      const capChartPath = await generateCapabilityChart(values, { usl, lsl, target }, capability, projectName);
      await ctx.replyWithPhoto(new InputFile(capChartPath), { caption: `Capability Histogram — ${projectName}` });
    } catch (err) { logger.warn({ err }, 'Failed to generate capability chart'); }

    // Send control chart
    try {
      const chartPath = await generateControlChart(controlChart, projectName);
      await ctx.replyWithPhoto(new InputFile(chartPath), {
        caption: `${controlChart.chart_type === 'i_mr' ? 'I-MR' : 'X-bar/R'} Control Chart — ${projectName}`,
      });
    } catch (err) { logger.warn({ err }, 'Failed to generate control chart'); }

    // Send Pareto if defect types exist
    try {
      const measurements = getMeasurements(project.id);
      if (measurements.some((m) => m.defect_type)) {
        const pareto = paretoAnalysis(measurements);
        const paretoPath = await generateParetoChart(pareto, projectName);
        await ctx.replyWithPhoto(new InputFile(paretoPath), { caption: `Pareto Analysis — ${projectName}` });
      }
    } catch (err) { logger.warn({ err }, 'Failed to generate Pareto chart'); }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Sigma analysis error: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  }
}

// ── Balance CSV Upload Helper ────────────────────────────

async function handleBalanceCsv(ctx: Context, caption: string): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) {
    await ctx.reply('Please attach a CSV file with the /balance command.');
    return;
  }

  // Parse caption: /balance <takt_time> <project_name>
  const balanceArgs = caption.replace(/^\/balance(@\w+)?/, '').trim();
  const match = balanceArgs.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) {
    await ctx.reply(
      'Usage: attach a CSV with caption:\n<code>/balance &lt;takt_time_seconds&gt; &lt;project_name&gt;</code>\n\n' +
        'Example: <code>/balance 120 Engine Assembly</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const taktTime = parseFloat(match[1]);
  const projectName = match[2].trim();

  try {
    const file = await ctx.getFile();
    if (!file.file_path) {
      await ctx.reply('Could not download file.');
      return;
    }

    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply('Failed to download file from Telegram.');
      return;
    }

    const csvContent = await res.text();
    await ctx.reply(`Running balance for "${projectName}" with takt time ${taktTime}s...`);

    const { executeBalance, formatBalanceResult, generateYamazumiChart, generateGanttChart, exportAssignmentsCsv } = await import('../balance.js');
    const result = executeBalance(csvContent, taktTime, projectName);

    // Send text result
    const formatted = formatBalanceResult(result, true);
    await ctx.reply(formatted, { parse_mode: 'HTML' });

    // Send yamazumi chart (primary visualization)
    try {
      const yamazumiPath = await generateYamazumiChart(result);
      await ctx.replyWithPhoto(new InputFile(yamazumiPath), {
        caption: `Yamazumi Chart — ${projectName} (Takt: ${taktTime}s)`,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to generate yamazumi chart');
    }

    // Send Gantt chart (supplementary)
    try {
      const ganttPath = await generateGanttChart(result);
      await ctx.replyWithPhoto(new InputFile(ganttPath), {
        caption: `Gantt Chart — ${projectName}`,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to generate Gantt chart');
    }

    // Send CSV export
    try {
      const csv = exportAssignmentsCsv(result);
      const csvBuffer = Buffer.from(csv, 'utf-8');
      await ctx.replyWithDocument(new InputFile(csvBuffer, `balance-${projectName.replace(/\s+/g, '-')}.csv`), {
        caption: 'Assignment export',
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to export CSV');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Balance error: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
  }
}

// ── Skill Upload Helper ─────────────────────────────────

async function handleSkillUpload(ctx: Context, pc: PlatformContext): Promise<void> {
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
    const parsed = pc.forge.parseSkillMarkdown(content);

    if ('error' in parsed) {
      await ctx.reply(`Parse error: ${parsed.error}`);
      return;
    }

    // Check if skill already exists
    const existing = pc.skills.getByName(parsed.name);
    if (existing) {
      if (existing.locked) {
        await ctx.reply(`Skill "${parsed.name}" is locked. Unlock it first.`);
        return;
      }
      // Update existing skill
      pc.skills.update(existing.id, {
        description: parsed.description,
        systemPrompt: parsed.systemPrompt,
        allowedTools: parsed.tools,
      });
      pc.skills.insertRevision(existing.id, parsed.systemPrompt, `Updated from file: ${fileName}`);
      await ctx.reply(
        `Skill <b>${escapeHtml(parsed.name)}</b> updated from ${escapeHtml(fileName)}.`,
        { parse_mode: 'HTML' },
      );
    } else {
      // Create new skill
      const id = `custom-${parsed.name}`;
      pc.skills.create(id, parsed.name, parsed.description, parsed.systemPrompt, parsed.tools, false, fileName);
      pc.skills.insertRevision(id, parsed.systemPrompt, `Created from file: ${fileName}`);
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

async function handleToolUpload(ctx: Context, pc: PlatformContext): Promise<void> {
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
    const parsed = pc.forge.parseToolMarkdown(content);

    if ('error' in parsed) {
      await ctx.reply(`Parse error: ${parsed.error}`);
      return;
    }

    // For generated_code: check safety or generate code
    if (parsed.type === 'generated_code') {
      if (parsed.code) {
        const scan = pc.forge.scanToolCode(parsed.code);
        if (!scan.safe) {
          await ctx.reply(`Safety check failed:\n${scan.issues.join('\n')}`);
          return;
        }
      } else {
        // Generate code via AI
        await ctx.reply('Generating tool code via AI...');
        const chatId = String(ctx.chat!.id);
        const genResult = await pc.forge.generateToolCode(
          parsed.name,
          parsed.description,
          parsed.parameters,
          chatId,
          pc.router,
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
    const existing = pc.tools.getByName(parsed.name);
    if (existing) {
      if (existing.locked) {
        await ctx.reply(`Tool "${parsed.name}" is locked. Unlock it first.`);
        return;
      }
      // Update
      pc.tools.update(existing.id, { description: parsed.description, config: toolConfig });
      pc.tools.insertRevision(existing.id, toolConfig, `Updated from file: ${fileName}`);
      pc.tools.loadUserTools();
      await ctx.reply(
        `Tool <b>${escapeHtml(parsed.name)}</b> updated from ${escapeHtml(fileName)}.`,
        { parse_mode: 'HTML' },
      );
    } else {
      const id = `user-tool-${parsed.name}`;
      pc.tools.create(id, parsed.name, parsed.description, parsed.type, toolConfig, fileName);
      pc.tools.insertRevision(id, toolConfig, `Created from file: ${fileName}`);
      pc.tools.loadUserTools();
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

export function createTelegramBot(pc: PlatformContext): Bot {
  const router = pc.router;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ── Commands ──────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await ctx.reply(
      'Hello! I\'m <b>clauded</b>, your AI engineering partner.\n\n' +

        '<b>💬 Chat &amp; AI</b>\n' +
        '/newchat — Fresh session  •  /memory — Stored memories\n' +
        '/claude /ollama /auto — Switch AI provider\n' +
        '/skill — AI personas  •  /careful — Safety mode\n\n' +

        '<b>🏭 Manufacturing Tools</b>\n' +
        '/capacity — Capacity planning  •  /sim — Production simulation\n' +
        '/sequence — Job sequencing  •  /vsm — Value Stream Mapping\n' +
        '/toc — Theory of Constraints  •  /conwip — CONWIP/Heijunka\n' +
        '/doe — Design of Experiments  •  /fsm — State machines\n' +
        '/balance — Line balance  •  /sigma — Six Sigma SPC\n' +
        '/fmea — Failure Mode Analysis  •  /rca — Root Cause Analysis\n' +
        '/spc — Control Plans  •  /inventory — Inventory planning\n\n' +

        '<b>📋 Productivity</b>\n' +
        '/board — Kanban board  •  /learn — Learning coach\n' +
        '/schedule — Scheduled tasks  •  /digest — Activity digests\n' +
        '/research — Academic papers  •  /cite — Citations\n\n' +

        '<b>🔧 System</b>\n' +
        '/tool — Manage tools  •  /voice — Toggle voice replies\n' +
        '/provider — Current AI info  •  /reload — Reload tools\n\n' +

        '<b>🌐 Web Dashboards</b> (open in browser):\n' +
        '/ (voice chat) • /sim • /capacity • /sequence • /vsm\n' +
        '/toc • /conwip • /doe • /fsm • /board • /learn\n\n' +

        '<i>Ask me anything — or say "what can you do?" for the full guide.</i>',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await ctx.reply(
      '<b>clauded — Command Reference</b>\n\n' +

        '<b>💬 Chat &amp; AI</b>\n' +
        '/newchat — Clear conversation history\n' +
        '/memory — Show stored memories\n' +
        '/claude — Switch to Claude provider\n' +
        '/ollama — Switch to Ollama provider\n' +
        '/auto — Toggle auto-routing\n' +
        '/provider — Show current provider\n' +
        '/models — List Ollama models\n' +
        '/model &lt;name&gt; — Switch Ollama model\n\n' +

        '<b>🎤 Voice</b>\n' +
        '/voice — Toggle always-voice replies\n' +
        'Send a voice message for auto-transcription + voice reply\n\n' +

        '<b>🧠 Skills &amp; Tools</b>\n' +
        '/skill list|use|create|fix|off — Manage AI skills\n' +
        '/tool list|show|upload|generate|fix — Manage tools\n' +
        '/careful — Safety guardrails mode\n' +
        '/compress — Compress last response to 5 key sentences\n' +
        '/reload — Reload user tools\n\n' +

        '<b>📋 Productivity</b>\n' +
        '/board — Kanban board (view|move|assign|priority|due)\n' +
        '/schedule — Tasks (create|list|pause|resume|delete)\n' +
        '/digest — Digests (daily|weekly|now|off)\n' +
        '/learn — Learning coach (plan|session|status)\n' +
        '/research — Search academic papers\n' +
        '/cite — Manage citations (export bibtex|apa|chicago)\n\n' +

        '<b>🏭 Manufacturing — Web Dashboards</b>\n' +
        '/sim — Production simulation (DES + Monte Carlo)\n' +
        '/capacity — Capacity planning (12-step + ROI)\n' +
        '/sequence — Job sequencing (6 rules + GA)\n' +
        '/vsm — Value Stream Mapping\n' +
        '/toc — Theory of Constraints (DBR)\n' +
        '/conwip — CONWIP / Heijunka leveling\n' +
        '/doe — Design of Experiments\n' +
        '/fsm — State Machine simulator\n\n' +

        '<b>🏭 Manufacturing — Chat Tools</b>\n' +
        '/sigma &lt;USL&gt; &lt;LSL&gt; &lt;project&gt; — Six Sigma analysis\n' +
        '/balance &lt;takt_sec&gt; &lt;project&gt; — Line balancing\n' +
        '/inventory &lt;project&gt; — Inventory planning\n' +
        '/spc — SPC / Control Plans\n' +
        '/fmea — FMEA analysis\n' +
        '/rca — Root Cause Analysis\n\n' +

        '<b>🌐 Web Interfaces</b> (port 3030)\n' +
        '/ — Voice chat  •  /board — Kanban  •  /learn — Coach\n' +
        '/sim • /capacity • /sequence • /vsm • /toc\n' +
        '/conwip • /doe • /fsm\n\n' +

        '<b>📦 Domain Packs</b>\n' +
        '/pack list — Installed packs\n' +
        '/pack info &lt;name&gt; — Pack details\n' +
        '/pack create &lt;name&gt; "desc" — Scaffold new pack\n' +
        '/pack templates &lt;name&gt; — Get template files\n\n' +

        '<b>🔧 System</b>\n' +
        '/chatid — Show your chat ID\n' +
        '/start — Welcome message',
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
    const memories = pc.memory.getMemoriesByChatId(String(ctx.chat.id));
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
      const caps = await pc.voice.capabilities();
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
    const skill = pc.skills.getByName('careful');
    if (!skill) {
      await ctx.reply('Safety skill not found. Run /reload to refresh skills.');
      return;
    }
    const currentSkill = pc.skills.getActive(chatId);
    if (currentSkill?.name === 'careful') {
      pc.skills.clearActive(chatId);
      await ctx.reply('Safety mode <b>disabled</b>.', { parse_mode: 'HTML' });
    } else {
      pc.skills.setActive(chatId, skill.id);
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
        const tasks = pc.tasks.getByChat(chatId);
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
        const tasks = pc.tasks.getByChat(chatId);
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
        const error = pc.tasks.validateCron(cron);
        if (error) {
          await ctx.reply(`Invalid cron: ${escapeHtml(error)}`, { parse_mode: 'HTML' });
          return;
        }
        const id = randomBytes(8).toString('hex');
        const nextRun = pc.tasks.computeNextRun(cron);
        pc.tasks.create(id, chatId, prompt, cron, nextRun);
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
        const tasks = pc.tasks.getByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        pc.tasks.pause(task.id);
        await ctx.reply(`Task <code>${task.id.slice(0, 8)}</code> paused.`, { parse_mode: 'HTML' });
        return;
      }

      case 'resume': {
        const taskId = parts[1];
        if (!taskId) {
          await ctx.reply('Usage: /schedule resume &lt;id&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tasks = pc.tasks.getByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        const nextRun = pc.tasks.computeNextRun(task.schedule);
        pc.tasks.resume(task.id);
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
        const tasks = pc.tasks.getByChat(chatId);
        const task = tasks.find((t) => t.id.startsWith(taskId));
        if (!task) {
          await ctx.reply('Task not found.');
          return;
        }
        pc.tasks.delete(task.id);
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
        const skills = pc.skills.list();
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
        const skill = pc.skills.getByName(name.toLowerCase());
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
        const skill = pc.skills.getByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found. Use /skill list to see available skills.');
          return;
        }
        pc.skills.setActive(chatId, skill.id);
        await ctx.reply(
          `Skill activated: <b>${escapeHtml(skill.name)}</b>\n${escapeHtml(skill.description)}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'off': {
        pc.skills.clearActive(chatId);
        await ctx.reply('Skill deactivated. Back to default behavior.');
        return;
      }

      case 'current': {
        const active = pc.skills.getActive(chatId);
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
        const existing = pc.skills.getByName(skillName.toLowerCase());
        if (existing) {
          await ctx.reply(`Skill "${skillName}" already exists.`);
          return;
        }
        const id = `custom-${skillName.toLowerCase()}`;
        pc.skills.create(id, skillName.toLowerCase(), desc, prompt, null, false);
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
        const skill = pc.skills.getByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        try {
          pc.skills.delete(skill.id);
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
        const fixSkillObj = pc.skills.getByName(fixName.toLowerCase());
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
        const fixResult = await pc.forge.fixSkill(fixSkillObj.id, feedback, chatId, router);
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
        await handleSkillUpload(ctx, pc);
        return;
      }

      case 'lock': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill lock &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = pc.skills.getByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        pc.skills.lock(skill.id);
        await ctx.reply(`Skill "${name}" locked. It cannot be edited, fixed, or deleted until unlocked.`);
        return;
      }

      case 'unlock': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill unlock &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = pc.skills.getByName(name.toLowerCase());
        if (!skill) {
          await ctx.reply('Skill not found.');
          return;
        }
        pc.skills.unlock(skill.id);
        await ctx.reply(`Skill "${name}" unlocked.`);
        return;
      }

      case 'export': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /skill export &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const skill = pc.skills.getByName(name);
        if (!skill) {
          await ctx.reply(`Skill "${name}" not found.`);
          return;
        }
        const filepath = pc.forge.exportSkillToMarkdown(skill);
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
    const count = pc.tools.loadUserTools();
    await ctx.reply(`Reloaded. ${count} user tools active.`);
  });

  // ── Citation Command ──────────────────────────────────

  bot.command('cite', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/cite(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'list';

    switch (subcommand) {
      case 'list': {
        const citations = pc.citations.get(chatId);
        await ctx.reply(formatForTelegram(pc.citations.formatList(citations)), { parse_mode: 'HTML' });
        return;
      }
      case 'export': {
        const format = (parts[1]?.toLowerCase() || 'apa') as CitationFormat;
        if (!['bibtex', 'apa', 'chicago'].includes(format)) {
          await ctx.reply('Usage: /cite export <bibtex|apa|chicago>');
          return;
        }
        const exported = pc.citations.export(chatId, format);
        if (exported === 'No citations to export.') {
          await ctx.reply(exported);
          return;
        }
        const ext = format === 'bibtex' ? 'bib' : 'txt';
        const buf = Buffer.from(exported, 'utf-8');
        await ctx.replyWithDocument(new InputFile(buf, `citations.${ext}`));
        return;
      }
      case 'clear': {
        const count = pc.citations.clear(chatId);
        await ctx.reply(`Cleared ${count} citation(s).`);
        return;
      }
      default: {
        await ctx.reply(formatForTelegram(
          '**Citation Commands:**\n' +
          '`/cite list` — Show saved citations\n' +
          '`/cite export <bibtex|apa|chicago>` — Export citations as file\n' +
          '`/cite clear` — Clear all citations',
        ), { parse_mode: 'HTML' });
        return;
      }
    }
  });

  // ── Research Command ──────────────────────────────────

  bot.command('research', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/research(@\w+)?/, '').trim();

    if (!args) {
      await ctx.reply('Usage: /research <query>\nExample: /research lean manufacturing optimization\n\nOptions: --arxiv, --scholar, --year 2024');
      return;
    }

    // Parse flags
    let source: 'both' | 'arxiv' | 'semantic_scholar' = 'both';
    let yearFrom: number | undefined;
    let query = args;

    if (query.includes('--arxiv')) { source = 'arxiv'; query = query.replace('--arxiv', '').trim(); }
    if (query.includes('--scholar')) { source = 'semantic_scholar'; query = query.replace('--scholar', '').trim(); }
    const yearMatch = query.match(/--year\s+(\d{4})/);
    if (yearMatch) { yearFrom = parseInt(yearMatch[1]); query = query.replace(/--year\s+\d{4}/, '').trim(); }

    await ctx.replyWithChatAction('typing');

    const result = await pc.research.searchPapers({ query, source, limit: 5, year_from: yearFrom }, chatId);

    if (result.error) {
      await ctx.reply(String(result.error));
      return;
    }

    const papers = result.papers as Array<{ title: string; authors: string; year: number | null; abstract: string; citations: number | null; url: string; source: string }>;

    if (!papers || papers.length === 0) {
      await ctx.reply('No papers found. Try different keywords.');
      return;
    }

    const lines = [`**Research Results** (${papers.length} papers, ${result.saved_as_citations} saved as citations)`, ''];
    for (let i = 0; i < papers.length; i++) {
      const p = papers[i];
      const citations = p.citations !== null ? ` (${p.citations} citations)` : '';
      const year = p.year ? ` (${p.year})` : '';
      lines.push(`**${i + 1}. ${p.title}**${year}${citations}`);
      if (p.authors) lines.push(`   ${p.authors}`);
      if (p.abstract) lines.push(`   ${p.abstract.slice(0, 200)}${p.abstract.length > 200 ? '...' : ''}`);
      lines.push(`   [${p.source}] ${p.url}`);
      lines.push('');
    }

    const formatted = formatForTelegram(lines.join('\n'));
    const chunks = splitMessage(formatted);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(chunk);
      }
    }
  });

  // ── Learn Command ───────────────────────────────────────

  bot.command('learn', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/learn(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'start': {
        const goal = parts.slice(1).join(' ');
        if (!goal) {
          await ctx.reply('Usage: /learn start <goal>\nExample: /learn start Learn Mandarin Chinese');
          return;
        }

        // Check max plans
        const activePlans = pc.learning.getActivePlansByChat(chatId);
        if (activePlans.length >= 5) {
          await ctx.reply(formatForTelegram(
            `You have **${activePlans.length}** active plans (max 5). Complete or pause one before starting another:\n` +
            activePlans.map((p) => `- **${p.subject}** (/learn pause ${p.id})`).join('\n'),
          ), { parse_mode: 'HTML' });
          return;
        }

        await ctx.replyWithChatAction('typing');

        // Extract clean subject from goal and generate curriculum via AI
        const subject = pc.learning.extractSubject(goal);
        const prompt = pc.learning.buildPlanPrompt(subject, goal);
        const aiResponse = await router.sendMessage({ chatId, message: prompt, skipAutoTrigger: true });
        const topics = pc.learning.parsePlanResponse(aiResponse.text || '');

        if (topics.length === 0) {
          await ctx.reply('Failed to generate a learning plan. Try again with a more specific goal.');
          return;
        }

        try {
          const { plan } = pc.learning.createPlanFromTopics(chatId, subject, goal, topics);
          const allTopics = pc.learning.getTopicsByPlan(plan.id);
          const planText = pc.learning.formatPlan(plan, allTopics);
          await ctx.reply(formatForTelegram(planText), { parse_mode: 'HTML' });
          await ctx.reply(formatForTelegram('Start learning with `/learn session` or modify with `/learn move`, `/learn add`, `/learn remove`.'), { parse_mode: 'HTML' });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(errMsg);
        }
        return;
      }

      case 'plan': {
        const planId = parts[1];
        let plan;
        if (planId) {
          plan = pc.learning.getPlan(planId);
        } else {
          const plans = pc.learning.getActivePlansByChat(chatId);
          plan = plans[0];
        }
        if (!plan) {
          await ctx.reply('No active learning plan. Start one with `/learn start <goal>`.');
          return;
        }
        const topics = pc.learning.getTopicsByPlan(plan.id);
        await ctx.reply(formatForTelegram(pc.learning.formatPlan(plan, topics)), { parse_mode: 'HTML' });
        return;
      }

      case 'plans': {
        const plans = pc.learning.getPlansByChat(chatId);
        await ctx.reply(formatForTelegram(pc.learning.formatPlanList(plans)), { parse_mode: 'HTML' });
        return;
      }

      case 'session': {
        const planRef = parts[1];
        let plan;
        if (planRef) {
          plan = pc.learning.getPlan(planRef) ?? pc.learning.getPlanBySubject(chatId, planRef);
        } else {
          // Smart selection: most overdue reviews, then least recently studied
          plan = pc.learning.getMostOverduePlan(chatId) ?? pc.learning.getLeastRecentPlan(chatId);
        }

        if (!plan) {
          await ctx.reply('No active learning plan. Start one with `/learn start <goal>`.');
          return;
        }

        const { session, openingPrompt } = pc.learning.startSession(chatId, plan);

        // Send opening prompt through AI for a natural start
        await ctx.replyWithChatAction('typing');
        const sessionPrompt = pc.learning.getSessionSystemPrompt(chatId);
        const response = await router.sendMessage({
          chatId,
          message: openingPrompt,
          skipAutoTrigger: true,
          systemPrompt: sessionPrompt ?? undefined,
        });

        if (response.text) {
          const cleanText = pc.learning.stripMarkers(response.text);
          pc.learning.processSessionResponse(chatId, response.text);
          await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
        }
        return;
      }

      case 'review': {
        const plan = pc.learning.getMostOverduePlan(chatId) ?? pc.learning.getLeastRecentPlan(chatId);
        if (!plan) {
          await ctx.reply('No active learning plan. Start one with `/learn start <goal>`.');
          return;
        }

        const { session, openingPrompt } = pc.learning.startSession(chatId, plan, { type: 'review' });

        await ctx.replyWithChatAction('typing');
        const sessionPrompt = pc.learning.getSessionSystemPrompt(chatId);
        const response = await router.sendMessage({
          chatId,
          message: openingPrompt,
          skipAutoTrigger: true,
          systemPrompt: sessionPrompt ?? undefined,
        });

        if (response.text) {
          const cleanText = pc.learning.stripMarkers(response.text);
          pc.learning.processSessionResponse(chatId, response.text);
          await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
        }
        return;
      }

      case 'move': {
        // /learn move <topic> before <other>
        const moveArgs = parts.slice(1).join(' ');
        const beforeMatch = moveArgs.match(/^(.+?)\s+before\s+(.+)$/i);
        if (!beforeMatch) {
          await ctx.reply('Usage: /learn move <topic> before <other topic>');
          return;
        }

        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        const result = pc.learning.moveTopicBefore(plan.id, beforeMatch[1].trim(), beforeMatch[2].trim());
        await ctx.reply(formatForTelegram(result.message), { parse_mode: 'HTML' });
        return;
      }

      case 'add': {
        const topicTitle = parts.slice(1).join(' ');
        if (!topicTitle) {
          await ctx.reply('Usage: /learn add <topic name>');
          return;
        }

        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        await ctx.replyWithChatAction('typing');
        const addPrompt = pc.learning.buildAddTopicPrompt(plan, topicTitle);
        const addResponse = await router.sendMessage({ chatId, message: addPrompt, skipAutoTrigger: true });
        const placement = pc.learning.parseTopicPlacement(addResponse.text || '');

        if (placement) {
          pc.learning.createTopic(plan.id, placement.title, {
            description: placement.description,
            sortOrder: placement.position,
            difficulty: placement.difficulty,
            estimatedMinutes: placement.estimated_minutes,
          });
          await ctx.reply(formatForTelegram(`Added **${placement.title}** at position ${placement.position + 1} in your plan.`), { parse_mode: 'HTML' });
        } else {
          // Fallback: append at end
          pc.learning.createTopic(plan.id, topicTitle);
          await ctx.reply(formatForTelegram(`Added **${topicTitle}** to the end of your plan.`), { parse_mode: 'HTML' });
        }
        return;
      }

      case 'remove': {
        const topicTitle = parts.slice(1).join(' ');
        if (!topicTitle) {
          await ctx.reply('Usage: /learn remove <topic name>');
          return;
        }

        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        const result = pc.learning.requestTopicRemoval(plan.id, topicTitle);
        if (result.requiresAssessment && result.topicTitle) {
          // Start assessment session
          const topic = pc.learning.getTopicByTitle(plan.id, result.topicTitle);
          const assessPrompt = pc.learning.buildAssessmentPrompt(plan.subject, result.topicTitle, topic?.description ?? null);
          const { session } = pc.learning.startSession(chatId, plan, {
            topicId: topic?.id,
            type: 'assessment',
            assessmentTarget: result.topicTitle,
          });

          await ctx.replyWithChatAction('typing');
          const sessionPrompt = pc.learning.getSessionSystemPrompt(chatId);
          const response = await router.sendMessage({
            chatId,
            message: assessPrompt,
            skipAutoTrigger: true,
            systemPrompt: sessionPrompt ?? undefined,
          });

          if (response.text) {
            const cleanText = pc.learning.stripMarkers(response.text);
            pc.learning.processSessionResponse(chatId, response.text);
            await ctx.reply(formatForTelegram(cleanText), { parse_mode: 'HTML' });
          }
        } else {
          await ctx.reply(formatForTelegram(result.message), { parse_mode: 'HTML' });
        }
        return;
      }

      case 'persona': {
        const personaId = parts[1]?.toLowerCase();
        if (!personaId) {
          const personas = pc.learning.listPersonas();
          const plan = pc.learning.getActivePlansByChat(chatId)[0];
          const current = plan ? plan.persona : '(no active plan)';
          const list = personas.map((p) => `- **${p.id}** — ${p.tone}. ${p.bestFor}`).join('\n');
          await ctx.reply(formatForTelegram(`**Current persona:** ${current}\n\n**Available personas:**\n${list}\n\nUsage: \`/learn persona <id>\``), { parse_mode: 'HTML' });
          return;
        }

        const persona = pc.learning.getPersona(personaId);
        if (!persona) {
          await ctx.reply(`Unknown persona: "${personaId}". Use /learn persona to see options.`);
          return;
        }

        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        pc.learning.updatePlan(plan.id, { persona: persona.id });
        await ctx.reply(formatForTelegram(`Persona updated to **${persona.name}** for ${plan.subject}.`), { parse_mode: 'HTML' });
        return;
      }

      case 'time': {
        const today = pc.learning.getDailyTime(chatId);
        const week = pc.learning.getWeeklyTime(chatId);

        const todayMins = today ? Math.round(today.total_seconds / 60) : 0;
        const todaySessions = today?.session_count ?? 0;
        const weekMins = week.reduce((sum, d) => sum + d.total_seconds, 0);
        const weekSessions = week.reduce((sum, d) => sum + d.session_count, 0);
        const goalMet = todayMins >= 10;

        const lines = ['**Study Time**', ''];
        lines.push(`Today: ${todayMins} min (${todaySessions} sessions) ${goalMet ? '- Goal met!' : `- ${10 - todayMins} min to reach daily goal`}`);
        lines.push(`This week: ${Math.round(weekMins / 60)} min (${weekSessions} sessions)`);

        if (week.length > 0) {
          lines.push('');
          lines.push('Daily breakdown:');
          for (const d of week) {
            const mins = Math.round(d.total_seconds / 60);
            const bar = '#'.repeat(Math.min(20, Math.round(mins / 2))) + '.'.repeat(Math.max(0, 5 - Math.round(mins / 2)));
            lines.push(`  ${d.date}: ${mins} min [${bar}]`);
          }
        }

        await ctx.reply(formatForTelegram(lines.join('\n')), { parse_mode: 'HTML' });
        return;
      }

      case 'set-time': {
        const timeStr = parts[1];
        if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) {
          await ctx.reply('Usage: /learn set-time HH:MM (e.g., /learn set-time 08:00)');
          return;
        }
        const [hours, minutes] = timeStr.split(':').map(Number);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
          await ctx.reply('Invalid time. Use HH:MM format (00:00 to 23:59).');
          return;
        }

        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        const cron = `${minutes} ${hours} * * *`;
        pc.learning.updatePlan(plan.id, { preferred_time: cron });
        await ctx.reply(formatForTelegram(`Proactive sessions for **${plan.subject}** set to ${timeStr} daily.`), { parse_mode: 'HTML' });
        return;
      }

      case 'complete': {
        const plan = pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) {
          await ctx.reply('No active learning plan.');
          return;
        }

        const topics = pc.learning.getTopicsByPlan(plan.id);
        const pending = topics.filter((t) => t.status === 'pending' || t.status === 'in_progress');
        if (pending.length > 0) {
          await ctx.reply(formatForTelegram(
            `You still have **${pending.length}** topics to cover in **${plan.subject}**. ` +
            'Are you sure? Use `/learn delete ' + plan.id + '` to force completion, ' +
            'or keep going — you\'re making great progress!',
          ), { parse_mode: 'HTML' });
          return;
        }

        pc.learning.updatePlan(plan.id, { status: 'completed' });
        await ctx.reply(formatForTelegram(`Congratulations! **${plan.subject}** plan marked as complete.`), { parse_mode: 'HTML' });
        return;
      }

      case 'pause': {
        const planId = parts[1];
        const plan = planId ? pc.learning.getPlan(planId) : pc.learning.getActivePlansByChat(chatId)[0];
        if (!plan) { await ctx.reply('No active plan to pause.'); return; }
        pc.learning.updatePlan(plan.id, { status: 'paused' });
        await ctx.reply(formatForTelegram(`**${plan.subject}** paused. Resume with \`/learn resume ${plan.id}\`.`), { parse_mode: 'HTML' });
        return;
      }

      case 'resume': {
        const planId = parts[1];
        if (!planId) { await ctx.reply('Usage: /learn resume <plan-id>'); return; }
        const plan = pc.learning.getPlan(planId);
        if (!plan || plan.status !== 'paused') { await ctx.reply('Plan not found or not paused.'); return; }
        pc.learning.updatePlan(plan.id, { status: 'active' });
        await ctx.reply(formatForTelegram(`**${plan.subject}** resumed! Start a session with \`/learn session\`.`), { parse_mode: 'HTML' });
        return;
      }

      case 'done':
      case 'stop': {
        if (pc.learning.isSessionActive(chatId)) {
          const activeSession = pc.learning.getActiveSession(chatId)!;
          const { durationSeconds } = pc.learning.endSession(chatId, 'user_ended');
          const summary = pc.learning.formatSessionSummary(durationSeconds, activeSession.questionsAsked, activeSession.correctAnswers);
          await ctx.reply(formatForTelegram(summary), { parse_mode: 'HTML' });
        } else {
          await ctx.reply('No active learning session.');
        }
        return;
      }

      case 'delete': {
        const planId = parts[1];
        if (!planId) { await ctx.reply('Usage: /learn delete <plan-id>'); return; }
        const plan = pc.learning.getPlan(planId);
        if (!plan) { await ctx.reply('Plan not found.'); return; }

        const topics = pc.learning.getTopicsByPlan(plan.id);
        const completed = topics.filter((t) => t.status === 'completed');
        if (completed.length > 0 && plan.status !== 'completed') {
          await ctx.reply(formatForTelegram(
            `You've completed **${completed.length}** topics in **${plan.subject}**. ` +
            'That\'s real progress! Consider pausing instead of deleting.\n\n' +
            `To confirm deletion, run: \`/learn delete ${plan.id}\` again.`,
          ), { parse_mode: 'HTML' });
          // Simple confirmation: check if they already ran it once recently
          // For now, allow deletion since they typed the specific ID
        }

        pc.learning.deletePlan(plan.id);
        await ctx.reply(formatForTelegram(`Deleted plan: **${plan.subject}**.`), { parse_mode: 'HTML' });
        return;
      }

      default: {
        await ctx.reply(formatForTelegram(
          '**Learning Coach Commands:**\n' +
          '`/learn start <goal>` — Start a new learning plan\n' +
          '`/learn plan` — View current plan\n' +
          '`/learn plans` — List all plans\n' +
          '`/learn session [plan]` — Start a learning session\n' +
          '`/learn review` — Review due topics (spaced repetition)\n' +
          '`/learn move <topic> before <other>` — Reorder topics\n' +
          '`/learn add <topic>` — Add a topic\n' +
          '`/learn remove <topic>` — Remove a topic (requires assessment)\n' +
          '`/learn persona [name]` — View or change persona\n' +
          '`/learn time` — Show study time stats\n' +
          '`/learn set-time HH:MM` — Set daily session time\n' +
          '`/learn complete` — Graduate from a plan\n' +
          '`/learn pause` / `resume` — Pause or resume a plan\n' +
          '`/learn done` — End current session\n' +
          '`/learn delete <plan-id>` — Delete a plan',
        ), { parse_mode: 'HTML' });
        return;
      }
    }
  });

  // ── Board Command ───────────────────────────────────────

  bot.command('board', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/board(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'list';

    switch (subcommand) {
      case 'list':
      case 'show': {
        const board = pc.kanban.formatBoard(chatId);
        await ctx.reply(formatForTelegram(board), { parse_mode: 'HTML' });
        return;
      }

      case 'add': {
        const title = parts.slice(1).join(' ');
        if (!title) {
          await ctx.reply('Usage: /board add &lt;title&gt;', { parse_mode: 'HTML' });
          return;
        }
        const card = pc.kanban.createCard(chatId, title, { source: 'user' });
        await ctx.reply(
          formatForTelegram(`✅ Card created: **${card.title}**\nID: \`${card.id.slice(0, 8)}\` | Status: backlog | Assignee: noted (assign with /board assign)`),
          { parse_mode: 'HTML' },
        );
        return;
      }

      case 'move': {
        const cardId = parts[1];
        const newStatus = parts[2]?.toLowerCase() as CardStatus;
        if (!cardId || !newStatus) {
          await ctx.reply('Usage: /board move &lt;id&gt; &lt;status&gt;\nStatuses: backlog, in_progress, review, done, deferred, cancelled', { parse_mode: 'HTML' });
          return;
        }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const updated = pc.kanban.moveCard(card.id, newStatus);
        if (!updated) { await ctx.reply('Invalid status.'); return; }
        await ctx.reply(formatForTelegram(`Moved **${updated.title}** → ${newStatus}`), { parse_mode: 'HTML' });
        return;
      }

      case 'assign': {
        const cardId = parts[1];
        const newAssignee = parts[2]?.toLowerCase() as CardAssignee;
        if (!cardId || !newAssignee) {
          await ctx.reply('Usage: /board assign &lt;id&gt; &lt;assignee&gt;\nAssignees: me, bot, collaborative, noted', { parse_mode: 'HTML' });
          return;
        }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const updated = pc.kanban.assignCard(card.id, newAssignee);
        if (!updated) { await ctx.reply('Invalid assignee.'); return; }
        await ctx.reply(formatForTelegram(`Assigned **${updated.title}** → ${newAssignee}`), { parse_mode: 'HTML' });
        // If assigned to bot, trigger immediate execution (don't wait for hourly loop)
        if (newAssignee === 'bot') {
          pc.proactive.triggerBotTasksNow();
        }
        return;
      }

      case 'priority': {
        const cardId = parts[1];
        const newPriority = parseInt(parts[2]);
        if (!cardId || isNaN(newPriority) || newPriority < 1 || newPriority > 5) {
          await ctx.reply('Usage: /board priority &lt;id&gt; &lt;1-5&gt;\n1=critical, 2=high, 3=medium, 4=low, 5=minimal', { parse_mode: 'HTML' });
          return;
        }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const updated = pc.kanban.updateCard(card.id, { priority: newPriority });
        if (!updated) { await ctx.reply('Update failed.'); return; }
        const labels = ['', '🔴 Critical', '🟠 High', '🟡 Medium', '🔵 Low', '⚪ Minimal'];
        await ctx.reply(formatForTelegram(`Updated **${updated.title}** → ${labels[newPriority]}`), { parse_mode: 'HTML' });
        return;
      }

      case 'cancel': {
        const cardId = parts[1];
        if (!cardId) { await ctx.reply('Usage: /board cancel &lt;id&gt;', { parse_mode: 'HTML' }); return; }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const cancelled = pc.kanban.moveCard(card.id, 'cancelled');
        if (!cancelled) { await ctx.reply('Failed to cancel.'); return; }
        await ctx.reply(formatForTelegram(`🚫 Cancelled: **${cancelled.title}**`), { parse_mode: 'HTML' });
        return;
      }

      case 'due': {
        const cardId = parts[1];
        const dateStr = parts.slice(2).join(' ');
        if (!cardId || !dateStr) { await ctx.reply('Usage: /board due &lt;id&gt; &lt;date&gt;\nExamples: tomorrow, 2026-03-25, next Friday', { parse_mode: 'HTML' }); return; }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const dueMs = pc.kanban.parseDateHint(dateStr);
        if (!dueMs) { await ctx.reply(`Could not parse date: "${dateStr}"`); return; }
        const updated = pc.kanban.updateCard(card.id, { due_date: dueMs });
        if (!updated) { await ctx.reply('Update failed.'); return; }
        await ctx.reply(formatForTelegram(`Updated **${updated.title}** — Due: ${new Date(dueMs).toLocaleDateString()}`), { parse_mode: 'HTML' });
        return;
      }

      case 'schedule': {
        const cardId = parts[1];
        const timeStr = parts.slice(2).join(' ');
        if (!cardId || !timeStr) { await ctx.reply('Usage: /board schedule &lt;id&gt; &lt;time&gt;\nExamples: tonight, tomorrow morning, now, 2026-03-25T14:00', { parse_mode: 'HTML' }); return; }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        const schedMs = pc.kanban.parseDateHint(timeStr);
        if (!schedMs) { await ctx.reply(`Could not parse time: "${timeStr}"`); return; }
        const updated = pc.kanban.updateCard(card.id, { scheduled_for: schedMs });
        if (!updated) { await ctx.reply('Update failed.'); return; }
        await ctx.reply(formatForTelegram(`Updated **${updated.title}** — Scheduled: ${new Date(schedMs).toLocaleString()}`), { parse_mode: 'HTML' });
        return;
      }

      case 'delete':
      case 'remove': {
        const cardId = parts[1];
        if (!cardId) { await ctx.reply('Usage: /board delete &lt;id&gt;', { parse_mode: 'HTML' }); return; }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        pc.kanban.deleteCard(card.id);
        await ctx.reply(formatForTelegram(`Deleted: **${card.title}**`), { parse_mode: 'HTML' });
        return;
      }

      case 'view': {
        const cardId = parts[1];
        if (!cardId) { await ctx.reply('Usage: /board view &lt;id&gt;', { parse_mode: 'HTML' }); return; }
        const card = pc.kanban.getCardByPrefix(chatId, cardId);
        if (!card) { await ctx.reply('Card not found.'); return; }
        await ctx.reply(formatForTelegram(pc.kanban.formatCard(card)), { parse_mode: 'HTML' });
        return;
      }

      default:
        await ctx.reply(
          'Board commands:\n' +
            '/board — Show active cards\n' +
            '/board add &lt;title&gt; — Create a card\n' +
            '/board move &lt;id&gt; &lt;status&gt; — Move card\n' +
            '/board assign &lt;id&gt; &lt;assignee&gt; — Assign card\n' +
            '/board priority &lt;id&gt; &lt;1-5&gt; — Change priority\n' +
            '/board due &lt;id&gt; &lt;date&gt; — Set deadline\n' +
            '/board schedule &lt;id&gt; &lt;time&gt; — Set start time\n' +
            '/board cancel &lt;id&gt; — Cancel a card\n' +
            '/board view &lt;id&gt; — View card details\n' +
            '/board delete &lt;id&gt; — Delete card',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Simulation Command ─────────────────────────────────

  bot.command('sim', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/sim(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listScenarios } = await import('../simulation/index.js');
        const scenarios = listScenarios();
        if (scenarios.length === 0) { await ctx.reply('No simulation scenarios. Use the web UI at /sim or ask the AI.'); return; }
        const lines = scenarios.map((s) =>
          `<b>${escapeHtml(s.name)}</b> — ${new Date(s.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Simulation Scenarios (${scenarios.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const name = parts.slice(1).join(' ');
        if (!name) { await ctx.reply('Usage: /sim delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getScenarioByName, deleteScenario } = await import('../simulation/index.js');
        const scenario = getScenarioByName(name);
        if (!scenario) { await ctx.reply(`Scenario "${name}" not found.`); return; }
        deleteScenario(scenario.id);
        await ctx.reply(`Deleted simulation scenario "${name}".`);
        return;
      }

      default:
        const webPort = config.VOICE_WEB_PORT || 3030;
        await ctx.reply(
          '<b>Production Line Simulator:</b>\n\n' +
            `Web UI: <code>http://localhost:${webPort}/sim</code>\n\n` +
            '/sim list — List saved scenarios\n' +
            '/sim delete &lt;name&gt; — Delete scenario\n\n' +
            'Or ask the AI: "Simulate a T-shirt line with 9 operations"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── RCA Command ────────────────────────────────────────

  bot.command('rca', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/rca(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listRcaDocs } = await import('../rca.js');
        const docs = listRcaDocs();
        if (docs.length === 0) { await ctx.reply('No RCA documents. Ask the AI to create one.'); return; }
        const methodNames: Record<string, string> = { '5why': '5 Whys', fishbone: 'Fishbone', pdca: 'PDCA', fta: 'FTA', mindmap: 'Mind Map' };
        const lines = docs.map((d) =>
          `<b>${escapeHtml(d.name)}</b> — ${methodNames[d.method] || d.method} — ${new Date(d.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>RCA Documents (${docs.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'view': {
        const docName = parts.slice(1).join(' ');
        if (!docName) { await ctx.reply('Usage: /rca view &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getRcaDocByName, getRcaNodes, formatRcaDocument } = await import('../rca.js');
        const doc = getRcaDocByName(docName);
        if (!doc) { await ctx.reply(`RCA "${docName}" not found.`); return; }
        const nodes = getRcaNodes(doc.id);
        await ctx.reply(formatRcaDocument(doc, nodes, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const docName = parts.slice(1).join(' ');
        if (!docName) { await ctx.reply('Usage: /rca delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getRcaDocByName, deleteRcaDoc } = await import('../rca.js');
        const doc = getRcaDocByName(docName);
        if (!doc) { await ctx.reply(`RCA "${docName}" not found.`); return; }
        deleteRcaDoc(doc.id);
        await ctx.reply(`Deleted RCA "${docName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Root Cause Analysis Commands:</b>\n\n' +
            '/rca list — List RCA documents\n' +
            '/rca view &lt;name&gt; — View document\n' +
            '/rca delete &lt;name&gt; — Delete document\n\n' +
            'Methods: 5 Whys, Ishikawa/Fishbone, PDCA, Fault Tree, Mind Map, A3 Report\n' +
            'Ask the AI: "Do a 5 Whys for our solder bridge defect"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── FMEA Command ───────────────────────────────────────

  bot.command('fmea', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/fmea(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listFmeaDocs } = await import('../fmea.js');
        const docs = listFmeaDocs();
        if (docs.length === 0) { await ctx.reply('No FMEA documents. Send a CSV with /fmea to start, or ask the AI to create one.'); return; }
        const lines = docs.map((d) =>
          `<b>${escapeHtml(d.name)}</b> — ${d.fmea_type.toUpperCase()} — ${d.product || 'no product'} — ${new Date(d.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>FMEA Documents (${docs.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'report': {
        const docName = parts.slice(1).join(' ');
        if (!docName) { await ctx.reply('Usage: /fmea report &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getFmeaDocByName, getFailureModes, getActions, formatFmeaWorksheet } = await import('../fmea.js');
        const doc = getFmeaDocByName(docName);
        if (!doc) { await ctx.reply(`FMEA "${docName}" not found.`); return; }
        const fms = getFailureModes(doc.id);
        const acts = getActions(doc.id);
        await ctx.reply(formatFmeaWorksheet(doc, fms, acts, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const docName = parts.slice(1).join(' ');
        if (!docName) { await ctx.reply('Usage: /fmea delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getFmeaDocByName, deleteFmeaDoc } = await import('../fmea.js');
        const doc = getFmeaDocByName(docName);
        if (!doc) { await ctx.reply(`FMEA "${docName}" not found.`); return; }
        deleteFmeaDoc(doc.id);
        await ctx.reply(`Deleted FMEA "${docName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>FMEA Commands:</b>\n\n' +
            'Send CSV with caption <code>/fmea &lt;doc_name&gt;</code> to import\n\n' +
            '/fmea list — List FMEA documents\n' +
            '/fmea report &lt;name&gt; — View full worksheet\n' +
            '/fmea delete &lt;name&gt; — Delete document\n\n' +
            'Or ask the AI: "Create a PFMEA for our solder process"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── SPC Setup Command ──────────────────────────────────

  bot.command('spc', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/spc(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listControlPlans } = await import('../control-plan.js');
        const plans = listControlPlans();
        if (plans.length === 0) { await ctx.reply('No control plans. Use /spc create to start.'); return; }
        const lines = plans.map((p) =>
          `<b>${escapeHtml(p.name)}</b> — ${p.process_type} — ${p.product || 'no product'} — ${new Date(p.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Control Plans (${plans.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'summary': {
        const planName = parts.slice(1).join(' ');
        if (!planName) { await ctx.reply('Usage: /spc summary &lt;plan name&gt;', { parse_mode: 'HTML' }); return; }
        const { getControlPlanByName, buildControlPlanSummary, formatControlPlan } = await import('../control-plan.js');
        const plan = getControlPlanByName(planName);
        if (!plan) { await ctx.reply(`Plan "${planName}" not found.`); return; }
        const summary = buildControlPlanSummary(plan.id);
        await ctx.reply(formatControlPlan(summary, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const planName = parts.slice(1).join(' ');
        if (!planName) { await ctx.reply('Usage: /spc delete &lt;plan name&gt;', { parse_mode: 'HTML' }); return; }
        const { getControlPlanByName, deleteControlPlan } = await import('../control-plan.js');
        const plan = getControlPlanByName(planName);
        if (!plan) { await ctx.reply(`Plan "${planName}" not found.`); return; }
        deleteControlPlan(plan.id);
        await ctx.reply(`Deleted control plan "${planName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>SPC Control Plan Commands:</b>\n\n' +
            'Control plans are created via chat — tell the AI about your process and it will build the plan using the spc_setup tool.\n\n' +
            '/spc list — List control plans\n' +
            '/spc summary &lt;name&gt; — View control plan\n' +
            '/spc delete &lt;name&gt; — Delete plan\n\n' +
            'Example: "Set up SPC for our PCB assembly line. We make automotive control boards."',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Inventory Command ──────────────────────────────────

  bot.command('inventory', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/inventory(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listInventoryProjects } = await import('../inventory.js');
        const projects = listInventoryProjects();
        if (projects.length === 0) {
          await ctx.reply('No inventory projects. Send a CSV with /inventory to start.');
          return;
        }
        const lines = projects.map((p) =>
          `<b>${escapeHtml(p.name)}</b> — ${new Date(p.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Inventory Projects (${projects.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'status': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) { await ctx.reply('Usage: /inventory status &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getInventoryProjectByName, getInventoryItems, getInventoryResults, formatReplenishmentPlan } = await import('../inventory.js');
        const project = getInventoryProjectByName(projectName);
        if (!project) { await ctx.reply(`Project "${projectName}" not found.`); return; }
        const results = getInventoryResults(project.id);
        const planResult = results.find((r) => r.result_type === 'replenishment');
        const abcResult = results.find((r) => r.result_type === 'abc');
        if (!planResult || !abcResult) { await ctx.reply('No analysis results. Upload a CSV first.'); return; }
        const plans = JSON.parse(planResult.result_json);
        const abc = JSON.parse(abcResult.result_json);
        await ctx.reply(formatReplenishmentPlan(plans, abc, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) { await ctx.reply('Usage: /inventory delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getInventoryProjectByName, deleteInventoryProject } = await import('../inventory.js');
        const project = getInventoryProjectByName(projectName);
        if (!project) { await ctx.reply(`Project "${projectName}" not found.`); return; }
        deleteInventoryProject(project.id);
        await ctx.reply(`Deleted inventory project "${projectName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Inventory Planning Commands:</b>\n\n' +
            'Send CSV with caption <code>/inventory &lt;project_name&gt;</code>\n\n' +
            '/inventory list — List projects\n' +
            '/inventory status &lt;name&gt; — Show replenishment plan\n' +
            '/inventory delete &lt;name&gt; — Delete project',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Sigma Command ──────────────────────────────────────

  bot.command('sigma', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/sigma(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listSigmaProjects } = await import('../sigma.js');
        const projects = listSigmaProjects();
        if (projects.length === 0) {
          await ctx.reply('No sigma projects. Send a CSV with /sigma to start.');
          return;
        }
        const lines = projects.map((p) =>
          `<b>${escapeHtml(p.name)}</b> — USL: ${p.usl} LSL: ${p.lsl} — ${new Date(p.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Sigma Projects (${projects.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'status': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) { await ctx.reply('Usage: /sigma status &lt;project name&gt;', { parse_mode: 'HTML' }); return; }
        const { getSigmaProjectByName, getMeasurements, getSigmaResults, formatCapabilityResult } = await import('../sigma.js');
        const project = getSigmaProjectByName(projectName);
        if (!project) { await ctx.reply(`Project "${projectName}" not found.`); return; }
        const results = getSigmaResults(project.id);
        const capResult = results.find((r) => r.result_type === 'capability');
        const chartResult = results.find((r) => r.result_type === 'control_chart');
        if (!capResult || !chartResult) { await ctx.reply('No analysis results yet. Upload a CSV first.'); return; }
        const cap = JSON.parse(capResult.result_json);
        const chart = JSON.parse(chartResult.result_json);
        await ctx.reply(formatCapabilityResult(cap, chart, projectName, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) { await ctx.reply('Usage: /sigma delete &lt;project name&gt;', { parse_mode: 'HTML' }); return; }
        const { getSigmaProjectByName, deleteSigmaProject } = await import('../sigma.js');
        const project = getSigmaProjectByName(projectName);
        if (!project) { await ctx.reply(`Project "${projectName}" not found.`); return; }
        deleteSigmaProject(project.id);
        await ctx.reply(`Deleted sigma project "${projectName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Six Sigma Commands:</b>\n\n' +
            'Send CSV with caption <code>/sigma &lt;USL&gt; &lt;LSL&gt; &lt;project_name&gt; [target=value]</code>\n\n' +
            '/sigma list — List projects\n' +
            '/sigma status &lt;name&gt; — Show latest results\n' +
            '/sigma delete &lt;name&gt; — Delete project',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Balance Command ─────────────────────────────────────

  bot.command('balance', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/balance(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listProjects } = await import('../balance.js');
        const projects = listProjects();
        if (projects.length === 0) {
          await ctx.reply('No balance projects. Send a CSV file with /balance to start.');
          return;
        }
        const lines = projects.map((p) =>
          `<b>${escapeHtml(p.name)}</b> — takt: ${p.takt_time}s — ${new Date(p.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Balance Projects (${projects.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'status': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) {
          await ctx.reply('Usage: /balance status &lt;project name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const { getProjectByName, getProjectTasks, getResultsForProject, formatBalanceResult, runBalance } = await import('../balance.js');
        const project = getProjectByName(projectName);
        if (!project) {
          await ctx.reply(`Project "${projectName}" not found.`);
          return;
        }
        const results = getResultsForProject(project.id);
        if (results.length === 0) {
          await ctx.reply(`Project "${projectName}" has no balance runs yet.`);
          return;
        }
        const latest = results[0];
        const tasks = getProjectTasks(project.id);
        const balanceResult = runBalance(tasks, latest.takt_time, project.name);
        balanceResult.project_id = project.id;
        await ctx.reply(formatBalanceResult(balanceResult, true), { parse_mode: 'HTML' });
        return;
      }

      case 'compare': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) {
          await ctx.reply('Usage: /balance compare &lt;project name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const { getProjectByName, getResultsForProject, formatBalanceComparison } = await import('../balance.js');
        const project = getProjectByName(projectName);
        if (!project) {
          await ctx.reply(`Project "${projectName}" not found.`);
          return;
        }
        const results = getResultsForProject(project.id);
        if (results.length === 0) {
          await ctx.reply('No balance runs found for this project.');
          return;
        }
        await ctx.reply(formatBalanceComparison(results, true), { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const projectName = parts.slice(1).join(' ');
        if (!projectName) {
          await ctx.reply('Usage: /balance delete &lt;project name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const { getProjectByName, deleteProject } = await import('../balance.js');
        const project = getProjectByName(projectName);
        if (!project) {
          await ctx.reply(`Project "${projectName}" not found.`);
          return;
        }
        deleteProject(project.id);
        await ctx.reply(`Deleted balance project "${projectName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Line Balance Commands:</b>\n\n' +
            'Send a CSV file with caption <code>/balance &lt;takt_time&gt; &lt;project_name&gt;</code>\n\n' +
            '/balance list — List projects\n' +
            '/balance status &lt;name&gt; — Show latest result\n' +
            '/balance compare &lt;name&gt; — Compare runs\n' +
            '/balance delete &lt;name&gt; — Delete project',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Compress Command ─────────────────────────────────────

  bot.command('compress', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);

    // Get the message being replied to, or ask the AI to compress its last response
    const replyText = ctx.message?.reply_to_message && 'text' in ctx.message.reply_to_message
      ? ctx.message.reply_to_message.text
      : null;

    const compressPrompt = replyText
      ? `Compress the following into the 5 sentences that contain the most decision-relevant information. No filler, no hedging — just the signal:\n\n${replyText}`
      : 'Compress your last response into the 5 sentences that contain the most decision-relevant information. No filler, no hedging — just the signal.';

    await handleMessage(ctx, compressPrompt, pc);
  });

  // ── Digest Command ──────────────────────────────────────

  bot.command('digest', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/digest(@\w+)?/, '').trim().toLowerCase();

    if (args === 'daily' || args === 'weekly' || args === 'off') {
      pc.proactive.setPreference(chatId, args as DigestFrequency);
      if (args === 'off') {
        await ctx.reply('Digest disabled.');
      } else {
        await ctx.reply(`Digest set to <b>${args}</b>. I'll send you activity summaries.`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (args === 'now') {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const digest = pc.proactive.buildDigest(chatId, DAY_MS);
      await ctx.reply(formatForTelegram(digest), { parse_mode: 'HTML' });
      return;
    }

    // Show current setting
    const current = pc.proactive.getPreference(chatId);
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
        const allTools = pc.tools.listRegistered();
        const userTools = pc.tools.listUserTools();
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
        const userTool = pc.tools.getByName(name.toLowerCase());
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
        const allTools = pc.tools.listRegistered();
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
        const fixToolObj = pc.tools.getByName(fixName.toLowerCase());
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
        const fixResult = await pc.forge.fixTool(fixToolObj.id, fixFeedback, chatId, router);
        if ('error' in fixResult) {
          await ctx.reply(fixResult.error);
        } else {
          await ctx.reply(fixResult.summary);
        }
        return;
      }

      case 'upload': {
        await handleToolUpload(ctx, pc);
        return;
      }

      case 'enable': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool enable &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = pc.tools.getByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        pc.tools.enable(tool.id);
        pc.tools.loadUserTools();
        await ctx.reply(`Tool "${name}" enabled.`);
        return;
      }

      case 'disable': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool disable &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = pc.tools.getByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        pc.tools.disable(tool.id);
        pc.tools.loadUserTools();
        await ctx.reply(`Tool "${name}" disabled.`);
        return;
      }

      case 'lock': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool lock &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = pc.tools.getByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        pc.tools.lock(tool.id);
        await ctx.reply(`Tool "${name}" locked.`);
        return;
      }

      case 'unlock': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool unlock &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = pc.tools.getByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        pc.tools.unlock(tool.id);
        await ctx.reply(`Tool "${name}" unlocked.`);
        return;
      }

      case 'delete': {
        const name = parts[1];
        if (!name) { await ctx.reply('Usage: /tool delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const tool = pc.tools.getByName(name.toLowerCase());
        if (!tool) { await ctx.reply('User tool not found.'); return; }
        if (tool.locked) { await ctx.reply('Tool is locked. Unlock it first.'); return; }
        pc.tools.delete(tool.id);
        pc.tools.loadUserTools();
        await ctx.reply(`Tool "${name}" deleted.`);
        return;
      }

      case 'export': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /tool export &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const tool = pc.tools.getByName(name);
        if (!tool) {
          await ctx.reply(`User tool "${name}" not found. Only user-created tools can be exported.`);
          return;
        }
        const filepath = pc.forge.exportToolToMarkdown(tool);
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

    const caps = await pc.voice.capabilities();
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

      // Transcribe (returns text + detected language)
      const { text: transcript } = await pc.voice.transcribe(localPath);
      logger.info({ chatId: ctx.chat.id, transcript }, 'Voice transcribed');

      // Process as text with voice reply forced and voice prompt tuning
      await handleMessage(
        ctx,
        transcript,
        pc,
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
        await handleMessage(ctx, `[Photo received] ${caption}`, pc);
        return;
      }

      // Download to workspace/uploads/
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await handleMessage(ctx, `[Photo received] ${caption}`, pc);
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
        const memoryContext = await pc.memory.buildContext(chatId, caption);
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

          pc.memory.saveConversationTurn(chatId, `[Photo] ${caption}`, response.text).catch((err) => {
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
          pc,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Photo handler failed');
      await handleMessage(ctx, `[Photo received] ${caption}`, pc);
    }
  });

  // ── Domain Pack Command ───────────────────────────────────

  bot.command('pack', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/pack(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase() || 'help';

    // Lazy import to avoid loading packs module at bot init time
    const { getLoadedPacks, getPackByName, scaffoldPack } = await import('../packs.js');

    switch (sub) {
      case 'list': {
        const packs = getLoadedPacks();
        if (packs.length === 0) {
          await ctx.reply(
            'No domain packs installed.\n\n' +
              'Create one with: <code>/pack create name "description"</code>\n' +
              'See <code>docs/customization-guide.md</code> for the full guide.',
            { parse_mode: 'HTML' },
          );
          return;
        }
        const lines = packs.map(
          (p) =>
            `<b>${p.displayName}</b> (${p.name} v${p.version})\n` +
            `  ${p.description}\n` +
            `  Tools: ${p.toolCount} | Skills: ${p.skillCount} | Templates: ${p.templateFiles.length}`,
        );
        await ctx.reply(`<b>Domain Packs (${packs.length})</b>\n\n${lines.join('\n\n')}`, {
          parse_mode: 'HTML',
        });
        return;
      }

      case 'info': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /pack info &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const pack = getPackByName(name);
        if (!pack) {
          await ctx.reply(`Pack not found: <code>${name}</code>`, { parse_mode: 'HTML' });
          return;
        }
        const lines = [
          `<b>${pack.displayName}</b> (v${pack.version})`,
          pack.author ? `Author: ${pack.author}` : '',
          `Description: ${pack.description}`,
          '',
          `<b>Tools (${pack.toolCount}):</b>`,
          pack.toolCount > 0 ? '(registered in tool registry)' : '(none)',
          '',
          `<b>Skills (${pack.skillCount}):</b>`,
          pack.skillCount > 0 ? '(registered in skill list)' : '(none)',
          '',
          `<b>Templates (${pack.templateFiles.length}):</b>`,
          pack.templateFiles.length > 0 ? pack.templateFiles.map((f) => `  • ${f}`).join('\n') : '(none)',
          '',
          `<b>Intent Patterns:</b> ${pack.intentPatterns.length}`,
          `<b>Pack Commands:</b> ${pack.commands.length > 0 ? pack.commands.map((c) => `/${c.name}`).join(', ') : '(none)'}`,
        ].filter(Boolean);
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
        return;
      }

      case 'create': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /pack create &lt;name&gt; "description"', { parse_mode: 'HTML' });
          return;
        }
        // Extract description from quotes
        const descMatch = args.match(/"([^"]+)"|'([^']+)'/);
        const description = descMatch ? (descMatch[1] || descMatch[2]) : `${name} domain tools`;
        try {
          const path = scaffoldPack(name, description);
          await ctx.reply(
            `Pack scaffolded: <code>packs/${name}/</code>\n\n` +
              'Next steps:\n' +
              '1. Edit <code>pack.yaml</code> — describe capabilities &amp; intent patterns\n' +
              '2. Add tools in <code>tools/*.md</code>\n' +
              '3. Add skills in <code>skills/*.md</code>\n' +
              '4. Restart clauded or use /reload\n' +
              '5. Verify with <code>/pack info ' + name + '</code>\n\n' +
              'See <code>docs/customization-guide.md</code> for the full guide.',
            { parse_mode: 'HTML' },
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`Failed to create pack: ${msg}`);
        }
        return;
      }

      case 'templates': {
        const name = parts[1];
        if (!name) {
          await ctx.reply('Usage: /pack templates &lt;name&gt;', { parse_mode: 'HTML' });
          return;
        }
        const pack = getPackByName(name);
        if (!pack) {
          await ctx.reply(`Pack not found: <code>${name}</code>`, { parse_mode: 'HTML' });
          return;
        }
        if (pack.templateFiles.length === 0) {
          await ctx.reply(`Pack <b>${pack.displayName}</b> has no templates.`, { parse_mode: 'HTML' });
          return;
        }
        // Send each template as a file
        for (const file of pack.templateFiles) {
          try {
            const filePath = resolve(pack.path, 'templates', file);
            await ctx.replyWithDocument(new InputFile(filePath, file));
          } catch (err) {
            logger.warn({ err, file, pack: name }, 'Failed to send template file');
          }
        }
        return;
      }

      default:
        await ctx.reply(
          '<b>/pack — Domain Pack Management</b>\n\n' +
            '/pack list — Show installed packs\n' +
            '/pack info &lt;name&gt; — Pack details (tools, skills, templates)\n' +
            '/pack create &lt;name&gt; "description" — Scaffold a new pack\n' +
            '/pack templates &lt;name&gt; — Send template files\n\n' +
            '<b>Customization Levels:</b>\n' +
            '1. <b>Simple</b> — /tool generate "description" (any user, no code)\n' +
            '2. <b>Medium</b> — Domain Pack (tools + skills + templates in packs/)\n' +
            '3. <b>Full</b> — TypeScript module (web dashboards, DB, charts)\n\n' +
            'See <code>docs/customization-guide.md</code> for the full guide.',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Capacity Planning Command ─────────────────────────────

  bot.command('capacity', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/capacity(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listPlans } = await import('../capacity/index.js');
        const plans = listPlans();
        if (plans.length === 0) { await ctx.reply('No capacity plans. Use the web UI at /capacity or ask the AI.'); return; }
        const lines = plans.map((p) =>
          `<b>${escapeHtml(p.name)}</b> — ${new Date(p.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Capacity Plans (${plans.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'view': {
        const planName = parts.slice(1).join(' ');
        if (!planName) { await ctx.reply('Usage: /capacity view &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getPlan } = await import('../capacity/index.js');
        const plan = getPlan(planName);
        if (!plan) { await ctx.reply(`Plan "${planName}" not found.`); return; }
        const result = plan.result_json ? JSON.parse(plan.result_json) : null;
        let msg = `<b>Capacity Plan: ${escapeHtml(plan.name)}</b>\n`;
        if (result) {
          msg += `\nOverall Utilization: <b>${result.overall_utilization_pct?.toFixed(1)}%</b>`;
          msg += `\nCapacity: ${result.total_capacity_hours?.toFixed(0)}h | Demand: ${result.total_demand_hours?.toFixed(0)}h`;
          msg += `\nBottlenecks: ${result.bottleneck_count}`;
          if (result.constraint_ranking?.length > 0) {
            msg += '\n\n<b>Constraints:</b>';
            for (const c of result.constraint_ranking.slice(0, 5)) {
              msg += `\n#${c.rank} ${c.line_code}: ${c.utilization_pct?.toFixed(1)}% — ${c.recommendation}`;
            }
          }
        } else {
          msg += '\n(No analysis results yet — run analysis from web UI)';
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const planName = parts.slice(1).join(' ');
        if (!planName) { await ctx.reply('Usage: /capacity delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getPlan, deletePlan } = await import('../capacity/index.js');
        const plan = getPlan(planName);
        if (!plan) { await ctx.reply(`Plan "${planName}" not found.`); return; }
        deletePlan(plan.id);
        await ctx.reply(`Deleted capacity plan "${planName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Capacity Planning Commands:</b>\n\n' +
            '/capacity list — List saved plans\n' +
            '/capacity view &lt;name&gt; — View plan results\n' +
            '/capacity delete &lt;name&gt; — Delete plan\n\n' +
            '<b>Web UI:</b> Open /capacity on the dashboard for the full interactive experience.\n\n' +
            'Or ask the AI: "Run capacity analysis for 3 sewing lines, 5 working days, 2 shifts"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── FSM Command ──────────────────────────────────────────

  bot.command('fsm', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/fsm(@\w+)?/, '').trim();
    const subcommand = args.split(/\s+/)[0]?.toLowerCase() || 'help';

    if (subcommand === 'list') {
      const { listFSMs } = await import('../fsm/index.js');
      const configs = listFSMs();
      if (configs.length === 0) { await ctx.reply('No FSM configs. Use /fsm on the web dashboard.'); return; }
      const lines = configs.map((c) => `<b>${escapeHtml(c.name)}</b> — ${new Date(c.updated_at).toLocaleDateString()}`);
      await ctx.reply(`<b>FSM Configs (${configs.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    } else if (subcommand === 'templates') {
      const { listTemplates } = await import('../fsm/index.js');
      const templates = listTemplates();
      const lines = templates.map((t) => `<b>${t.label}</b> (${t.resource_type}) — ${t.description}`);
      await ctx.reply(`<b>FSM Templates:</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        '<b>State Machine Simulator Commands:</b>\n\n' +
          '/fsm list — List saved configs\n' +
          '/fsm templates — List manufacturing templates\n\n' +
          '<b>Web UI:</b> /fsm on dashboard\n\n' +
          'Templates: CNC Machine, Conveyor System, AGV, Order Processing\n' +
          'Bridges: S16 Simulation, VSM, TOC, Sequencer',
        { parse_mode: 'HTML' },
      );
    }
  });

  // ── DOE Command ──────────────────────────────────────────

  bot.command('doe', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/doe(@\w+)?/, '').trim();
    const subcommand = args.split(/\s+/)[0]?.toLowerCase() || 'help';

    if (subcommand === 'list') {
      const { listDOEs } = await import('../doe/index.js');
      const exps = listDOEs();
      if (exps.length === 0) { await ctx.reply('No DOE experiments. Use /doe on the web dashboard.'); return; }
      const lines = exps.map((e) => `<b>${escapeHtml(e.name)}</b> — ${new Date(e.updated_at).toLocaleDateString()}`);
      await ctx.reply(`<b>DOE Experiments (${exps.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        '<b>Design of Experiments Commands:</b>\n\n' +
          '/doe list — List saved experiments\n\n' +
          '<b>Web UI:</b> /doe on dashboard\n\n' +
          'Designs: Full Factorial, Fractional, Taguchi, Box-Behnken, CCD\n' +
          'Ask: "Set up a 2^3 full factorial for temperature, pressure, and speed"',
        { parse_mode: 'HTML' },
      );
    }
  });

  // ── CONWIP/Heijunka Command ──────────────────────────────

  bot.command('conwip', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/conwip(@\w+)?/, '').trim();
    const subcommand = args.split(/\s+/)[0]?.toLowerCase() || 'help';

    if (subcommand === 'list') {
      const { listConwips } = await import('../conwip/index.js');
      const configs = listConwips();
      if (configs.length === 0) { await ctx.reply('No CONWIP/Heijunka configs. Use /conwip on the web dashboard.'); return; }
      const lines = configs.map((c) => `<b>${escapeHtml(c.name)}</b> — ${new Date(c.updated_at).toLocaleDateString()}`);
      await ctx.reply(`<b>Configs (${configs.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        '<b>CONWIP & Heijunka Commands:</b>\n\n' +
          '/conwip list — List saved configs\n\n' +
          '<b>Web UI:</b> /conwip on dashboard\n\n' +
          'Or ask: "Set up a Heijunka box for 3 products with 50/30/20 mix"',
        { parse_mode: 'HTML' },
      );
    }
  });

  // ── TOC Command ──────────────────────────────────────────

  bot.command('toc', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/toc(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listTOCs } = await import('../toc/index.js');
        const configs = listTOCs();
        if (configs.length === 0) { await ctx.reply('No TOC configs. Use /toc on the web dashboard.'); return; }
        const lines = configs.map((c) => `<b>${escapeHtml(c.name)}</b> — ${new Date(c.updated_at).toLocaleDateString()}`);
        await ctx.reply(`<b>TOC Configs (${configs.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'view': {
        const name = parts.slice(1).join(' ');
        if (!name) { await ctx.reply('Usage: /toc view &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getTOC } = await import('../toc/index.js');
        const toc = getTOC(name);
        if (!toc) { await ctx.reply(`Config "${name}" not found.`); return; }
        const result = toc.result_json ? JSON.parse(toc.result_json) : null;
        let msg = `<b>TOC: ${escapeHtml(toc.name)}</b>\n`;
        if (result) {
          msg += `\nCCR: <b>${result.constraint?.ccr_name}</b> (${result.constraint?.ccr_utilization_pct?.toFixed(1)}%)`;
          msg += `\nT/unit: $${result.throughput?.throughput_per_unit?.toFixed(2)}`;
          msg += `\nNP: $${result.throughput?.net_profit?.toLocaleString()}/mo`;
          msg += `\nROI: ${result.throughput?.roi_pct?.toFixed(1)}%`;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      default:
        await ctx.reply(
          '<b>TOC & WIP Tracking Commands:</b>\n\n' +
            '/toc list — List saved configs\n' +
            '/toc view &lt;name&gt; — View analysis\n\n' +
            '<b>Web UI:</b> Open /toc on the dashboard.\n\n' +
            'Or ask: "Run TOC analysis for 5 work centers, identify the constraint"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── VSM Command ──────────────────────────────────────────

  bot.command('vsm', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/vsm(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listVSMs } = await import('../vsm/index.js');
        const maps = listVSMs();
        if (maps.length === 0) { await ctx.reply('No VSM maps. Use the web UI at /vsm or ask the AI.'); return; }
        const lines = maps.map((m) =>
          `<b>${escapeHtml(m.name)}</b> — ${new Date(m.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>VSM Maps (${maps.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'view': {
        const mapName = parts.slice(1).join(' ');
        if (!mapName) { await ctx.reply('Usage: /vsm view &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getVSM } = await import('../vsm/index.js');
        const vsm = getVSM(mapName);
        if (!vsm) { await ctx.reply(`Map "${mapName}" not found.`); return; }
        const result = vsm.result_json ? JSON.parse(vsm.result_json) : null;
        let msg = `<b>VSM: ${escapeHtml(vsm.name)}</b>\n`;
        if (result) {
          msg += `\nPCE: <b>${result.pce_pct?.toFixed(1)}%</b>`;
          msg += `\nLead Time: ${result.total_lead_time?.toFixed(1)} min`;
          msg += `\nVA: ${result.total_va_time?.toFixed(1)} min | NVA: ${result.total_nva_time?.toFixed(1)} min`;
          msg += `\nTakt: ${result.takt_time?.toFixed(2)} min | WIP: ${result.total_wip_units} units`;
          msg += `\nBottleneck: ${result.bottleneck_step}`;
        } else {
          msg += '\n(No analysis results yet)';
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const mapName = parts.slice(1).join(' ');
        if (!mapName) { await ctx.reply('Usage: /vsm delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getVSM, deleteVSM } = await import('../vsm/index.js');
        const vsm = getVSM(mapName);
        if (!vsm) { await ctx.reply(`Map "${mapName}" not found.`); return; }
        deleteVSM(vsm.id);
        await ctx.reply(`Deleted VSM "${mapName}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Value Stream Mapping Commands:</b>\n\n' +
            '/vsm list — List saved maps\n' +
            '/vsm view &lt;name&gt; — View map analysis\n' +
            '/vsm delete &lt;name&gt; — Delete map\n\n' +
            '<b>Web UI:</b> Open /vsm on the dashboard.\n\n' +
            'Or ask the AI: "Create a VSM for our PCB assembly line with 6 process steps"',
          { parse_mode: 'HTML' },
        );
    }
  });

  // ── Sequencer Command ────────────────────────────────────

  bot.command('sequence', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/sequence(@\w+)?/, '').trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || 'help';

    switch (subcommand) {
      case 'list': {
        const { listSchedules } = await import('../sequencer/index.js');
        const schedules = listSchedules();
        if (schedules.length === 0) { await ctx.reply('No saved schedules. Use the web UI at /sequence or ask the AI.'); return; }
        const lines = schedules.map((s) =>
          `<b>${escapeHtml(s.name)}</b> — ${new Date(s.updated_at).toLocaleDateString()}`
        );
        await ctx.reply(`<b>Schedules (${schedules.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
        return;
      }

      case 'delete': {
        const name = parts.slice(1).join(' ');
        if (!name) { await ctx.reply('Usage: /sequence delete &lt;name&gt;', { parse_mode: 'HTML' }); return; }
        const { getSchedule, deleteSchedule } = await import('../sequencer/index.js');
        const sched = getSchedule(name);
        if (!sched) { await ctx.reply(`Schedule "${name}" not found.`); return; }
        deleteSchedule(sched.id);
        await ctx.reply(`Deleted schedule "${name}".`);
        return;
      }

      default:
        await ctx.reply(
          '<b>Job Sequencer Commands:</b>\n\n' +
            '/sequence list — List saved schedules\n' +
            '/sequence delete &lt;name&gt; — Delete schedule\n\n' +
            '<b>Web UI:</b> Open /sequence on the dashboard.\n\n' +
            'Or ask the AI: "Sequence 5 jobs on 2 machines using SPT and EDD, compare results"',
          { parse_mode: 'HTML' },
        );
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
      await handleSkillUpload(ctx, pc);
      return;
    }
    if (caption.startsWith('/tool upload')) {
      await handleToolUpload(ctx, pc);
      return;
    }

    // Intercept /balance CSV uploads
    if (caption.startsWith('/balance')) {
      await handleBalanceCsv(ctx, caption);
      return;
    }

    // Intercept /sigma CSV uploads
    if (caption.startsWith('/sigma')) {
      await handleSigmaCsv(ctx, caption);
      return;
    }

    // Intercept /inventory CSV uploads
    if (caption.startsWith('/inventory')) {
      await handleInventoryCsv(ctx, caption);
      return;
    }

    // Intercept /fmea CSV uploads
    if (caption.startsWith('/fmea')) {
      await handleFmeaCsv(ctx, caption);
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
        await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, pc);
        return;
      }

      // Download to workspace/uploads/
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, pc);
        return;
      }

      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      mkdirSync(UPLOADS_DIR, { recursive: true });
      const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buffer);

      // Parse the file
      const parsed = await pc.files.parse(localPath, doc.mime_type);

      if (parsed.error) {
        // Parsing failed — fall back to basic message
        await handleMessage(
          ctx,
          `[Document received: ${fileName}] ${caption}\n\n(Could not parse: ${parsed.error})`,
          pc,
        );
        return;
      }

      // Build message with parsed content
      const meta: string[] = [`[Document: ${fileName}]`];
      if (parsed.pageCount) meta.push(`Pages: ${parsed.pageCount}`);
      if (parsed.sheetCount) meta.push(`Sheets: ${parsed.sheetCount}`);
      if (parsed.truncated) meta.push('(Content was truncated)');

      const message = `${meta.join(' | ')}\n\n${parsed.text}${caption ? `\n\nUser caption: ${caption}` : ''}`;
      await handleMessage(ctx, message, pc, false, true);
    } catch (err) {
      logger.error({ err }, 'Document handler failed');
      await handleMessage(ctx, `[Document received: ${fileName}] ${caption}`, pc);
    }
  });

  // ── Text Handler (catch-all) ──────────────────────────────

  bot.on('message:text', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await handleMessage(ctx, ctx.message.text, pc);
  });

  // ── Error Handler ─────────────────────────────────────────

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.chat?.id }, 'Bot error');
  });

  return bot;
}
