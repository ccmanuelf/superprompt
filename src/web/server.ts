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
  calculateStreak, getMasterySummary, getEffectiveMastery,
  reorderTopic, updatePlan, getSessionsByPlan,
  type PlanStatus,
} from '../learning/index.js';
import type { ProviderRouter } from '../providers/router.js';
import { handleSimApi } from './sim-api.js';
import { handleCapacityApi } from './capacity-api.js';
import { handleAttendanceApi, cleanupStaleUploads as cleanupAttendanceUploads } from './attendance-api.js';
import { handleSequencerApi } from './sequencer-api.js';
import { handleVsmApi } from './vsm-api.js';
import { handleTocApi } from './toc-api.js';
import { handleConwipApi } from './conwip-api.js';
import { handleDoeApi } from './doe-api.js';
import { handleFsmApi } from './fsm-api.js';
import { handleAssumptionsApi } from './assumptions-api.js';
import { handleExplainApi } from './explain-api.js';

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
  // media-src 'self' blob: is required for TTS playback — the client receives
  // mp3 bytes over WS, wraps them in a Blob, and plays via URL.createObjectURL
  // which produces a blob: URL. Without it the <audio> element is blocked
  // silently (only visible in DevTools console) and every voice reply degrades
  // to text-only.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:;",
  'Permissions-Policy': 'microphone=(self)',
};

/**
 * Pages that load Vue / Vuetify / AG Grid / charting libs from
 * cdn.jsdelivr.net or unpkg. Without the relaxed CSP they fail with
 * "Vue is not defined" plus CSP-violation console errors and the page
 * is non-functional. Maintained as a list (not a `||` chain) so adding
 * a new dashboard or doc UI is a single append — `/explain` and `/hub`
 * shipped broken from rc.100 because they were missed in the previous
 * inline-conditional form (rc.110 regression fix).
 *
 * The matcher tests both `urlPath` (the request path) and `filePath`
 * (the on-disk path) because static-file resolution sometimes maps a
 * shorter URL like `/sequence` to `src/web/public/sequencer/...`.
 */
const RELAXED_CSP_URL_PREFIXES: readonly string[] = [
  '/sim', '/capacity', '/sequence', '/vsm', '/toc', '/conwip',
  '/doe', '/fsm', '/docs', '/explain', '/hub',
];
const RELAXED_CSP_FILEPATH_NEEDLES: readonly string[] = [
  'simulation', 'capacity', 'sequencer', 'vsm', '/toc/', 'conwip',
  '/doe/', '/fsm/', '/docs/', '/explain/', '/hub/',
];

const RELAXED_CSP_HEADER = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; font-src https://cdn.jsdelivr.net https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:;";

export function pageNeedsRelaxedCsp(urlPath: string, filePath: string): boolean {
  return RELAXED_CSP_URL_PREFIXES.some((p) => urlPath.startsWith(p))
    || RELAXED_CSP_FILEPATH_NEEDLES.some((n) => filePath.includes(n));
}

// Rate limiter for failed auth attempts (per IP)
// Two tiers: short window (3 failures/min) + hourly ban (15 failures/hour)
const AUTH_FAIL_WINDOW_MS = 60_000;      // 1 minute window
const AUTH_FAIL_MAX = 3;                  // max failures per minute (tightened from 5)
const AUTH_BAN_WINDOW_MS = 3_600_000;    // 1 hour ban window
const AUTH_BAN_THRESHOLD = 15;            // failures in 1 hour triggers IP ban
const authFailures = new Map<string, { count: number; resetAt: number }>();
const authBans = new Map<string, { totalCount: number; windowResetAt: number; bannedUntil: number }>();

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();

  // Check hourly ban first
  const ban = authBans.get(ip);
  if (ban && now < ban.bannedUntil) {
    logger.warn({ ip, bannedUntil: new Date(ban.bannedUntil).toISOString() }, 'Web: IP banned (too many auth failures)');
    return false;
  }

  // Check per-minute limit
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    return true;
  }
  return entry.count < AUTH_FAIL_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();

  // Per-minute tracking
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }

  // Hourly ban tracking. rc.113: the counting window is tracked separately
  // from bannedUntil — the old check (`now > ban.bannedUntil` with a 0 seed)
  // reset the counter on every failure, so the ban could never trigger.
  const ban = authBans.get(ip);
  if (!ban || now > ban.windowResetAt) {
    authBans.set(ip, {
      totalCount: 1,
      windowResetAt: now + AUTH_BAN_WINDOW_MS,
      bannedUntil: ban && now < ban.bannedUntil ? ban.bannedUntil : 0,
    });
  } else {
    ban.totalCount++;
    if (ban.totalCount >= AUTH_BAN_THRESHOLD) {
      ban.bannedUntil = now + AUTH_BAN_WINDOW_MS;
      logger.warn({ ip, totalFailures: ban.totalCount }, 'Web: IP banned for 1 hour (exceeded 15 auth failures)');
    }
  }
}

