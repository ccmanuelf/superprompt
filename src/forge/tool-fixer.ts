import { getUserTool, getToolRevisions, updateUserTool, insertToolRevision, type UserTool } from '../db.js';
import { logger, getRecentLogs } from '../logger.js';
import { scanToolCode } from './safety-scanner.js';
import { loadUserTools } from './tool-registry.js';
import type { ProviderRouter } from '../providers/router.js';

/**
 * AI-assisted tool fixer.
 * Reads current config, user feedback, and recent logs to rewrite tool configuration.
 */
export async function fixTool(
  toolId: string,
  userFeedback: string,
  chatId: string,
  router: ProviderRouter,
): Promise<{ summary: string } | { error: string }> {
  const tool = getUserTool(toolId);
  if (!tool) return { error: 'Tool not found' };
  if (tool.locked) return { error: 'Tool is locked. Unlock it first.' };

  // Get recent revisions
  const revisions = getToolRevisions(toolId, 3);
  const revisionContext = revisions.length > 0
    ? `\n\nPrevious revisions (most recent first):\n${revisions.map((r, i) => `${i + 1}. [${r.revision_note || 'no note'}] ${r.config.slice(0, 200)}...`).join('\n')}`
    : '';

  // Get recent error logs
  let logContext = '';
  try {
    const logs = getRecentLogs(30, 'warn');
    if (logs.length > 0) {
      logContext = `\n\nRecent bot logs (warnings/errors):\n${logs.map((l) => `[${l.level}] ${l.msg}`).join('\n')}`;
    }
  } catch {
    // Graceful degradation
  }

  const currentConfig = JSON.parse(tool.config);

  let metaPrompt: string;
  if (tool.tool_type === 'declarative_http') {
    metaPrompt = `You are a tool configuration engineer. Fix this HTTP tool based on user feedback.

Tool: "${tool.name}"
Description: ${tool.description}
Type: declarative_http

Current endpoint config:
${JSON.stringify(currentConfig.endpoint, null, 2)}

Parameters:
${JSON.stringify(currentConfig.parameters, null, 2)}
${revisionContext}${logContext}

User feedback: "${userFeedback}"

Respond with ONLY a valid JSON object containing the fixed endpoint configuration. Example:
{"method": "GET", "url": "...", "query": {...}, "response_path": "..."}

No explanations, just the JSON.`;
  } else {
    metaPrompt = `You are a tool code engineer. Fix this code tool based on user feedback.

Tool: "${tool.name}"
Description: ${tool.description}
Type: generated_code

Current code:
${currentConfig.code || '(no code)'}

Parameters:
${JSON.stringify(currentConfig.parameters, null, 2)}
${revisionContext}${logContext}

User feedback: "${userFeedback}"

Respond with ONLY the fixed function body code. No markdown, no explanations, no function wrapper. Just the raw code.
The code runs in an async function with \`args\` and \`fetch\` available.`;
  }

  try {
    const response = await router.sendMessage({
      chatId,
      message: metaPrompt,
      skipTools: true,
    });

    if (!response.text) {
      return { error: 'AI returned empty response' };
    }

    const newConfigObj = { ...currentConfig };

    if (tool.tool_type === 'declarative_http') {
      // Parse the JSON response
      let endpointJson = response.text.trim();
      // Strip markdown code block if present
      const jsonMatch = endpointJson.match(/```(?:json)?\n?([\s\S]*?)```/);
      if (jsonMatch) endpointJson = jsonMatch[1].trim();

      try {
        const newEndpoint = JSON.parse(endpointJson);
        newConfigObj.endpoint = newEndpoint;
      } catch {
        return { error: 'AI returned invalid JSON for endpoint config' };
      }
    } else {
      // generated_code: extract code
      let code = response.text.trim();
      const codeBlockMatch = code.match(/```(?:typescript|ts|javascript|js)?\n?([\s\S]*?)```/);
      if (codeBlockMatch) code = codeBlockMatch[1].trim();

      // Safety check
      const scan = scanToolCode(code);
      if (!scan.safe) {
        return { error: `Fixed code failed safety check:\n${scan.issues.join('\n')}` };
      }

      newConfigObj.code = code;
    }

    const newConfig = JSON.stringify(newConfigObj);
    updateUserTool(toolId, { config: newConfig });
    insertToolRevision(toolId, newConfig, `Fix: ${userFeedback.slice(0, 100)}`);
    loadUserTools(); // Reload in registry

    logger.info({ toolId, toolName: tool.name }, 'Tool fixed via AI');

    return {
      summary: `Tool "${tool.name}" fixed. Configuration updated based on your feedback.`,
    };
  } catch (err) {
    logger.error({ err, toolId }, 'Tool fix failed');
    return { error: `AI fix failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
