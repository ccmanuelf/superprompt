#!/usr/bin/env tsx
/**
 * Matrix / Synapse setup helper.
 *
 * Usage:
 *   npx tsx scripts/setup-matrix.ts
 *
 * Steps:
 * 1. Start Synapse container
 * 2. Wait for it to become healthy
 * 3. Register an admin account
 * 4. Register the bot account
 * 5. Get an access token for the bot
 * 6. Print the access token for .env
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYNAPSE_DIR = resolve(__dirname, '..', 'docker', 'synapse');

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: opts?.silent ? 'pipe' : 'inherit',
    }).trim();
  } catch (err) {
    if (opts?.silent) return '';
    throw err;
  }
}

function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

async function waitForHealth(url: string, maxWaitMs: number = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Synapse did not become healthy within ${maxWaitMs / 1000}s`);
}

async function main(): Promise<void> {
  console.log('=== Luna Matrix/Synapse Setup ===\n');

  // 1. Start Synapse
  console.log('1. Starting Synapse container...');
  run(`docker compose -f ${resolve(SYNAPSE_DIR, 'docker-compose.synapse.yml')} up -d`);

  // 2. Wait for health
  console.log('2. Waiting for Synapse to become healthy...');
  await waitForHealth('http://localhost:8008/health');
  console.log('   Synapse is healthy.\n');

  // 3. Register admin
  const adminPassword = generatePassword();
  console.log('3. Registering admin account...');
  try {
    run(
      `docker exec luna-synapse register_new_matrix_user ` +
        `-c /data/homeserver.yaml ` +
        `--admin ` +
        `-u admin -p ${adminPassword}`,
      { silent: true },
    );
    console.log(`   Admin account created. Password: ${adminPassword}`);
  } catch {
    console.log('   Admin account may already exist (skipping).');
  }

  // 4. Register bot
  const botPassword = generatePassword();
  console.log('\n4. Registering bot account (luna-bot)...');
  try {
    run(
      `docker exec luna-synapse register_new_matrix_user ` +
        `-c /data/homeserver.yaml ` +
        `-u luna-bot -p ${botPassword}`,
      { silent: true },
    );
    console.log(`   Bot account created.`);
  } catch {
    console.log('   Bot account may already exist (skipping).');
  }

  // 5. Get access token via login API
  console.log('\n5. Getting bot access token...');
  const loginRes = await fetch('http://localhost:8008/_matrix/client/r0/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      user: 'luna-bot',
      password: botPassword,
    }),
  });

  if (!loginRes.ok) {
    console.error(`   Login failed: ${loginRes.status} ${await loginRes.text()}`);
    console.log('\n   If the bot account already exists, log in manually:');
    console.log('   curl -X POST http://localhost:8008/_matrix/client/r0/login \\');
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"type":"m.login.password","user":"luna-bot","password":"YOUR_PASSWORD"}\'');
    return;
  }

  const loginData = (await loginRes.json()) as { access_token: string; user_id: string };

  console.log(`   Bot user ID: ${loginData.user_id}`);
  console.log(`\n   Add this to your .env file:`);
  console.log(`   MATRIX_HOMESERVER=http://localhost:8008`);
  console.log(`   MATRIX_ACCESS_TOKEN=${loginData.access_token}`);
  console.log(`   MATRIX_ALLOWED_USERS=${loginData.user_id.replace('luna-bot', 'admin')}`);

  console.log('\n=== Setup Complete ===');
  console.log('\nNext steps:');
  console.log('1. Add the above values to your .env file');
  console.log('2. Connect with Element or another Matrix client to http://localhost:8008');
  console.log('3. Log in as admin and create a room');
  console.log('4. Invite @luna-bot:luna.local to the room');
  console.log('5. Start Luna — the bot will auto-join and respond');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