function validateToken(clientToken: string, serverToken: string): boolean {
  if (clientToken.length !== serverToken.length) return false;
  return timingSafeEqual(Buffer.from(clientToken), Buffer.from(serverToken));
}

/** Validate Origin header for WebSocket connections (cloud-ready CSWSH protection). */
export function isOriginAllowed(origin: string | undefined): boolean {
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
export async function authenticateApiRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<string | null> {
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
  const perUserResult = await validateWebToken(candidateToken);
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

// ── Webhook handler registry ──────────────────────────────
// Allows external modules (e.g. Telegram) to register POST handlers
// for specific paths, processed before API auth.
type WebhookHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
const webhookHandlers = new Map<string, WebhookHandler>();

/**
 * Register a webhook handler for a specific URL path.
 * Used by Telegram webhook mode to receive updates from Telegram servers.
 */
export function registerWebhookHandler(path: string, handler: WebhookHandler): void {
  webhookHandlers.set(path, handler);
  logger.info({ path }, 'Webhook handler registered');
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
  async function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const urlPath = req.url?.split('?')[0] || '/';

    // ── Webhook handlers (e.g. Telegram webhook — no auth, verified by secret) ──
    const webhookHandler = webhookHandlers.get(urlPath);
    if (webhookHandler && req.method === 'POST') {
      await webhookHandler(req, res);
      return;
    }

    // ── API routes (handle before static files) ──
    if (urlPath.startsWith('/api/')) {
      // Health endpoint — public, unauth, used by monitors and load balancers.
      // Must precede the auth gate; returns 204 with no body.
      if (urlPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(204);
        res.end();
        return;
      }

      // Docs API is public read-only — no auth
      if (urlPath.startsWith('/api/docs')) {
        handleDocsApi(req, res, urlPath);
        return;
      }

      // Authenticate all other API requests — returns chatId for data scoping
      const apiChatId = await authenticateApiRequest(req, res);
      if (!apiChatId) return;

      const apiError = (label: string) => (err: unknown) => {
        logger.error({ err }, `${label} API unhandled error`);
        res.writeHead(500);
        res.end('Internal Server Error');
      };

      if (urlPath.startsWith('/api/attendance')) {
        handleAttendanceApi(req, res, urlPath, apiChatId).catch(apiError('Attendance'));
      } else if (urlPath.startsWith('/api/forge/evals')) {
        // rc.98 — Phase 1 of skill-creator-v2 integration (Apache-2.0).
        // Eval viewer backend; per-chat scoping enforced inside the handler.
        import('./forge-evals-api.js')
          .then(({ handleForgeEvalsApi }) =>
            handleForgeEvalsApi(req, res, urlPath, apiChatId).catch(apiError('ForgeEvals')),
          )
          .catch(apiError('ForgeEvals'));
      } else if (urlPath.startsWith('/api/capacity')) {
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
      } else if (urlPath.startsWith('/api/assumptions')) {
        handleAssumptionsApi(req, res, urlPath, apiChatId).catch(apiError('Assumptions'));
      } else if (urlPath.startsWith('/api/explain')) {
        handleExplainApi(req, res, urlPath, apiChatId).catch(apiError('Explain'));
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
    } else if (urlPath === '/docs/assumptions' || urlPath === '/docs/assumptions/') {
      filePath = resolve(PUBLIC_DIR, 'docs', 'assumptions.html');
    } else if (urlPath === '/explain' || urlPath === '/explain/') {
      filePath = resolve(PUBLIC_DIR, 'explain', 'index.html');
    } else if (urlPath === '/board' || urlPath === '/board/') {
      filePath = resolve(PUBLIC_DIR, 'board.html');
    } else if (urlPath === '/learn' || urlPath === '/learn/') {
      filePath = resolve(PUBLIC_DIR, 'learn.html');
    } else if (urlPath === '/attendance' || urlPath === '/attendance/' || urlPath === '/attendance/admin' || urlPath === '/attendance/admin/') {
      filePath = resolve(PUBLIC_DIR, 'attendance', 'admin.html');
    } else if (urlPath === '/forge/evals' || urlPath === '/forge/evals/') {
      // rc.98 — Phase 1 of skill-creator-v2 integration. Eval viewer.
      filePath = resolve(PUBLIC_DIR, 'forge', 'evals.html');
    } else if (urlPath === '/favicon.ico') {
      // No favicon; answer 204 so the browser stops logging a 404 every load.
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
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

    // Relax CSP for pages that load Vue / Vuetify / AG Grid from CDN.
    // See pageNeedsRelaxedCsp() / RELAXED_CSP_URL_PREFIXES above.
    const headers = pageNeedsRelaxedCsp(urlPath, filePath)
      ? { ...SECURITY_HEADERS, 'Content-Security-Policy': RELAXED_CSP_HEADER }
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

    ws.on('message', async function authHandler(data: Buffer | string) {
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
        const perUserResult = await validateWebToken(msg.token);
        if (perUserResult.valid && perUserResult.chatId) {
          authChatId = perUserResult.chatId;
          tokenId = msg.token;
          await logTokenAudit(perUserResult.chatId, 'auth_success', perUserResult.tokenPrefix, ip);
        } else if (token && validateToken(msg.token, token)) {
          // Legacy shared token — no per-user scoping. Falls back to first
          // ALLOWED_CHAT_ID so all legacy users share the same data view.
          // For per-user isolation, users should create per-user tokens via /webtoken.
          authChatId = config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || null;
          logger.info({ ip, authChatId }, 'Web: legacy VOICE_WEB_TOKEN auth (shared data view)');
        } else {
          recordAuthFailure(ip);
          if (perUserResult.tokenPrefix) {
            await logTokenAudit('unknown', 'auth_failure', perUserResult.tokenPrefix, ip);
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
  function createTokenRevalidator(ws: WebSocket, tokenId: string | null): () => Promise<boolean> {
    if (!tokenId) return async () => true; // Legacy tokens don't expire
    let lastCheck = Date.now();
    const RECHECK_INTERVAL = 60_000; // 60 seconds
    return async () => {
      const now = Date.now();
      if (now - lastCheck < RECHECK_INTERVAL) return true;
      lastCheck = now;
      const result = await validateWebToken(tokenId);
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

    ws.on('message', async (data: Buffer | string) => {
      if (!(await isTokenValid())) return; // Re-validate token periodically
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        switch (msg.type) {
          case 'board_list': {
            const cards = await listAllCards(boardChatId);
            ws.send(JSON.stringify({ type: 'board_data', cards }));
            break;
          }
          case 'board_create': {
            const dueDate = msg.due_date ? parseDateHint(msg.due_date) : undefined;
            const scheduledFor = msg.scheduled_for ? parseDateHint(msg.scheduled_for) : undefined;
            const card = await createCard(boardChatId, msg.title, {
              description: msg.description,
              assignee: msg.assignee as CardAssignee,
              priority: msg.priority,
              dueDate: dueDate ?? undefined,
              scheduledFor: scheduledFor ?? undefined,
              source: 'user',
            });
            ws.send(JSON.stringify({ type: 'card_created', card }));
            ws.send(JSON.stringify({ type: 'board_data', cards: await listAllCards(boardChatId) }));
            break;
          }
          case 'board_move': {
            const moved = await moveCard(msg.cardId, msg.status as CardStatus, boardChatId);
            if (!moved) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found or invalid status' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: await listAllCards(boardChatId) }));
            break;
          }
          case 'board_assign': {
            const assigned = await assignCard(msg.cardId, msg.assignee as CardAssignee, boardChatId);
            if (!assigned) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found or invalid assignee' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: await listAllCards(boardChatId) }));
            break;
          }
          case 'board_update': {
            const updates: Record<string, unknown> = {};
            if (msg.priority !== undefined) updates.priority = msg.priority;
            if ('due_date' in msg) updates.due_date = msg.due_date ? parseDateHint(msg.due_date) : null;
            if ('scheduled_for' in msg) updates.scheduled_for = msg.scheduled_for ? parseDateHint(msg.scheduled_for) : null;
            const updatedCard = await updateCard(msg.cardId, updates, boardChatId);
            if (!updatedCard) { ws.send(JSON.stringify({ type: 'error', message: 'Update failed' })); break; }
            ws.send(JSON.stringify({ type: 'card_updated' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: await listAllCards(boardChatId) }));
            break;
          }
          case 'board_delete': {
            const deleted = await deleteCard(msg.cardId, boardChatId);
            if (!deleted) { ws.send(JSON.stringify({ type: 'error', message: 'Card not found' })); break; }
            ws.send(JSON.stringify({ type: 'card_deleted' }));
            ws.send(JSON.stringify({ type: 'board_data', cards: await listAllCards(boardChatId) }));
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

    ws.on('message', async (data: Buffer | string) => {
      if (!(await isTokenValid())) return; // Re-validate token periodically
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        switch (msg.type) {
          case 'learn_list_plans': {
            // Scope plans to authenticated user; fall back to all plans if no chatId
            const plans = learnChatId ? await getPlansByChat(learnChatId) : await getAllPlans();
            const enriched = await Promise.all(plans.map(async (p) => {
              const topics = await getTopicsByPlan(p.id);
              const summary = getMasterySummary(topics);
              const sessions = await getSessionsByPlan(p.id, 1);
              return {
                ...p,
                completedCount: summary.completedCount,
                totalCount: summary.totalCount,
                avgMastery: summary.avgMastery,
                dueReviews: summary.dueReviews,
                lastSessionAt: sessions[0]?.started_at ?? null,
              };
            }));
            ws.send(JSON.stringify({ type: 'learn_plans', plans: enriched }));
            break;
          }
          case 'learn_get_plan': {
            const plan = await getPlan(msg.planId);
            if (!plan) { ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' })); break; }
            // Ownership check — prevent accessing other users' plans
            if (learnChatId && plan.chat_id !== learnChatId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }));
              break;
            }
            const topics = (await getTopicsByPlan(plan.id)).map((t) => ({
              ...t,
              effectiveMastery: getEffectiveMastery(t),
            }));
            ws.send(JSON.stringify({ type: 'learn_plan_detail', plan, topics }));
            break;
          }
          case 'learn_time': {
            const todayStr = new Date().toISOString().slice(0, 10);
            const week = learnChatId ? await getWeeklyTime(learnChatId) : await getAllWeeklyTime(7);
            const todayData = week.find((d) => d.date === todayStr);
            const todaySeconds = todayData?.total_seconds ?? 0;
            const todaySessions = todayData?.session_count ?? 0;
            const streak = await calculateStreak(learnChatId || undefined);
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
              const sessionPlan = await getPlan(msg.planId);
              if (learnChatId && (!sessionPlan || sessionPlan.chat_id !== learnChatId)) {
                ws.send(JSON.stringify({ type: 'learn_session_history', sessions: [] }));
                break;
              }
              sessions = await getSessionsByPlan(msg.planId, msg.limit ?? 20);
            } else {
              sessions = learnChatId ? await getRecentSessionsByChat(learnChatId, msg.limit ?? 20) : await getAllRecentSessions(msg.limit ?? 20);
            }
            ws.send(JSON.stringify({ type: 'learn_session_history', sessions }));
            break;
          }
          case 'learn_reorder': {
            // Ownership check before mutation — verify topic belongs to user's plan
            if (learnChatId) {
              const topicToReorder = await getTopic(msg.topicId);
              if (topicToReorder) {
                const ownerPlan = await getPlan(topicToReorder.plan_id);
                if (ownerPlan && ownerPlan.chat_id !== learnChatId) {
                  ws.send(JSON.stringify({ type: 'error', message: 'Reorder failed' }));
                  break;
                }
              }
            }
            const success = await reorderTopic(msg.topicId, msg.newPosition);
            if (!success) { ws.send(JSON.stringify({ type: 'error', message: 'Reorder failed' })); break; }
            // Scope to user's plans only
            const reorderPlans = learnChatId ? await getPlansByChat(learnChatId) : await getAllPlans();
            for (const p of reorderPlans) {
              const topics = await getTopicsByPlan(p.id);
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
            const planToUpdate = await getPlan(msg.planId);
            if (!planToUpdate || (learnChatId && planToUpdate.chat_id !== learnChatId)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }));
              break;
            }
            const updates: Partial<{ persona: string; status: PlanStatus }> = {};
            if (msg.persona) updates.persona = msg.persona;
            if (msg.status) updates.status = msg.status as PlanStatus;
            const updated = await updatePlan(msg.planId, updates);
            if (!updated) { ws.send(JSON.stringify({ type: 'error', message: 'Update failed' })); break; }
            const topics = (await getTopicsByPlan(updated.id)).map((t) => ({ ...t, effectiveMastery: getEffectiveMastery(t) }));
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
  /**
   * Idle WebSocket sessions cost RAM (a `VoiceSession` retains a queue, the
   * Speaches sidecar's warmup state, and the chat-context cursor) and lock
   * the per-token-id slot in `activeTokenSessions`. Without timeouts an
   * abandoned tab keeps both forever. Closed at idle (30 min) or absolute
   * cap (4 h), whichever fires first.
   */
  const VOICE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  const VOICE_MAX_SESSION_MS = 4 * 60 * 60 * 1000;

  function setupVoiceHandler(ws: WebSocket, voiceRouter: ProviderRouter, authChatId?: string | null): void {
    const sessionChatId = authChatId || `voice-web-${randomUUID()}`;
    const sessionStartedAt = Date.now();
    logger.info({ chatId: sessionChatId }, 'Voice web: client connected');

    const session = new VoiceSession(sessionChatId, voiceRouter);

    let idleTimer: NodeJS.Timeout | null = null;
    let maxTimer: NodeJS.Timeout | null = null;

    const closeForLimit = (reason: 'idle' | 'max-duration'): void => {
      if (ws.readyState !== ws.OPEN) return;
      const ageMs = Date.now() - sessionStartedAt;
      logger.info({ chatId: sessionChatId, reason, ageMs }, 'Voice web: closing session on lifetime cap');
      try {
        ws.send(JSON.stringify({
          type: 'session_closing',
          reason,
          message: reason === 'idle'
            ? 'Session closed after 30 minutes of inactivity. Reconnect to continue.'
            : 'Session closed after the 4-hour maximum duration. Reconnect to continue.',
        }));
      } catch {
        /* WebSocket already broken — proceed with close */
      }
      ws.close(1000, `session-${reason}`);
    };

    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => closeForLimit('idle'), VOICE_IDLE_TIMEOUT_MS);
    };
    armIdleTimer();
    maxTimer = setTimeout(() => closeForLimit('max-duration'), VOICE_MAX_SESSION_MS);

    // rc.83 — warmup + greeting. Runs in the background so we don't block
    // the 'ready' signal; the client shows "Warming up..." until the
    // 'greeting' message arrives. This is what stops the user from losing
    // their first sentences to Ollama's cold-load wait.
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'warming' }));
        const greeting = await session.warmupAndGreet();
        if (ws.readyState !== ws.OPEN) return; // client gave up during warmup
        ws.send(JSON.stringify({
          type: 'greeting',
          text: greeting.text,
          language: greeting.language,
          warmupTimedOut: greeting.warmupTimedOut,
          hasAudio: greeting.audio !== null,
        }));
        if (greeting.audio) {
          ws.send(greeting.audio);
        }
      } catch (err) {
        logger.error({ err, chatId: sessionChatId }, 'Voice web: greeting flow failed');
        if (ws.readyState === ws.OPEN) {
          // Fall back to a plain ready-without-greeting so the client still
          // transitions out of the warming state instead of hanging forever.
          ws.send(JSON.stringify({ type: 'greeting', text: '', language: 'en', warmupTimedOut: true }));
        }
      }
    })();

    ws.on('message', async (data: Buffer | string, isBinary: boolean) => {
      // Any inbound traffic (including pings) resets the idle timer.
      armIdleTimer();
      // rc.112: distinguish text-frame control messages from binary audio.
      // The `ws` library delivers all frames as Buffer by default, so the
      // previous `typeof data === 'string'` check never fired — pings
      // arrived as Buffer and got routed into the audio path. The
      // isBinary parameter is the canonical signal for the frame type;
      // we still defensively support direct string delivery in case the
      // server is reconfigured to it. Mirrors the board/learn handlers.
      if (!isBinary) {
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : '';
        try {
          const msg = JSON.parse(text);
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

        const result = await session.processAudio(Buffer.from(data as Buffer));

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
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      logger.info({ chatId: sessionChatId }, 'Voice web: client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err, chatId: sessionChatId }, 'Voice web: WebSocket error');
    });
  }

  // rc.92 — sweep stale attendance preview uploads once at boot. The
  // on-upload sweep only fires when HR uploads something; if nobody
  // uploads for days the 24h retention still matters, so run once now.
  try { cleanupAttendanceUploads(); } catch (err) {
    logger.warn({ err }, 'Attendance startup upload cleanup failed (non-fatal)');
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
