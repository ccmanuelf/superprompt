import os from 'node:os';
import { execSync } from 'node:child_process';
import type { Tool } from 'ollama';

export const systemInfoDefinition: Tool = {
  type: 'function',
  function: {
    name: 'system_info',
    description:
      'Get basic system information including uptime, memory usage, disk space, and OS details.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

export function systemInfo(): Record<string, string | number> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let diskInfo = 'unavailable';
  try {
    diskInfo = execSync('df -h /', { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    // Ignore — disk info is non-critical
  }

  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
    total_memory_gb: Math.round(totalMem / (1024 ** 3) * 10) / 10,
    free_memory_gb: Math.round(freeMem / (1024 ** 3) * 10) / 10,
    used_memory_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    cpus: os.cpus().length,
    disk: diskInfo,
  };
}
