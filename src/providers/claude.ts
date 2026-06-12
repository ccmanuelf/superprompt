import { spawn } from 'node:child_process';
import type { AIProvider, AIResponse, SendMessageParams } from './types.js';
import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { getClaudeTimeoutMs, buildClaudeTimeoutError } from '../circuit-breaker.js';

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
  is_error?: boolean;
  errors?: string[];
  // content events
  content?: string;
  // For assistant message start
  message?: {
    id?: string;
    role?: string;
  };
}

/**
 * Build a subprocess env that cannot cause the Claude CLI to switch auth
 * from our OAuth subscription to pay-per-token API billing. Explicitly
 * strips ANTHROPIC_API_KEY (and related standard names) even if they're
 * set in the parent process — the CLI reads these and, when present,
 * uses them for inference. Our discovery-only key lives under a
 * distinct name (ANTHROPIC_DISCOVERY_API_KEY) the CLI does not know.
 */
function buildClaudeSubprocessEnv(): NodeJS.ProcessEnv {
  const {
    ANTHROPIC_API_KEY: _stripApiKey,
    ANTHROPIC_AUTH_TOKEN: _stripAuthToken,
    ANTHROPIC_DISCOVERY_API_KEY: _stripDiscovery,
    ...safe
  } = process.env;
  return { ...safe, TERM: 'dumb' };
}

/** In-memory cache for the /v1/models discovery response. */
interface ModelListCacheEntry {
  fetchedAt: number;
  models: { id: string; displayName: string }[];
}
const MODEL_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let modelListCache: ModelListCacheEntry | null = null;

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude' as const;

  async sendMessage(params: SendMessageParams): Promise<AIResponse> {
    const { message, sessionId, onTyping, modelOverride } = params;

    const args = [
      '-p',
      message,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (modelOverride) {
      args.push('--model', modelOverride);
    }

    if (params.systemPrompt) {
      args.push('--system-prompt', params.systemPrompt);
    }

    if (params.systemPromptAppend) {
      args.push('--append-system-prompt', params.systemPromptAppend);
    }

    logger.debug({ args: ['claude', ...args].join(' ') }, 'Spawning claude CLI');

    return new Promise<AIResponse>((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd: PROJECT_ROOT,
        env: buildClaudeSubprocessEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let newSessionId: string | undefined;
      let resultText = '';
      let isStaleSession = false;
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      let killed = false;

      // Claude subprocess timeout — prevents indefinite hangs
      const timeoutMs = getClaudeTimeoutMs();
      const timeoutTimer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
        logger.warn({ timeoutMs }, 'Claude subprocess killed (timeout)');
      }, timeoutMs);

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

            // Capture result text (check for errors in result events)
            if (event.type === 'result' && event.result) {
              resultText = event.result;
            }
            if (event.type === 'result' && event.is_error) {
              const errorStr = JSON.stringify({ result: event.result, errors: event.errors });
              logger.warn({ event: errorStr }, 'Claude CLI returned error result');
              // Detect stale session ID errors (message can be in result or errors array)
              if (errorStr.includes('No conversation found with session ID')) {
                isStaleSession = true;
              }
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
        clearTimeout(timeoutTimer);
        if (typingInterval) clearInterval(typingInterval);

        // Handle timeout kill
        if (killed) {
          resolve({
            text: buildClaudeTimeoutError(timeoutMs),
            provider: 'claude',
            newSessionId,
          });
          return;
        }

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
            { code, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) },
            'Claude CLI exited with error',
          );
          resolve({
            text: `Claude CLI error (exit ${code}): ${stderr.slice(0, 200) || 'Unknown error'}`,
            provider: 'claude',
            newSessionId,
            staleSession: isStaleSession,
          });
          return;
        }

        resolve({
          text: resultText || null,
          newSessionId,
          provider: 'claude',
          staleSession: isStaleSession,
        });
      });

      // Close stdin immediately — we pass message via -p flag
      proc.stdin.end();
    });
  }

  /**
   * List Claude models available to the discovery key.
   *
   * IMPORTANT: Uses ANTHROPIC_DISCOVERY_API_KEY — never ANTHROPIC_API_KEY
   * — so the CLI can't pick it up and switch to pay-per-token billing.
   * /v1/models is a metadata endpoint (no token cost). Response is
   * cached for 24h so the endpoint is hit at most once a day regardless
   * of how often /cmodels is invoked.
   *
   * Throws ModelDiscoveryUnavailableError when the key isn't set, so
   * callers can distinguish "discovery not configured" from "network
   * failure" and guide the user accordingly.
   */
  async listModels(): Promise<{ id: string; displayName: string }[]> {
    const now = Date.now();
    if (modelListCache && now - modelListCache.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
      return modelListCache.models;
    }

    const key = process.env.ANTHROPIC_DISCOVERY_API_KEY;
    if (!key) {
      throw new ModelDiscoveryUnavailableError();
    }

    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Anthropic /v1/models returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
    const models = (body.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
    }));

    modelListCache = { fetchedAt: now, models };
    logger.info({ count: models.length }, 'Claude models fetched from /v1/models');
    return models;
  }

  /**
   * Probe-validate a Claude model name before committing a per-chat
   * switch. Spawns a minimal `claude -p --model <name> "ok"` invocation
   * with a short timeout. Returns null on success, or the CLI's error
   * message on failure (e.g. unknown model, invalid alias).
   */
  async validateModel(model: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const proc = spawn(
        'claude',
        ['-p', 'ok', '--model', model, '--dangerously-skip-permissions'],
        {
          cwd: PROJECT_ROOT,
          env: buildClaudeSubprocessEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve('Validation probe timed out after 30s.');
      }, 30_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(null);
        } else {
          const firstLine = stderr.split('\n').find((l) => l.trim()) ?? `exit code ${code}`;
          resolve(firstLine.slice(0, 200));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve(err.message);
      });

      proc.stdin.end();
    });
  }
}

/**
 * Thrown by ClaudeProvider.listModels() when ANTHROPIC_DISCOVERY_API_KEY
 * is not configured. Distinct from network errors so the caller can
 * surface a targeted setup message to the user.
 */
export class ModelDiscoveryUnavailableError extends Error {
  constructor() {
    super('Claude model discovery requires ANTHROPIC_DISCOVERY_API_KEY to be set.');
    this.name = 'ModelDiscoveryUnavailableError';
  }
}
