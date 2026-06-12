import type { Tool } from 'ollama';
import { readEnvFile } from '../../env.js';

/**
 * Render deployment status tools for Ollama.
 *
 * Provides basic deploy monitoring via Render REST API.
 * Claude gets the full Render MCP server; these lightweight tools
 * give Ollama basic deploy visibility without MCP.
 *
 * Requires RENDER_API_KEY in .env.
 */

const RENDER_API = 'https://api.render.com/v1';
const TIMEOUT_MS = 15_000;

function getRenderKey(): string | null {
  // Check process.env first (set by Docker), then readEnvFile (local dev)
  return process.env.RENDER_API_KEY || readEnvFile().RENDER_API_KEY || null;
}

async function renderFetch(path: string): Promise<unknown> {
  const key = getRenderKey();
  if (!key) throw new Error('RENDER_API_KEY not set in .env');

  const response = await fetch(`${RENDER_API}${path}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Render API ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

// ── Tool Definitions ────────────────────────────────────────

export const renderListServicesDefinition: Tool = {
  type: 'function',
  function: {
    name: 'render_list_services',
    description: 'List all services on your Render account. Shows name, type, status, and URL.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max services to return (default 20)',
        },
      },
    },
  },
};

export const renderDeployStatusDefinition: Tool = {
  type: 'function',
  function: {
    name: 'render_deploy_status',
    description: 'Check the latest deployment status of a Render service. Shows if it is building, live, or failed.',
    parameters: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          description: 'The Render service ID (starts with "srv-")',
        },
      },
      required: ['serviceId'],
    },
  },
};

export const renderGetLogsDefinition: Tool = {
  type: 'function',
  function: {
    name: 'render_get_logs',
    description: 'Get recent logs from a Render service deployment.',
    parameters: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          description: 'The Render service ID',
        },
        limit: {
          type: 'number',
          description: 'Number of log lines (default 50)',
        },
      },
      required: ['serviceId'],
    },
  },
};

// ── Tool Implementations ────────────────────────────────────

export async function renderListServices(args: { limit?: number }): Promise<Record<string, unknown>> {
  try {
    const limit = args.limit || 20;
    const data = await renderFetch(`/services?limit=${limit}`) as Array<{
      service: { id: string; name: string; type: string; serviceDetails?: { url?: string } };
    }>;

    const services = data.map((item) => ({
      id: item.service.id,
      name: item.service.name,
      type: item.service.type,
      url: item.service.serviceDetails?.url || 'N/A',
    }));

    return { services };
  } catch (err) {
    return { error: `Failed to list services: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function renderDeployStatus(args: { serviceId: string }): Promise<Record<string, unknown>> {
  try {
    const data = await renderFetch(`/services/${args.serviceId}/deploys?limit=1`) as Array<{
      deploy: { id: string; status: string; commit?: { message?: string }; createdAt: string; finishedAt?: string };
    }>;

    if (!data.length) return { message: 'No deploys found for this service.' };

    const deploy = data[0].deploy;
    return {
      deployId: deploy.id,
      status: deploy.status,
      commitMessage: deploy.commit?.message || 'N/A',
      createdAt: deploy.createdAt,
      finishedAt: deploy.finishedAt || 'in progress',
    };
  } catch (err) {
    return { error: `Failed to get deploy status: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function renderGetLogs(args: { serviceId: string; limit?: number }): Promise<Record<string, unknown>> {
  try {
    const limit = args.limit || 50;
    const data = await renderFetch(`/services/${args.serviceId}/logs?limit=${limit}`) as Array<{
      log: { message: string; timestamp: string; level: string };
    }>;

    const logs = data.map((item) => `[${item.log.timestamp}] ${item.log.level}: ${item.log.message}`);
    return { logs: logs.join('\n') };
  } catch (err) {
    return { error: `Failed to get logs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
