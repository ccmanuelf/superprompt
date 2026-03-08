import { logger } from '../logger.js';
import { scanToolCode } from './safety-scanner.js';
import type { ToolParameter } from './tool-parser.js';
import type { ProviderRouter } from '../providers/router.js';

/**
 * AI-generates a TypeScript function body for a tool.
 * Used when a generated_code tool is uploaded without a code body.
 */
export async function generateToolCode(
  name: string,
  description: string,
  parameters: ToolParameter[],
  chatId: string,
  router: ProviderRouter,
): Promise<{ code: string } | { error: string }> {
  const paramDesc = parameters
    .map((p) => `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
    .join('\n');

  const metaPrompt = `You are a code generator. Generate a TypeScript function body for a tool.

Tool name: ${name}
Description: ${description}
Parameters:
${paramDesc}

The code will run inside an async function with these variables available:
- \`args\`: Record<string, unknown> containing the parameter values
- \`fetch\`: the global fetch function for HTTP requests

Rules:
- Return a JSON-serializable object as the result
- Use \`return { result: ... }\` or \`return { key: value }\`
- You can use fetch() for external HTTP calls
- You CANNOT use: eval, exec, spawn, require, import(), process, fs, child_process
- Keep the code simple and focused

Respond with ONLY the function body code. No function wrapper, no markdown, no explanation. Just the raw code that goes inside the async function.`;

  try {
    const response = await router.sendMessage({
      chatId,
      message: metaPrompt,
      skipTools: true,
    });

    if (!response.text) {
      return { error: 'AI returned empty response' };
    }

    // Strip any markdown code block wrapping
    let code = response.text.trim();
    const codeBlockMatch = code.match(/```(?:typescript|ts|javascript|js)?\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1].trim();
    }

    // Safety check
    const scan = scanToolCode(code);
    if (!scan.safe) {
      return { error: `Generated code failed safety check:\n${scan.issues.join('\n')}` };
    }

    logger.info({ tool: name }, 'Tool code generated via AI');
    return { code };
  } catch (err) {
    logger.error({ err, tool: name }, 'Tool code generation failed');
    return { error: `Code generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
