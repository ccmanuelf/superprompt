import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { VoiceSession } from './voice-session.js';
import { listAllCards, createCard, moveCard, assignCard, updateCard, deleteCard, parseDateHint, type CardStatus, type CardAssignee } from '../kanban.js';
import {
  getAllPlans, getPlan, getTopicsByPlan, getAllWeeklyTime, getAllRecentSessions,
  calculateStreak, getMasterySummary, getEffectiveMastery, countDueReviews,
  reorderTopic, updatePlan, getSessionsByPlan, getDailyTime,
  type PlanStatus,
} from '../learning/index.js';
import type { ProviderRouter } from '../providers/router.js';
import { handleSimApi } from './sim-api.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// In dev: src/web/ → src/web/public/
// In prod (Docker): dist/web/ → dist/web/public/
const PUBLIC_DIR = resolve(__dirname, 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Security ────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;",
  'Permissions-Policy': 'microphone=(self)',
};

// Rate limiter for failed auth attempts (per IP)
const AUTH_FAIL_WINDOW_MS = 60_000; // 1 minute window
const AUTH_FAIL_MAX = 5;            // max failures per window
const authFailures = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    return true; // No recent failures or window expired
  }
  return entry.count < AUTH_FAIL_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function validateToken(clientToken: string, serverToken: string): boolean {
  if (clientToken.length !== serverToken.length) return false;
  return timingSafeEqual(Buffer.from(clientToken), Buffer.from(serverToken));
}

