import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { config, PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { VoiceSession } from './voice-session.js';
import { validateWebToken, logTokenAudit } from './web-tokens.js';
import { listAllCards, createCard, moveCard, assignCard, updateCard, deleteCard, parseDateHint, type CardStatus, type CardAssignee } from '../kanban.js';
import {
  getAllPlans, getPlansByChat, getPlan, getTopic, getTopicsByPlan, getAllWeeklyTime, getAllRecentSessions,
  getRecentSessionsByChat, getWeeklyTime,
  calculateStreak, getMasterySummary, getEffectiveMastery, countDueReviews,
  reorderTopic, updatePlan, getSessionsByPlan, getDailyTime,
  type PlanStatus,
} from '../learning/index.js';
import type { ProviderRouter } from '../providers/router.js';
import { handleSimApi } from './sim-api.js';
import { handleCapacityApi } from './capacity-api.js';
import { handleSequencerApi } from './sequencer-api.js';
import { handleVsmApi } from './vsm-api.js';
import { handleTocApi } from './toc-api.js';
import { handleConwipApi } from './conwip-api.js';
import { handleDoeApi } from './doe-api.js';
import { handleFsmApi } from './fsm-api.js';

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

// ── Per-user token session tracking (for immediate revocation) ──
const activeTokenSessions = new Map<string, Set<WebSocket>>();

function trackTokenSession(tokenId: string, ws: WebSocket): void {
  let sockets = activeTokenSessions.get(tokenId);
  if (!sockets) {
    sockets = new Set();
    activeTokenSessions.set(tokenId, sockets);
  }
  sockets.add(ws);
  ws.on('close', () => {
    sockets!.delete(ws);
    if (sockets!.size === 0) activeTokenSessions.delete(tokenId);
  });
}

/** Disconnect all WebSocket sessions using a specific token (called on revocation). */
export function disconnectTokenSessions(tokenId: string): void {
  const sockets = activeTokenSessions.get(tokenId);
  if (sockets) {
    for (const ws of sockets) {
      ws.close(4002, 'Token revoked');
    }
    activeTokenSessions.delete(tokenId);
  }
}

// ── API Authentication ─────────────────────────────────────

/** CORS headers for authenticated API responses */
function apiCorsHeaders(): Record<string, string> {
  const origin = config.VOICE_WEB_ORIGIN || 'http://localhost:' + config.VOICE_WEB_PORT;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/**
 * Authenticate HTTP API requests.
 * Returns the authenticated chatId (for per-user data scoping) or null if unauthenticated.
 * Handles CORS preflight (OPTIONS) — returns null and ends the response.
 */
function authenticateApiRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): string | null {
  const cors = apiCorsHeaders();

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return null; // Handled, but not authenticated — caller should return
  }

  // Set CORS headers on all responses
  for (const [k, v] of Object.entries(cors)) {
    res.setHeader(k, v);
  }

  // Extract token from header or query parameter
  let candidateToken: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    candidateToken = authHeader.slice(7);
  }
  if (!candidateToken) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    candidateToken = url.searchParams.get('token');
  }

  if (!candidateToken) {
    const ip = req.socket.remoteAddress || 'unknown';
    recordAuthFailure(ip);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized — provide token via Authorization: Bearer <token> header or ?token=<token> query parameter' }));
    return null;
  }

  // Try per-user token first — returns scoped chatId
  const perUserResult = validateWebToken(candidateToken);
  if (perUserResult.valid && perUserResult.chatId) {
    return perUserResult.chatId;
  }

  // Fall back to legacy VOICE_WEB_TOKEN — scoped to first ALLOWED_CHAT_ID
  if (config.VOICE_WEB_TOKEN && candidateToken.length === config.VOICE_WEB_TOKEN.length && validateToken(candidateToken, config.VOICE_WEB_TOKEN)) {
    return config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || 'legacy';
  }

  // Unauthorized
  const ip = req.socket.remoteAddress || 'unknown';
  recordAuthFailure(ip);
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized — invalid token' }));
  return null;
}

// ── Docs API ───────────────────────────────────────────────

const DOCS_DIR = resolve(PROJECT_ROOT, 'docs');
const DOCS_FILES: Record<string, string> = {
  'user-guide': 'user-guide.md',
  'deployment-runbook': 'deployment-runbook.md',
  'commands': 'commands.md',
  'customization-guide': 'customization-guide.md',
  'architecture': 'architecture.md',
  'deployment-guide': 'deployment-guide.md',
  'security': 'security.md',
};

