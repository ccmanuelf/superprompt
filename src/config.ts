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
  AI_PROVIDER: (env.AI_PROVIDER || 'claude') as 'claude' | 'ollama',

  // Ollama
  OLLAMA_HOST: env.OLLAMA_HOST || 'http://localhost:11434',
  OLLAMA_CHAT_MODEL:
    env.OLLAMA_CHAT_MODEL ||
    'qwen3.5:latest',
  OLLAMA_TOOL_MODEL: env.OLLAMA_TOOL_MODEL || 'qwen3.5:latest',

  // Telegram
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
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

  // Paths
  PROJECT_ROOT,
  STORE_DIR,
  WORKSPACE_DIR,
  UPLOADS_DIR,
} as const;
