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
import type { ProviderRouter } from '../providers/router.js';

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

  // Serve static files
  function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    let urlPath = req.url?.split('?')[0] || '/';
    if (urlPath === '/') urlPath = '/index.html';

    // Only serve files from public directory
    const filePath = resolve(PUBLIC_DIR, urlPath.slice(1));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req) => {
    // Auth: check token in query string
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const clientToken = url.searchParams.get('token');

    // Constant-time token comparison to prevent timing attacks
    const tokenValid = clientToken !== null
      && clientToken.length === token.length
      && timingSafeEqual(Buffer.from(clientToken), Buffer.from(token));

    if (!tokenValid) {
      logger.warn({ ip: req.socket.remoteAddress }, 'Voice web: unauthorized connection attempt');
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Check connection mode: voice (default) or board
    const mode = url.searchParams.get('mode');

    if (mode === 'board') {
      // ── Board WebSocket Handler ──
      const boardChatId = config.ALLOWED_CHAT_ID?.split(',')[0]?.trim() || 'web-board';
      logger.info('Board web: client connected');

      ws.on('message', (data: Buffer | string) => {
        if (typeof data !== 'string') return;
        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            case 'board_list': {
              const cards = listAllCards(boardChatId);
              ws.send(JSON.stringify({ type: 'board_data', cards }));
              break;
            }
            case 'board_create': {
              const card = createCard(boardChatId, msg.title, {
                description: msg.description,
                assignee: msg.assignee as CardAssignee,
                priority: msg.priority,
                source: 'user',
              });
              ws.send(JSON.stringify({ type: 'card_created', card }));
              // Send updated board
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
              if (msg.due_date) updates.due_date = parseDateHint(msg.due_date);
              if (msg.scheduled_for) updates.scheduled_for = parseDateHint(msg.scheduled_for);
              const updatedCard = updateCard(msg.cardId, updates);
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
      return; // Don't fall through to voice handler
    }

    // ── Voice WebSocket Handler (default) ──
    const sessionChatId = `voice-web-${randomUUID()}`;
    logger.info({ chatId: sessionChatId }, 'Voice web: client connected');

    const session = new VoiceSession(sessionChatId, router);

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

        // Send transcript + response text
        ws.send(JSON.stringify({
          type: 'response',
          transcript: result.transcript,
          text: result.text,
          provider: result.provider,
        }));

        // Send audio as binary
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

    // Send ready message
    ws.send(JSON.stringify({ type: 'ready' }));
  });

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