function handleDocsApi(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  urlPath: string,
): void {
  res.setHeader('Content-Type', 'application/json');

  // /api/docs — list available docs
  if (urlPath === '/api/docs' || urlPath === '/api/docs/') {
    const docs = Object.entries(DOCS_FILES).map(([key, file]) => ({
      id: key,
      file,
      exists: existsSync(resolve(DOCS_DIR, file)),
    }));
    res.writeHead(200);
    res.end(JSON.stringify({ docs }));
    return;
  }

  // /api/docs/<id> — get markdown content
  const docId = urlPath.replace('/api/docs/', '').replace(/\/$/, '');
  const docFile = DOCS_FILES[docId];
  if (!docFile) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Document not found' }));
    return;
  }

  const docPath = resolve(DOCS_DIR, docFile);
  if (!existsSync(docPath)) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Document file not found' }));
    return;
  }

  const content = readFileSync(docPath, 'utf-8');
  res.writeHead(200);
  res.end(JSON.stringify({ id: docId, file: docFile, content }));
}

/**
 * Start the voice web server (HTTP + WebSocket).
 * Only called when VOICE_WEB_PORT is set.
 */
export function startVoiceWebServer(router: ProviderRouter): { close: () => void } {
  const port = config.VOICE_WEB_PORT;
  const token = config.VOICE_WEB_TOKEN;

  if (!token) {
    logger.info('VOICE_WEB_TOKEN is not set — per-user tokens (/webtoken) will be used for auth');
  }

  // Create HTTP or HTTPS server
  let server: HttpServer;
  if (config.VOICE_WEB_TLS_CERT && config.VOICE_WEB_TLS_KEY) {
    if (!existsSync(config.VOICE_WEB_TLS_CERT)) {
      logger.error({ path: config.VOICE_WEB_TLS_CERT }, 'VOICE_WEB_TLS_CERT file not found — web server disabled. Check the path in .env');
      return { close: () => {} };
    }
    if (!existsSync(config.VOICE_WEB_TLS_KEY)) {
      logger.error({ path: config.VOICE_WEB_TLS_KEY }, 'VOICE_WEB_TLS_KEY file not found — web server disabled. Check the path in .env');
      return { close: () => {} };
    }
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
      // Docs API is public read-only — no auth
      if (urlPath.startsWith('/api/docs')) {
        handleDocsApi(req, res, urlPath);
        return;
      }

      // Authenticate all other API requests — returns chatId for data scoping
      const apiChatId = authenticateApiRequest(req, res);
      if (!apiChatId) return;

      const apiError = (label: string) => (err: unknown) => {
        logger.error({ err }, `${label} API unhandled error`);
        res.writeHead(500);
        res.end('Internal Server Error');
      };

      if (urlPath.startsWith('/api/capacity')) {
        handleCapacityApi(req, res, urlPath, apiChatId).catch(apiError('Capacity'));
      } else if (urlPath.startsWith('/api/sequence')) {
        handleSequencerApi(req, res, urlPath, apiChatId).catch(apiError('Sequencer'));
      } else if (urlPath.startsWith('/api/vsm')) {
        handleVsmApi(req, res, urlPath, apiChatId).catch(apiError('VSM'));
      } else if (urlPath.startsWith('/api/toc')) {
        handleTocApi(req, res, urlPath, apiChatId).catch(apiError('TOC'));
      } else if (urlPath.startsWith('/api/conwip')) {
        handleConwipApi(req, res, urlPath, apiChatId).catch(apiError('CONWIP'));
      } else if (urlPath.startsWith('/api/doe')) {
        handleDoeApi(req, res, urlPath, apiChatId).catch(apiError('DOE'));
      } else if (urlPath.startsWith('/api/fsm')) {
        handleFsmApi(req, res, urlPath, apiChatId).catch(apiError('FSM'));
      } else {
        handleSimApi(req, res, urlPath, apiChatId).catch(apiError('Sim'));
      }
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
    } else if (urlPath === '/capacity' || urlPath === '/capacity/') {
      filePath = resolve(PUBLIC_DIR, 'capacity', 'index.html');
    } else if (urlPath === '/sequence' || urlPath === '/sequence/') {
      filePath = resolve(PUBLIC_DIR, 'sequencer', 'index.html');
    } else if (urlPath === '/vsm' || urlPath === '/vsm/') {
      filePath = resolve(PUBLIC_DIR, 'vsm', 'index.html');
    } else if (urlPath === '/toc' || urlPath === '/toc/') {
      filePath = resolve(PUBLIC_DIR, 'toc', 'index.html');
    } else if (urlPath === '/conwip' || urlPath === '/conwip/') {
      filePath = resolve(PUBLIC_DIR, 'conwip', 'index.html');
    } else if (urlPath === '/doe' || urlPath === '/doe/') {
      filePath = resolve(PUBLIC_DIR, 'doe', 'index.html');
    } else if (urlPath === '/fsm' || urlPath === '/fsm/') {
      filePath = resolve(PUBLIC_DIR, 'fsm', 'index.html');
    } else if (urlPath === '/hub' || urlPath === '/hub/') {
      filePath = resolve(PUBLIC_DIR, 'hub', 'index.html');
    } else if (urlPath === '/hub/bom' || urlPath === '/hub/bom/') {
      filePath = resolve(PUBLIC_DIR, 'hub', 'bom.html');
    } else if (urlPath === '/docs' || urlPath === '/docs/') {
      filePath = resolve(PUBLIC_DIR, 'docs', 'index.html');
    } else if (urlPath === '/board' || urlPath === '/board/') {
      filePath = resolve(PUBLIC_DIR, 'board.html');
    } else if (urlPath === '/learn' || urlPath === '/learn/') {
      filePath = resolve(PUBLIC_DIR, 'learn.html');
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
    const headers = urlPath.startsWith('/sim') || filePath.includes('simulation') || urlPath.startsWith('/capacity') || filePath.includes('capacity') || urlPath.startsWith('/sequence') || filePath.includes('sequencer') || urlPath.startsWith('/vsm') || filePath.includes('vsm') || urlPath.startsWith('/toc') || filePath.includes('/toc/') || urlPath.startsWith('/conwip') || filePath.includes('conwip') || urlPath.startsWith('/doe') || filePath.includes('/doe/') || urlPath.startsWith('/fsm') || filePath.includes('/fsm/') || urlPath.startsWith('/docs') || filePath.includes('/docs/')
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

        // Try per-user token first, then fall back to legacy VOICE_WEB_TOKEN
        let authChatId: string | null = null;
        let tokenId: string | null = null;
        const perUserResult = validateWebToken(msg.token);
        if (perUserResult.valid && perUserResult.chatId) {
          authChatId = perUserResult.chatId;
          tokenId = msg.token;
          logTokenAudit(perUserResult.chatId, 'auth_success', perUserResult.tokenPrefix, ip);
        } else if (token && validateToken(msg.token, token)) {
          // Legacy shared token — no per-user scoping. Falls back to first
          // ALLOWED_CHAT_ID so all legacy users share the same data view.
          // For per-user isolation, users should create per-user tokens via /webtoken.
          authChatId = config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || null;
          logger.info({ ip, authChatId }, 'Web: legacy VOICE_WEB_TOKEN auth (shared data view)');
        } else {
          recordAuthFailure(ip);
          if (perUserResult.tokenPrefix) {
            logTokenAudit('unknown', 'auth_failure', perUserResult.tokenPrefix, ip);
          }
          logger.warn({ ip }, 'Web: invalid token');
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close(4001, 'Unauthorized');
          return;
        }

        // Auth passed
        authenticated = true;
        mode = msg.mode || 'voice';
        clearTimeout(authTimer);

        // Track per-user token session for immediate revocation
        if (tokenId) {
          trackTokenSession(tokenId, ws);
        }

        // Remove this one-shot auth handler
        ws.removeListener('message', authHandler);

        // Route to the appropriate mode handler — pass chat_id for data scoping
        if (mode === 'board') {
          setupBoardHandler(ws, authChatId, tokenId);
        } else if (mode === 'learn') {
          setupLearnHandler(ws, authChatId, tokenId);
        } else {
          setupVoiceHandler(ws, router, authChatId);
        }

        // Signal ready
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid auth message' }));
        ws.close(4001, 'Bad auth');
      }
    });
  });

  // ── Token re-validation (checks token still valid every 60s) ──
  function createTokenRevalidator(ws: WebSocket, tokenId: string | null): () => boolean {
    if (!tokenId) return () => true; // Legacy tokens don't expire
    let lastCheck = Date.now();
    const RECHECK_INTERVAL = 60_000; // 60 seconds
    return () => {
      const now = Date.now();
      if (now - lastCheck < RECHECK_INTERVAL) return true;
      lastCheck = now;
      const result = validateWebToken(tokenId);
      if (!result.valid) {
        ws.send(JSON.stringify({ type: 'error', message: 'Token expired or revoked' }));
        ws.close(4002, 'Token expired');
        return false;
      }
      return true;
    };
  }

  // ── Board Mode Handler ──
  function setupBoardHandler(ws: WebSocket, authChatId?: string | null, tokenId?: string | null): void {
    const boardChatId = authChatId || config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || 'web-board';
    const isTokenValid = createTokenRevalidator(ws, tokenId || null);
    logger.info('Board web: client connected');

    ws.on('message', (data: Buffer | string) => {
      if (!isTokenValid()) return; // Re-validate token periodically
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
  function setupLearnHandler(ws: WebSocket, authChatId?: string | null, tokenId?: string | null): void {
    const learnChatId = authChatId || config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || null;
    const isTokenValid = createTokenRevalidator(ws, tokenId || null);
    logger.info({ chatId: learnChatId }, 'Learn web: client connected');

    ws.on('message', (data: Buffer | string) => {
      if (!isTokenValid()) return; // Re-validate token periodically
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        switch (msg.type) {
          case 'learn_list_plans': {
            // Scope plans to authenticated user; fall back to all plans if no chatId
            const plans = learnChatId ? getPlansByChat(learnChatId) : getAllPlans();
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
            // Ownership check — prevent accessing other users' plans
            if (learnChatId && plan.chat_id !== learnChatId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }));
              break;
            }
            const topics = getTopicsByPlan(plan.id).map((t) => ({
              ...t,
              effectiveMastery: getEffectiveMastery(t),
            }));
            ws.send(JSON.stringify({ type: 'learn_plan_detail', plan, topics }));
            break;
          }
          case 'learn_time': {
            const todayStr = new Date().toISOString().slice(0, 10);
            const week = learnChatId ? getWeeklyTime(learnChatId) : getAllWeeklyTime(7);
            const todayData = week.find((d) => d.date === todayStr);
            const todaySeconds = todayData?.total_seconds ?? 0;
            const todaySessions = todayData?.session_count ?? 0;
            const streak = calculateStreak(learnChatId || undefined);
            ws.send(JSON.stringify({
              type: 'learn_time_data',
              today: { seconds: todaySeconds, sessions: todaySessions, goalMet: todaySeconds >= 600 },
              week,
              streak,
            }));
            break;
          }
          case 'learn_sessions': {
            let sessions;
            if (msg.planId) {
              // Ownership check — verify plan belongs to user
              const sessionPlan = getPlan(msg.planId);
              if (learnChatId && (!sessionPlan || sessionPlan.chat_id !== learnChatId)) {
                ws.send(JSON.stringify({ type: 'learn_session_history', sessions: [] }));
                break;
              }
              sessions = getSessionsByPlan(msg.planId, msg.limit ?? 20);
            } else {
              sessions = learnChatId ? getRecentSessionsByChat(learnChatId, msg.limit ?? 20) : getAllRecentSessions(msg.limit ?? 20);
            }
            ws.send(JSON.stringify({ type: 'learn_session_history', sessions }));
            break;
          }
          case 'learn_reorder': {
            // Ownership check before mutation — verify topic belongs to user's plan
            if (learnChatId) {
              const topicToReorder = getTopic(msg.topicId);
              if (topicToReorder) {
                const ownerPlan = getPlan(topicToReorder.plan_id);
                if (ownerPlan && ownerPlan.chat_id !== learnChatId) {
                  ws.send(JSON.stringify({ type: 'error', message: 'Reorder failed' }));
                  break;
                }
              }
            }
            const success = reorderTopic(msg.topicId, msg.newPosition);
            if (!success) { ws.send(JSON.stringify({ type: 'error', message: 'Reorder failed' })); break; }
            // Scope to user's plans only
            const reorderPlans = learnChatId ? getPlansByChat(learnChatId) : getAllPlans();
            for (const p of reorderPlans) {
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
            // Ownership check before modification
            const planToUpdate = getPlan(msg.planId);
            if (!planToUpdate || (learnChatId && planToUpdate.chat_id !== learnChatId)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }));
              break;
            }
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
  function setupVoiceHandler(ws: WebSocket, voiceRouter: ProviderRouter, authChatId?: string | null): void {
    const sessionChatId = authChatId || `voice-web-${randomUUID()}`;
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
