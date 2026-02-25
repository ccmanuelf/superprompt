import { spawn } from 'node:child_process';
import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { config, PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';

/**
 * Stream-json event types emitted by `claude --output-format stream-json`.
 * We only parse the ones we need.
 */
interface StreamJsonEvent {
  type: string;
  session_id?: string;
  subtype?: string;
  // result events
  result?: string;
  // content events
  content?: string;
  // For assistant message start
  message?: {
    id?: string;
    role?: string;
  };
}

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude' as const;

  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { message, sessionId, onTyping } = params;

    const args = [
      '-p',
      message,
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (params.systemPrompt) {
      args.push('--system-prompt', params.systemPrompt);
    }

    logger.debug({ args: ['claude', ...args].join(' ') }, 'Spawning claude CLI');

    return new Promise<AIResponse>((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          // Ensure Claude CLI doesn't prompt for input
          TERM: 'dumb',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let newSessionId: string | undefined;
      let resultText = '';
      let typingInterval: ReturnType<typeof setInterval> | undefined;

      // Refresh typing indicator every 4s
      if (onTyping) {
        onTyping();
        typingInterval = setInterval(() => onTyping(), 4000);
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();

        // Parse line-delimited JSON events
        const lines = stdout.split('\n');
        // Keep the last incomplete line in the buffer
        stdout = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed) as StreamJsonEvent;

            // Capture session ID from init or message_start events
            if (event.session_id && !newSessionId) {
              newSessionId = event.session_id;
            }

            // Capture result text
            if (event.type === 'result' && event.result) {
              resultText = event.result;
            }

            // Capture content blocks (streaming text)
            if (event.type === 'content' && event.content) {
              resultText += event.content;
            }

            // Some stream formats use assistant message with text subtype
            if (
              event.type === 'assistant' &&
              event.subtype === 'text' &&
              event.content
            ) {
              resultText += event.content;
            }
          } catch {
            // Not valid JSON — could be partial line, ignore
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        if (typingInterval) clearInterval(typingInterval);
        logger.error({ err }, 'Failed to spawn claude CLI');
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (typingInterval) clearInterval(typingInterval);

        // Process any remaining stdout
        if (stdout.trim()) {
          try {
            const event = JSON.parse(stdout.trim()) as StreamJsonEvent;
            if (event.session_id && !newSessionId) {
              newSessionId = event.session_id;
            }
            if (event.type === 'result' && event.result) {
              resultText = event.result;
            }
          } catch {
            // Ignore
          }
        }

        if (code !== 0 && !resultText) {
          logger.error(
            { code, stderr: stderr.slice(0, 500) },
            'Claude CLI exited with error',
          );
          resolve({
            text: `Claude CLI error (exit ${code}): ${stderr.slice(0, 200) || 'Unknown error'}`,
            provider: 'claude',
            newSessionId,
          });
          return;
        }

        resolve({
          text: resultText || null,
          newSessionId,
          provider: 'claude',
        });
      });

      // Close stdin immediately — we pass message via -p flag
      proc.stdin.end();
    });
  }
}
