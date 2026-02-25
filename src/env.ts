import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse a .env file into a key-value map.
 * NEVER sets process.env — returns a plain object instead.
 *
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - # comments and blank lines
 * - Inline comments: KEY=value # comment
 */
export function readEnvFile(
  envPath?: string,
): Record<string, string> {
  const filePath = envPath ?? resolve(__dirname, '..', '.env');

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }

  const env: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
    }

    if (key) {
      env[key] = value;
    }
  }

  return env;
}
