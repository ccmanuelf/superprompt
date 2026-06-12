/**
 * Platform-neutral pre-routing message gates (rc.114).
 *
 * Extracted from src/platforms/telegram.ts handleMessageInner — these flows
 * are conversation logic, not platform logic. Each gate inspects the incoming
 * message and either handles it (returns true → the platform stops) or lets
 * the pipeline continue. Platforms supply a GateIO adapter so formatting,
 * chunking, and parse-mode fallback stay platform-specific.
 *
 * Behavior contract is pinned by tests/telegram-message-flow.test.ts — any
 * change here must keep that suite green.
 */

import type { PlatformContext } from './context.js';
import { logger } from '../logger.js';

/** Platform reply adapter. Implementations own formatting and chunking. */
export interface GateIO {
  /** Send one formatted reply (platform applies markdown→native formatting). */
  reply(text: string): Promise<void>;
  /** Send a long formatted reply, split into chunks with parse-fallback. */
  replyChunks(text: string): Promise<void>;
  /** Send plain text with no formatting pass. */
  replyPlain(text: string): Promise<void>;
}

export type GatePlatform = 'telegram' | 'matrix';

/**
 * Gate 0 — pending auto-skill proposal.
 * Approve/reject responses are consumed here; any other message expires the
 * proposal and falls through to the normal pipeline.
 */
export async function autoSkillProposalGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  io: GateIO,
): Promise<boolean> {
  const pendingProposal = await pc.autoSkills.getPending(chatId);
  if (!pendingProposal) return false;

  const proposalAction = pc.autoSkills.detectResponse(rawText);
  if (proposalAction) {
    const confirmation = await pc.autoSkills.handleResponse(chatId, proposalAction === 'approve');
    await io.reply(confirmation);
    return true;
  }
  // User sent a normal message — expire the proposal
  pc.autoSkills.expirePending(chatId);
  return false;
}

/**
 * Gate 0a — pending tool confirmation (SA4 policy engine).
 * A confirmation response executes (or blocks) the held tool; the result is
 * routed back through the AI for a natural-language phrasing. Any other
 * message clears the pending confirmation and falls through.
 */
export async function toolConfirmationGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  io: GateIO,
  platform: GatePlatform,
): Promise<boolean> {
  const pendingToolConfirm = pc.policyEngine.getPendingConfirmation(chatId);
  if (!pendingToolConfirm) return false;

  const confirmAction = pc.policyEngine.detectConfirmation(rawText);
  if (confirmAction) {
    const { executeTool } = await import('../providers/tools/index.js');
    const confirmResult = await pc.policyEngine.handleConfirmation(chatId, confirmAction, executeTool);
    if (confirmResult.message) {
      await io.reply(confirmResult.message);
    }
    if (confirmResult.executed && confirmResult.result) {
      // Send the tool result through the AI for a natural response
      const aiResponse = await pc.router.sendMessage({
        chatId,
        message: `Tool "${pendingToolConfirm.toolName}" executed. Result: ${JSON.stringify(confirmResult.result)}`,
        skipTools: true,
        skipTurnLog: true,
        platform,
      });
      if (aiResponse.text) {
        await io.replyChunks(aiResponse.text);
      }
    }
    return true;
  }
  // User sent a normal message — clear pending confirmation
  pc.policyEngine.clearPendingConfirmation(chatId);
  return false;
}

/**
 * Gate 0b — skill self-healing on user correction. Fire-and-continue:
 * never blocks the pipeline.
 */
export async function skillHealingGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  io: GateIO,
): Promise<void> {
  const activeSkillForHealing = await pc.skills.getActive(chatId);
  if (!activeSkillForHealing || !pc.autoSkills.detectCorrection(rawText)) return;
  try {
    const healResult = await pc.autoSkills.heal(
      activeSkillForHealing,
      `User corrected the approach: "${rawText}"`,
      rawText,
      pc.router,
      chatId,
    );
    if (healResult.patched) {
      await io.reply(healResult.summary);
    }
  } catch (err) {
    logger.debug({ err }, 'Skill self-healing skipped (non-blocking)');
  }
}

/**
 * Gate 2a — active learning session. Routes the message through the session
 * system prompt, processes assessment/topic markers, and owns the session
 * lifecycle (end / dismiss / expand). `stopTyping` is invoked at the same
 * points the inline code cleared the platform typing indicator.
 */
