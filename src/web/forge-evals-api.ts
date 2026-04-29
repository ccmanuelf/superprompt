/**
 * /api/forge/evals — JSON endpoints for the eval viewer (rc.98 Phase 1).
 *
 * Auth: relies on the same per-user webtoken layer the rest of the
 * /api/* surface uses. The dispatcher resolves `apiChatId` upstream and
 * passes it in; we use it for chat_id scoping (you only see eval
 * sessions you triggered).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  getEvalSession,
  listEvalSessions,
  listEvalRuns,
  listAssertionsForRun,
  computeSessionPassRate,
} from '../forge/eval/index.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Dispatch /api/forge/evals/* routes.
 *
 * - `GET /api/forge/evals` → list sessions for this chat_id (newest first)
 * - `GET /api/forge/evals/:id` → session detail with runs + assertions
 */
export async function handleForgeEvalsApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  apiChatId: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // Strip prefix; path either empty or /<id>
  const tail = urlPath.replace(/^\/api\/forge\/evals/, '').replace(/\/$/, '');

  if (tail === '' || tail === '/') {
    const sessions = await listEvalSessions(apiChatId, 50);
    sendJson(res, 200, { sessions });
    return;
  }

  // /:id
  const idMatch = tail.match(/^\/(\d+)$/);
  if (!idMatch) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const id = Number(idMatch[1]);
  const session = await getEvalSession(id);
  if (!session) {
    sendJson(res, 404, { error: 'eval session not found' });
    return;
  }

  // Per-chat scoping: a user only sees their own evals.
  if (session.chat_id !== apiChatId) {
    logger.warn(
      { apiChatId, session_chat_id: session.chat_id, session_id: id },
      'forge eval cross-chat access denied',
    );
    sendJson(res, 404, { error: 'eval session not found' });   // 404, not 403, to avoid leaking existence
    return;
  }

  const runs = await listEvalRuns(id);
  // Fetch assertions per run. For Phase 1 sessions are bounded so no
  // pagination needed (default cap = 40 calls = at most 20 runs per session).
  const assertionsByRun = new Map<number, Awaited<ReturnType<typeof listAssertionsForRun>>>();
  for (const r of runs) {
    assertionsByRun.set(r.id, await listAssertionsForRun(r.id));
  }
  const passRates = await computeSessionPassRate(id);

  sendJson(res, 200, {
    session,
    runs: runs.map((r) => ({
      ...r,
      assertions: assertionsByRun.get(r.id) ?? [],
    })),
    pass_rates: passRates,
    prompts: JSON.parse(session.prompts_json) as string[],
    expectations: JSON.parse(session.expectations_json) as string[],
  });
}
