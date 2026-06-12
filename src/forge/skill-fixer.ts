import { getSkill, getSkillRevisions, updateSkill, insertSkillRevision } from '../db-core.js';
import { logger } from '../logger.js';
import type { ProviderRouter } from '../providers/router.js';

/**
 * AI-assisted skill prompt rewriter.
 * Takes user feedback about what's wrong with a skill and rewrites the system prompt.
 */
export async function fixSkill(
  skillId: string,
  userFeedback: string,
  chatId: string,
  router: ProviderRouter,
): Promise<{ newPrompt: string; summary: string } | { error: string }> {
  const skill = await getSkill(skillId);
  if (!skill) return { error: 'Skill not found' };
  if (skill.locked) return { error: 'Skill is locked. Unlock it first.' };

  // Get recent revisions for context
  const revisions = await getSkillRevisions(skillId, 3);
  const revisionContext = revisions.length > 0
    ? `\n\nPrevious revisions (most recent first):\n${revisions.map((r, i) => `${i + 1}. [${r.revision_note || 'no note'}] ${r.system_prompt.slice(0, 200)}...`).join('\n')}`
    : '';

  // Try to get recent bot logs for diagnostics (available after Phase 5)
  let logContext = '';
  try {
    // Dynamic import to avoid hard dependency on log ring buffer
    const loggerModule = await import('../logger.js') as Record<string, unknown>;
    if (typeof loggerModule.getRecentLogs === 'function') {
      const logs = (loggerModule.getRecentLogs as (count: number, level?: string) => Array<{ level: string; msg: string }>)(30, 'warn');
      if (logs.length > 0) {
        logContext = `\n\nRecent bot logs (warnings/errors):\n${logs.map((l: { level: string; msg: string }) => `[${l.level}] ${l.msg}`).join('\n')}`;
      }
    }
  } catch {
    // Log ring buffer not yet available, graceful degradation
  }

  const metaPrompt = `You are a system prompt engineer. Your job is to rewrite AI system prompts based on user feedback.

Current skill: "${skill.name}"
Description: ${skill.description}

Current system prompt:
---
${skill.system_prompt}
---
${revisionContext}${logContext}

User feedback: "${userFeedback}"

Instructions:
1. Analyze the current prompt and the user's feedback
2. Rewrite the system prompt to address the feedback
3. Keep the core purpose of the skill intact
4. Make the prompt clear and effective

Respond with ONLY the new system prompt text. No explanations, no markdown formatting, no quotes around it. Just the raw prompt text.`;

  try {
    const response = await router.sendMessage({
      chatId,
      message: metaPrompt,
      skipTools: true,
    });

    if (!response.text) {
      return { error: 'AI returned empty response' };
    }

    const newPrompt = response.text.trim();

    // Update the skill
    await updateSkill(skillId, { systemPrompt: newPrompt });
    await insertSkillRevision(skillId, newPrompt, `Fix: ${userFeedback.slice(0, 100)}`);

    logger.info({ skillId, skillName: skill.name }, 'Skill prompt rewritten via AI fix');

    return {
      newPrompt,
      summary: `Skill "${skill.name}" prompt rewritten based on your feedback.`,
    };
  } catch (err) {
    logger.error({ err, skillId }, 'Skill fix failed');
    return { error: `AI fix failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