/** Validate Origin header for WebSocket connections (cloud-ready CSWSH protection). */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Browser omits Origin for same-origin; allow
  try {
    const url = new URL(origin);
    // Allow localhost/127.0.0.1 (any port) for local dev
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    // In cloud: allow the configured host (if VOICE_WEB_ORIGIN is set)
    if (config.VOICE_WEB_ORIGIN && origin === config.VOICE_WEB_ORIGIN) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Start the voice web server (HTTP + WebSocket).
 * Only called when VOICE_WEB_PORT is set.
 */
export function startVoiceWebServer(router: ProviderRouter): { close: () => void } {
  const port = config.VOICE_WEB_PORT;
  const token = config.VOICE_WEB_TOKEN;

  if (!token) {
    logger.warn('VOICE_WEB_TOKEN is not set — voice web server requires a token for auth');
    return { close: () => {} };
  }

  // Create HTTP or HTTPS server
  let server: HttpServer;
  if (config.VOICE_WEB_TLS_CERT && config.VOICE_WEB_TLS_KEY) {
    const cert = readFileSync(config.VOICE_WEB_TLS_CERT);
    const key = readFileSync(config.VOICE_WEB_TLS_KEY);
    server = createHttpsServer({ cert, key }, handleRequest);
    logger.info('Voice web server using TLS');
  } else {
    server = createHttpServer(handleRequest);
  }

  // Serve static files and API routes with security headers
  function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    const urlPath = req.url?.split('?')[0] || '/';

    // ── API routes (handle before static files) ──
    if (urlPath.startsWith('/api/')) {
      handleSimApi(req, res, urlPath).catch((err) => {
        logger.error({ err }, 'Sim API unhandled error');
        res.writeHead(500);
        res.end('Internal Server Error');
      });
      return;
    }

    // ── Static file serving ──
    let filePath: string;
    if (urlPath === '/') {
      filePath = resolve(PUBLIC_DIR, 'index.html');
    } else if (urlPath === '/sim' || urlPath === '/sim/') {
      filePath = resolve(PUBLIC_DIR, 'simulation', 'index.html');
    } else if (urlPath === '/sim/guide' || urlPath === '/sim/guide/') {
      filePath = resolve(PUBLIC_DIR, 'simulation', 'guide.html');
    } else {
      filePath = resolve(PUBLIC_DIR, urlPath.slice(1));
    }

    // Only serve files from public directory
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Relax CSP for simulation page (needs CDN scripts for Vue, Vuetify, AG Grid)
    const headers = urlPath.startsWith('/sim') || filePath.includes('simulation')
      ? { ...SECURITY_HEADERS, 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; font-src https://cdn.jsdelivr.net https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:;" }
      : SECURITY_HEADERS;

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, ...headers });
      res.end(content);
    } catch {
      res.writeHead(500, SECURITY_HEADERS);
      res.end('Internal Server Error');
    }
  }

  // WebSocket server — uses first-message auth (token never in URL)
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress || 'unknown';

    // ── Origin validation (CSWSH protection, cloud-ready) ──
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      logger.warn({ ip, origin }, 'Web: rejected connection from disallowed origin');
      ws.close(4003, 'Origin not allowed');
      return;
    }

    // ── Rate limit check ──
    if (!checkRateLimit(ip)) {
      logger.warn({ ip }, 'Web: rate limited');
      ws.close(4029, 'Too many failed attempts');
      return;
    }

    // ── First-message auth: client must send { type: 'auth', token, mode } ──
    let authenticated = false;
    let mode: string | null = null;
    const AUTH_TIMEOUT_MS = 10_000;

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    // Helper to parse message data (Buffer or string)
    function parseMessage(data: Buffer | string): string | null {
      if (typeof data === 'string') return data;
      if (Buffer.isBuffer(data)) return data.toString('utf-8');
      return null;
    }

    ws.on('message', function authHandler(data: Buffer | string) {
      const text = parseMessage(data);
      if (!text) return;

      try {
        const msg = JSON.parse(text);
        if (msg.type !== 'auth' || !msg.token) {
          ws.send(JSON.stringify({ type: 'error', message: 'First message must be: { type: "auth", token: "...", mode: "board|learn|voice" }' }));
          ws.close(4001, 'Auth required');
          return;
        }

        if (!validateToken(msg.token, token)) {
          recordAuthFailure(ip);
          logger.warn({ ip }, 'Web: invalid token');
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close(4001, 'Unauthorized');
          return;
        }

        // Auth passed
        authenticated = true;
        mode = msg.mode || 'voice';
        clearTimeout(authTimer);

        // Remove this one-shot auth handler
        ws.removeListener('message', authHandler);

        // Route to the appropriate mode handler
        if (mode === 'board') {
          setupBoardHandler(ws);
        } else if (mode === 'learn') {
          setupLearnHandler(ws);
        } else {
          setupVoiceHandler(ws, router);
        }

        // Signal ready
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid auth message' }));
        ws.close(4001, 'Bad auth');
      }
    });
  });

  // ── Board Mode Handler ──
  function setupBoardHandler(ws: WebSocket): void {
    const boardChatId = config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || 'web-board';
    logger.info('Board web: client connected');

    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        switch (msg.type) {
          case 'board_list': {
            const cards = listAllCards(boardChatId);
            ws.send(JSON.stringify({ type: 'board_data', cards }));
            break;
          }
          case 'board_create': {
            const dueDate = msg.due_date ? parseDateHint(msg.due_date) : undefined;
            const scheduledFor = msg.scheduled_for ? parseDateHint(msg.scheduled_for) : undefined;
            const card = createCard(boardChatId, msg.title, {
              description: msg.description,
              assignee: msg.assignee as CardAssignee,
              priority: msg.priority,
              dueDate: dueDate ?? undefined,
              scheduledFor: scheduledFor ?? undefined,
              source: 'user',
            });
            ws.send(JSON.stringify({ type: 'card_created', card }));
            ws.send(JSON.stringify({ type: 'board_data', cards: listAllCards(boardChatId) }));
            break;
          }
          case 'board_move': {
            const moved = moveCard(msg.cardId, msg.status as CardStatus, boardChatId);
            if (!moved) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found or invalid status' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: listAllCards(boardChatId) }));
            break;
          }
          case 'board_assign': {
            const assigned = assignCard(msg.cardId, msg.assignee as CardAssignee, boardChatId);
            if (!assigned) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found or invalid assignee' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: listAllCards(boardChatId) }));
            break;
          }
          case 'board_update': {
            const updates: Record<string, unknown> = {};
            if (msg.priority !== undefined) updates.priority = msg.priority;
            if ('due_date' in msg) updates.due_date = msg.due_date ? parseDateHint(msg.due_date) : null;
            if ('scheduled_for' in msg) updates.scheduled_for = msg.scheduled_for ? parseDateHint(msg.scheduled_for) : null;
            const updatedCard = updateCard(msg.cardId, updates, boardChatId);
            if (!updatedCard) { ws.send(JSON.stringify({ type: 'error', message: 'Update failed' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: listAllCards(boardChatId) }));
            break;
          }
          case 'board_delete': {
            const deleted = deleteCard(msg.cardId, boardChatId);
            if (!deleted) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found' })); break; }
            ws.send(JSON.stringify({ type: 'card_deleted' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: listAllCards(boardChatId) }));
            break;
          }
          case 'ping': {
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Board web: message error');
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.on('close', () => { logger.info('Board web: client disconnected'); });
  }

  // ── Learn Mode Handler ──
  function setupLearnHandler(ws: WebSocket): void {
    logger.info('Learn web: client connected');

    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        switch (msg.type) {
          case 'learn_list_plans': {
            const plans = getAllPlans();
            const enriched = plans.map((p) => {
              const topics = getTopicsByPlan(p.id);
              const summary = getMasterySummary(topics);
              const sessions = getSessionsByPlan(p.id, 1);
              return {
                ...p,
                completedCount: summary.completedCount,
                totalCount: summary.totalCount,
                avgMastery: summary.avgMastery,
                dueReviews: summary.dueReviews,
                lastSessionAt: sessions[0]?.started_at ?? null,
              };
            });
            ws.send(JSON.stringify({ type: 'learn_plans', plans: enriched }));
            break;
          }
          case 'learn_get_plan': {
            const plan = getPlan(msg.planId);
            if (!plan) { ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' })); break; }
            const topics = getTopicsByPlan(plan.id).map((t) => ({
              ...t,
              effectiveMastery: getEffectiveMastery(t),
            }));
            ws.send(JSON.stringify({ type: 'learn_plan_detail', plan, topics }));
            break;
          }
          case 'learn_time': {
            const todayStr = new Date().toISOString().slice(0, 10);
            const week = getAllWeeklyTime(7);
            const todayData = week.find((d) => d.date === todayStr);
            const todaySeconds = todayData?.total_seconds ?? 0;
            const todaySessions = todayData?.session_count ?? 0;
            const streak = calculateStreak();
            ws.send(JSON.stringify({
              type: 'learn_time_data',
              today: { seconds: todaySeconds, sessions: todaySessions, goalMet: todaySeconds >= 600 },
              week,
              streak,
            }));
            break;
          }
          case 'learn_sessions': {
            const sessions = msg.planId
              ? getSessionsByPlan(msg.planId, msg.limit ?? 20)
              : getAllRecentSessions(msg.limit ?? 20);
            ws.send(JSON.stringify({ type: 'learn_session_history', sessions }));
            break;
          }
          case 'learn_reorder': {
            const success = reorderTopic(msg.topicId, msg.newPosition);
            if (!success) { ws.send(JSON.stringify({ type: 'error', message: 'Reorder failed' })); break; }
            const plans = getAllPlans();
            for (const p of plans) {
              const topics = getTopicsByPlan(p.id);
              if (topics.some((t) => t.id === msg.topicId)) {
                const enrichedTopics = topics.map((t) => ({ ...t, effectiveMastery: getEffectiveMastery(t) }));
                ws.send(JSON.stringify({ type: 'learn_plan_detail', plan: p, topics: enrichedTopics }));
                break;
              }
            }
            break;
          }
          case 'learn_update_plan': {
            const updates: Partial<{ persona: string; status: PlanStatus }> = {};
            if (msg.persona) updates.persona = msg.persona;
            if (msg.status) updates.status = msg.status as PlanStatus;
            const updated = updatePlan(msg.planId, updates);
            if (!updated) { ws.send(JSON.stringify({ type: 'error', message: 'Update failed' })); break; }
            const topics = getTopicsByPlan(updated.id).map((t) => ({ ...t, effectiveMastery: getEffectiveMastery(t) }));
            ws.send(JSON.stringify({ type: 'learn_plan_detail', plan: updated, topics }));
            break;
          }
          case 'ping': {
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Learn web: message error');
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.on('close', () => { logger.info('Learn web: client disconnected'); });
  }

  // ── Voice Mode Handler ──
  function setupVoiceHandler(ws: WebSocket, voiceRouter: ProviderRouter): void {
    const sessionChatId = `voice-web-${randomUUID()}`;
    logger.info({ chatId: sessionChatId }, 'Voice web: client connected');

    const session = new VoiceSession(sessionChatId, voiceRouter);

    ws.on('message', async (data: Buffer | string) => {
      // Binary = audio data, string = JSON control message
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // Ignore malformed JSON
        }
        return;
      }

      try {
        ws.send(JSON.stringify({ type: 'status', status: 'processing' }));

        const result = await session.processAudio(Buffer.from(data));

        ws.send(JSON.stringify({
          type: 'response',
          transcript: result.transcript,
          text: result.text,
          provider: result.provider,
        }));

        if (result.audio) {
          ws.send(result.audio);
        }

        ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
      } catch (err) {
        logger.error({ err, chatId: sessionChatId }, 'Voice web: processing error');
        ws.send(JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : 'Processing failed',
        }));
        ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
      }
    });

    ws.on('close', () => {
      logger.info({ chatId: sessionChatId }, 'Voice web: client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err, chatId: sessionChatId }, 'Voice web: WebSocket error');
    });
  }

  server.listen(port, () => {
    const protocol = config.VOICE_WEB_TLS_CERT ? 'https' : 'http';
    logger.info({ port, protocol }, 'Voice web server started');
  });

  return {
    close: () => {
      wss.close();
      server.close();
    },
  };
}
