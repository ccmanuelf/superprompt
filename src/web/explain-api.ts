/**
 * /api/explain — most-recent calculation lineage view (Phase 4).
 *
 * Returns the ephemeral CalculationResult stashed by the calculation
 * handlers (only stashed in site_adjusted mode). Per locked spec-owner
 * decisions: Web-UI-only, ephemeral, in-memory, no persistence.
 *
 * Endpoints:
 *   GET    /api/explain     → { hasResult, ... full envelope }
 *   DELETE /api/explain     → clear the stashed result for this chatId
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  getRecentResult,
  clearRecentResult,
} from '../calculations/recent-results.js';

export async function handleExplainApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/explain')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (req.method === 'GET') {
      const entry = getRecentResult(chatId);
      if (!entry) {
        jsonResponse(res, 200, { hasResult: false });
        return true;
      }
      jsonResponse(res, 200, {
        hasResult: true,
        metricName: entry.metricName,
        label: entry.label,
        recordedAt: entry.recordedAt,
        mode: entry.result.mode,
        computedAt: entry.result.computedAt,
        inputsUsed: entry.result.inputsUsed,
        assumptionsApplied: entry.result.assumptionsApplied,
        value: entry.result.value,
      });
      return true;
    }

    if (req.method === 'DELETE') {
      const ok = clearRecentResult(chatId);
      jsonResponse(res, 200, { cleared: ok });
      return true;
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Explain API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}
