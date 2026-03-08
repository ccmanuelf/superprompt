import { logger } from '../logger.js';
import type { DeclarativeHttpEndpoint } from './tool-parser.js';

const HTTP_TIMEOUT_MS = 30_000;

/**
 * Execute a declarative HTTP tool configuration.
 * Substitutes ${paramName} placeholders with actual args,
 * and ${ENV_VAR} with values from the environment config.
 */
export async function executeDeclarativeHttp(
  endpoint: DeclarativeHttpEndpoint,
  args: Record<string, unknown>,
  envVars?: Record<string, string>,
): Promise<Record<string, unknown>> {
  try {
    // Substitute placeholders in URL
    let url = substituteVars(endpoint.url, args, envVars);

    // Build query string
    if (endpoint.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(endpoint.query)) {
        params.set(key, substituteVars(value, args, envVars));
      }
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${params.toString()}`;
    }

    // Build headers
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (endpoint.headers) {
      for (const [key, value] of Object.entries(endpoint.headers)) {
        headers[key] = substituteVars(value, args, envVars);
      }
    }

    // Build body
    let body: string | undefined;
    if (endpoint.body) {
      if (typeof endpoint.body === 'string') {
        body = substituteVars(endpoint.body, args, envVars);
      } else {
        const bodyObj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(endpoint.body)) {
          if (typeof value === 'string') {
            bodyObj[key] = substituteVars(value, args, envVars);
          } else {
            bodyObj[key] = value;
          }
        }
        body = JSON.stringify(bodyObj);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
    }

    logger.debug({ url, method: endpoint.method }, 'Declarative HTTP request');

    const response = await fetch(url, {
      method: endpoint.method,
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        error: `HTTP ${response.status}: ${response.statusText}`,
        body: text.slice(0, 500),
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let data: unknown;

    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = { text: await response.text() };
    }

    // Extract using response_path if specified
    if (endpoint.response_path && typeof data === 'object' && data !== null) {
      const extracted = extractPath(data as Record<string, unknown>, endpoint.response_path);
      return { result: extracted };
    }

    return typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : { result: data };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { error: 'Request timed out (30s)' };
    }
    return {
      error: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Substitute ${varName} placeholders in a string with values from args or env.
 * Args take precedence over env vars.
 */
function substituteVars(
  template: string,
  args: Record<string, unknown>,
  envVars?: Record<string, string>,
): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    // Check args first (parameter values)
    if (varName in args) {
      return String(args[varName]);
    }
    // Then check env vars (API keys etc.)
    if (envVars && varName in envVars) {
      return envVars[varName];
    }
    // Leave as-is if not found
    return `\${${varName}}`;
  });
}

/**
 * Extract a value from a nested object using dot-notation path.
 * E.g., "current.condition.text" extracts obj.current.condition.text
 */
function extractPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
