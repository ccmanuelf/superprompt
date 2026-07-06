import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read .env, then merge Docker override (.env.docker) if present
const baseEnv = readEnvFile();
const dockerOverride = readEnvFile(resolve(__dirname, '..', '.env.docker'));
const env = { ...baseEnv, ...dockerOverride };

/** Absolute path to the project root directory */
export const PROJECT_ROOT = resolve(__dirname, '..');

/** Runtime data directory (SQLite database, bot state) */
export const STORE_DIR = resolve(
  env.STORE_DIR || resolve(PROJECT_ROOT, 'store'),
);

/** Workspace directory for temp files (uploads, media) */
export const WORKSPACE_DIR = resolve(
  env.WORKSPACE_DIR || resolve(PROJECT_ROOT, 'workspace'),
);

/** Uploads directory for downloaded media */
export const UPLOADS_DIR = resolve(WORKSPACE_DIR, 'uploads');

export const config = {
  // Environment
  NODE_ENV: env.NODE_ENV || 'development',
  LOG_LEVEL: env.LOG_LEVEL || 'info',

  // AI Provider
  // rc.95 — local-first defaults. Ollama is the default provider so fresh
  // installs run on the local model unless explicitly opted into Claude;
  // AUTO_ROUTE defaults ON so the existing classifier escalates only the
  // long/complex/document-gen turns to Claude. Set AUTO_ROUTE=false in
  // .env to lock to the default provider unconditionally.
  AI_PROVIDER: (env.AI_PROVIDER || 'ollama') as 'claude' | 'ollama',
  AUTO_ROUTE: env.AUTO_ROUTE !== 'false',
  // Phase 2 pipeline surgery — data-governance pin: when on (default), turns
  // that reason over NovaLink production data stay on the local model
  // regardless of the classifier or Claude-stickiness. Set
  // NOVALINK_PIN_LOCAL=false to disable. Dormant while AUTO_ROUTE=false.
  NOVALINK_PIN_LOCAL: env.NOVALINK_PIN_LOCAL !== 'false',
  // Skill self-healing validation gate: when on (default), the gate adds a
  // Claude LLM-judge signal on top of the in-process self-monitor floor.
  // Set HEAL_GATE_GRADER=false to gate on self-monitor alone (zero LLM cost).
  HEAL_GATE_GRADER: env.HEAL_GATE_GRADER !== 'false',
  // Plan-gate council judge: when on (default), a single cross-family Claude
  // call vets a heal candidate for plausibility BEFORE the expensive replay.
  // Fails open (defers to the delivery gate). Set HEAL_GATE_PLAN_JUDGE=false to
  // gate on the deterministic plan-gate checks alone (zero LLM cost).
  HEAL_GATE_PLAN_JUDGE: env.HEAL_GATE_PLAN_JUDGE !== 'false',

  // Ollama
  OLLAMA_HOST: env.OLLAMA_HOST || 'http://localhost:11434',
  OLLAMA_CHAT_MODEL:
    env.OLLAMA_CHAT_MODEL ||
    'qwen3.5:latest',
  OLLAMA_TOOL_MODEL: env.OLLAMA_TOOL_MODEL || 'qwen3.5:latest',
  OLLAMA_KEEP_ALIVE: env.OLLAMA_KEEP_ALIVE || '3m',
  // Thinking mode for qwen3.5 et al. Hidden reasoning multiplies output
  // tokens 10-100x; on slow GPUs (M1 ~16 tok/s) that is minutes per reply.
  // Set OLLAMA_THINK=false on such hosts to trade depth for latency.
  OLLAMA_THINK: env.OLLAMA_THINK !== 'false',
  // Context window requested per call. The KV allocation scales with this:
  // 32k on qwen3.5:4b ≈ 4.3 GB resident — on a RAM-tight host that lands in
  // swap and turns 5s model loads into minutes. 8192 fits 16 GB comfortably.
  OLLAMA_NUM_CTX: Number(env.OLLAMA_NUM_CTX) || 32768,

  // Telegram
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_WEBHOOK_URL: env.TELEGRAM_WEBHOOK_URL || '', // e.g. https://luna.example.com/telegram/webhook
  TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET || '',
  ALLOWED_CHAT_ID: env.ALLOWED_CHAT_ID || '',

  // Matrix
  MATRIX_HOMESERVER: env.MATRIX_HOMESERVER || '',
  MATRIX_ACCESS_TOKEN: env.MATRIX_ACCESS_TOKEN || '',
  MATRIX_ALLOWED_USERS: env.MATRIX_ALLOWED_USERS || '',

  // Voice (Speaches)
  SPEACHES_URL: env.SPEACHES_URL || 'http://localhost:8000/v1',

  // Ollama Tools
  OLLAMA_ALLOWED_PATHS: env.OLLAMA_ALLOWED_PATHS || '',
  SEARXNG_URL: env.SEARXNG_URL || '',
  BRAVE_API_KEY: env.BRAVE_API_KEY || '',

  // Voice Web (WebRTC browser voice chat — disabled when VOICE_WEB_PORT is 0 or unset)
  VOICE_WEB_PORT: Number(env.VOICE_WEB_PORT) || 0,
  VOICE_WEB_TOKEN: env.VOICE_WEB_TOKEN || '',
  VOICE_WEB_TLS_CERT: env.VOICE_WEB_TLS_CERT || '',
  VOICE_WEB_TLS_KEY: env.VOICE_WEB_TLS_KEY || '',
  VOICE_WEB_ORIGIN: env.VOICE_WEB_ORIGIN || '',  // Allowed Origin for cloud (e.g., https://luna.example.com)

  // Paths
  PROJECT_ROOT,
  STORE_DIR,
  WORKSPACE_DIR,
  UPLOADS_DIR,
} as const;
