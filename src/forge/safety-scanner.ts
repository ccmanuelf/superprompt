/**
 * Safety scanner for user-generated tool code.
 * Checks for dangerous patterns that could harm the system.
 */

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /process\.exit/g, reason: 'process.exit() is not allowed' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/g, reason: 'child_process is not allowed' },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/g, reason: 'fs module is not allowed' },
  { pattern: /require\s*\(\s*['"]net['"]\s*\)/g, reason: 'net module is not allowed' },
  { pattern: /require\s*\(\s*['"]dgram['"]\s*\)/g, reason: 'dgram module is not allowed' },
  { pattern: /require\s*\(\s*['"]cluster['"]\s*\)/g, reason: 'cluster module is not allowed' },
  { pattern: /import\s*\(\s*['"]fs['"]\s*\)/g, reason: 'dynamic fs import is not allowed' },
  { pattern: /import\s*\(\s*['"]child_process['"]\s*\)/g, reason: 'dynamic child_process import is not allowed' },
  { pattern: /import\s*\(\s*['"]node:/g, reason: 'dynamic node: imports are not allowed' },
  { pattern: /\bexec\s*\(/g, reason: 'exec() is not allowed' },
  { pattern: /\bexecSync\s*\(/g, reason: 'execSync() is not allowed' },
  { pattern: /\bspawn\s*\(/g, reason: 'spawn() is not allowed' },
  { pattern: /\bspawnSync\s*\(/g, reason: 'spawnSync() is not allowed' },
  { pattern: /\beval\s*\(/g, reason: 'eval() is not allowed' },
  { pattern: /new\s+Function\s*\(/g, reason: 'new Function() is not allowed' },
  { pattern: /process\.env/g, reason: 'process.env access is not allowed' },
  { pattern: /process\.kill/g, reason: 'process.kill() is not allowed' },
  { pattern: /\bwriteFile/g, reason: 'file writes are not allowed' },
  { pattern: /\bunlink\b/g, reason: 'file deletion is not allowed' },
  { pattern: /\brmSync\b/g, reason: 'rmSync is not allowed' },
  { pattern: /\brmdirSync\b/g, reason: 'rmdirSync is not allowed' },
  { pattern: /globalThis/g, reason: 'globalThis access is not allowed' },
  { pattern: /Deno\./g, reason: 'Deno APIs are not allowed' },
  { pattern: /Bun\./g, reason: 'Bun APIs are not allowed' },
];

// Regex to detect fetch calls to internal/private IPs
const INTERNAL_IP_PATTERN = /fetch\s*\([^)]*(?:localhost|127\.0\.0\.|10\.\d|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/gi;

export interface ScanResult {
  safe: boolean;
  issues: string[];
}

/**
 * Scan tool code for dangerous patterns.
 * Returns { safe: true } if no issues found.
 */
export function scanToolCode(code: string): ScanResult {
  const issues: string[] = [];

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(code)) {
      issues.push(reason);
    }
  }

  // Check for internal IP access
  INTERNAL_IP_PATTERN.lastIndex = 0;
  if (INTERNAL_IP_PATTERN.test(code)) {
    issues.push('fetch() to internal/private IPs is not allowed');
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}