export async function learningSessionGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  fullMessage: string,
  io: GateIO,
  stopTyping: () => void,
  platform: GatePlatform,
): Promise<boolean> {
  // Allow non-learning slash commands to pass through (user can /memory, /board, etc.)
  const isNonLearnCommand = rawText.startsWith('/') && !rawText.startsWith('/learn');
  if (!pc.learning.isSessionActive(chatId) || isNonLearnCommand) return false;

  // Check for session-ending keywords
  const lowerText = rawText.toLowerCase().trim();
  if (['done', 'stop', 'enough', '/learn done', '/learn stop'].includes(lowerText)) {
    stopTyping();
    const activeSession = pc.learning.getActiveSession(chatId)!;
    const { durationSeconds, needsExpand } = await pc.learning.endSession(chatId, 'user_ended');
    const summary = pc.learning.formatSessionSummary(durationSeconds, activeSession.questionsAsked, activeSession.correctAnswers);
    await io.reply(summary);

    // Rolling horizon: expand curriculum if needed
    if (needsExpand) {
      const plan = await pc.learning.getPlan(activeSession.planId);
      if (plan) {
        const expandPrompt = await pc.learning.buildExpandPrompt(plan);
        const expandResponse = await pc.router.sendMessage({ chatId, message: expandPrompt, skipAutoTrigger: true, skipTurnLog: true, platform });
        const newTopics = pc.learning.parsePlanResponse(expandResponse.text || '');
        if (newTopics.length > 0) {
          pc.learning.addExpansionTopics(plan.id, newTopics);
          await io.reply(`Added ${newTopics.length} new topics to your **${plan.subject}** plan.`);
        }
      }
    }
    return true;
  }

  if (lowerText === 'snooze' || lowerText === 'later' || lowerText === 'dismiss') {
    stopTyping();
    pc.learning.dismissSession(chatId);
    await io.replyPlain('Session dismissed. We\'ll continue later.');
    return true;
  }

  // Active session: send message through AI with session system prompt
  pc.learning.touchSession(chatId);
  const sessionPrompt = await pc.learning.getSessionSystemPrompt(chatId);
  const response = await pc.router.sendMessage({
    chatId,
    message: fullMessage,
    rawUserMessage: rawText,
    skipAutoTrigger: true,
    systemPrompt: sessionPrompt ?? undefined,
    platform,
  });

  if (response.text) {
    // Process assessment markers
    const result = await pc.learning.processSessionResponse(chatId, response.text);
    const cleanText = pc.learning.stripMarkers(response.text);

    // Handle assessment results
    const activeSession = pc.learning.getActiveSession(chatId);
    if (result.assessmentPassed && activeSession?.assessmentTarget) {
      const plan = await pc.learning.getPlan(activeSession.planId);
      if (plan) {
        pc.learning.completeTopicRemoval(plan.id, activeSession.assessmentTarget);
      }
      await pc.learning.endSession(chatId, 'assessment_passed');
      stopTyping();
      await io.reply(cleanText);
      await io.reply(`**${activeSession.assessmentTarget}** has been deferred from your plan.`);
      return true;
    }

    if (result.assessmentFailed && activeSession?.assessmentTarget) {
      const rejectMsg = pc.learning.rejectTopicRemoval(activeSession.assessmentTarget);
      await pc.learning.endSession(chatId, 'assessment_failed');
      stopTyping();
      await io.reply(cleanText);
      await io.reply(rejectMsg);
      return true;
    }

    // Handle topic completion
    if (result.topicComplete) {
      const session = pc.learning.getActiveSession(chatId);
      if (session) {
        const { durationSeconds, needsExpand } = await pc.learning.endSession(chatId, 'topic_complete');
        const summary = pc.learning.formatSessionSummary(durationSeconds, session.questionsAsked, session.correctAnswers);
        stopTyping();
        await io.reply(cleanText);
        await io.reply(summary);

        if (needsExpand) {
          const plan = await pc.learning.getPlan(session.planId);
          if (plan) {
            const expandPrompt = await pc.learning.buildExpandPrompt(plan);
            const expandResponse = await pc.router.sendMessage({ chatId, message: expandPrompt, skipAutoTrigger: true, skipTurnLog: true, platform });
            const newTopics = pc.learning.parsePlanResponse(expandResponse.text || '');
            if (newTopics.length > 0) {
              pc.learning.addExpansionTopics(plan.id, newTopics);
              await io.reply(`Added ${newTopics.length} new topics to your plan.`);
            }
          }
        }
        return true;
      }
    }

    // Normal session response
    pc.memory.saveConversationTurn(chatId, rawText, cleanText).catch((err) => {
      logger.warn({ err }, 'Failed to save learning session memory');
    });

    await io.replyChunks(cleanText);
  }

  stopTyping();
  return true;
}

/**
 * Gate 2b — multi-step orchestration. Routes orchestration-worthy requests
 * through the orchestrator, then runs auto-skill candidate detection on the
 * completed workflow (skipped for failed runs, rc.70).
 */
export async function orchestrationGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  fullMessage: string,
  io: GateIO,
  stopTyping: () => void,
  opts: { skipTools: boolean; isVoice: boolean },
): Promise<boolean> {
  if (opts.skipTools || opts.isVoice || !pc.orchestrator.shouldOrchestrate(rawText)) return false;

  stopTyping();

  const progressFn = async (_chatId: string, text: string) => {
    await io.reply(text);
  };

  const response = await pc.orchestrator.orchestrateTask(pc.router, chatId, fullMessage, progressFn);

  // Save orchestration as conversation memory
  if (response.text) {
    pc.memory.saveConversationTurn(chatId, rawText, response.text).catch((err) => {
      logger.warn({ err }, 'Failed to save orchestration memory');
    });

    await io.replyChunks(response.text);

    // Auto-skill detection for orchestrated tasks
    // rc.70: skip when the workflow had tool errors or hit max
    // iterations — failed runs must not be offered as skill-worthy.
    if (response.hitMaxIterations || (response.toolErrorCount ?? 0) >= 2) {
      logger.debug(
        { chatId, hitMax: response.hitMaxIterations, toolErrors: response.toolErrorCount },
        'Auto-skill detection skipped (failed workflow)',
      );
    } else try {
      const quality = pc.selfMonitor.checkQuality(response, rawText);
      const candidate = await pc.autoSkills.detectCandidate({
        toolsUsed: response.toolsUsed || [],
        stepResults: undefined, // orchestrator doesn't expose step results here, but toolsUsed is tracked
        qualityScore: quality.passed ? 80 : quality.score ?? 0,
        chatId,
        originalRequest: rawText,
      });
      if (candidate) {
        const proposal = await pc.autoSkills.draftDefinition(candidate, pc.router, chatId);
        if (proposal) {
          pc.autoSkills.insertProposal(proposal);
          const proposalMsg = pc.autoSkills.proposeToUser(proposal);
          await io.reply(proposalMsg);
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Auto-skill detection skipped (non-blocking)');
    }
  }
  return true;
}
