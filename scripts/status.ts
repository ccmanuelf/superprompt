#!/usr/bin/env tsx
/**
 * Health check / status script for Luna.
 *
 * Usage: npx tsx scripts/status.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function pass(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

console.log('\n=== Luna Status Check ===\n');

// 1. Node version
const nodeVersion = process.version;
const major = parseInt(nodeVersion.slice(1));
if (major >= 20) {
  pass(`Node.js ${nodeVersion}`);
} else {
  fail(`Node.js ${nodeVersion} (requires >= 20)`);
}

// 2. Claude CLI
const claudeVersion = tryExec('claude --version');
if (claudeVersion) {
  pass(`Claude CLI: ${claudeVersion}`);
} else {
  fail('Claude CLI not found');
}

// 3. Docker
const dockerVersion = tryExec('docker --version');
if (dockerVersion) {
  pass(`Docker: ${dockerVersion.replace('Docker version ', '').split(',')[0]}`);
} else {
  warn('Docker not found (needed for sandboxing)');
}

// 4. Ollama
const ollamaVersion = tryExec('ollama --version');
if (ollamaVersion) {
  pass(`Ollama: ${ollamaVersion}`);
} else {
  warn('Ollama not found (optional — needed for Ollama provider)');
}

// 5. .env file
const envPath = resolve(PROJECT_ROOT, '.env');
if (existsSync(envPath)) {
  pass('.env file exists');
  const envContent = readFileSync(envPath, 'utf-8');

  // Check key configs
  if (/TELEGRAM_BOT_TOKEN=.+/.test(envContent) && !/your-.*-here/.test(envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1] || '')) {
    pass('Telegram bot token configured');
  } else {
    warn('Telegram bot token not configured');
  }

  if (/ALLOWED_CHAT_ID=\d/.test(envContent)) {
    pass('Allowed chat ID configured');
  } else {
    warn('Allowed chat ID not set (first-run mode — any user can interact)');
  }

  if (/MATRIX_ACCESS_TOKEN=.+/.test(envContent) && !/your-.*-here/.test(envContent.match(/MATRIX_ACCESS_TOKEN=(.+)/)?.[1] || '')) {
    pass('Matrix access token configured');
  } else {
    warn('Matrix not configured (optional)');
  }
} else {
  fail('.env file not found — copy .env.example to .env and configure');
}

// 6. Database
const dbPath = resolve(PROJECT_ROOT, 'store', 'luna.db');
if (existsSync(dbPath)) {
  pass('Database exists');
} else {
  warn('Database not yet created (will be created on first run)');
}

// 7. Built project
const distPath = resolve(PROJECT_ROOT, 'dist', 'index.js');
if (existsSync(distPath)) {
  pass('Project is built (dist/index.js exists)');
} else {
  warn('Project not built — run: npm run build');
}

// 8. Speaches voice service
const speachesHealth = tryExec('curl -sf http://localhost:8000/health 2>/dev/null');
if (speachesHealth !== null) {
  pass('Speaches voice service is running');
} else {
  warn('Speaches not running (voice features unavailable)');
}

// 9. Synapse Matrix server
const synapseHealth = tryExec('curl -sf http://localhost:8008/health 2>/dev/null');
if (synapseHealth !== null) {
  pass('Synapse Matrix server is running');
} else {
  warn('Synapse not running (Matrix features unavailable)');
}

// 10. Background service status
const os = platform();
if (os === 'darwin') {
  const launchdStatus = tryExec('launchctl list com.luna.daemon 2>/dev/null');
  if (launchdStatus) {
    pass('launchd service registered');
  } else {
    warn('launchd service not installed');
  }
} else if (os === 'linux') {
  const systemdStatus = tryExec('systemctl --user is-active luna 2>/dev/null');
  if (systemdStatus === 'active') {
    pass('systemd service is active');
  } else {
    warn('systemd service not running');
  }
}

// 11. PID file check
const pidPath = resolve(PROJECT_ROOT, 'store', 'luna.pid');
if (existsSync(pidPath)) {
  const pid = readFileSync(pidPath, 'utf-8').trim();
  const isRunning = tryExec(`kill -0 ${pid} 2>/dev/null && echo yes`);
  if (isRunning) {
    pass(`Luna is running (PID ${pid})`);
  } else {
    warn(`Stale PID file (PID ${pid} not running)`);
  }
} else {
  warn('Luna is not running (no PID file)');
}

console.log('');
