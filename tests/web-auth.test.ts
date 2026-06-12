import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * HTTP auth contract tests for the voice web server (src/web/server.ts).
 *
 * Tests authenticateApiRequest / isOriginAllowed / checkRateLimit directly
 * with fake req/res objects rather than booting startVoiceWebServer:
 * the rate limiter only *rejects* on the WebSocket path (close code 4029
 * in the wss connection handler) — the HTTP auth path records failures but
 * never returns 429 — so fetch()-level tests cannot observe the limiter,
 * and every real socket shares one loopback IP. Direct calls with unique
 * fake IPs per test keep the module-level limiter state deterministic.
 */

// Vitest-4 idiom: vi.hoisted shares mutable state between the hoisted
// vi.mock factories and the test bodies.
const { mockConfig, validTokens } = vi.hoisted(() => ({
  mockConfig: {
    NODE_ENV: 'test',
    VOICE_WEB_PORT: 3030,
    VOICE_WEB_TOKEN: '',
    VOICE_WEB_ORIGIN: '',
    ALLOWED_CHAT_ID: '111111,222222',
  },
  // Per-user token store backing the validateWebToken mock: token → chatId
  validTokens: new Map<string, string>(),
}));

vi.mock('../src/config.js', () => ({
  config: mockConfig,
  PROJECT_ROOT: '/tmp/luna-web-auth-test',
  STORE_DIR: '/tmp/luna-web-auth-test/store',
  WORKSPACE_DIR: '/tmp/luna-web-auth-test/workspace',
  UPLOADS_DIR: '/tmp/luna-web-auth-test/workspace/uploads',
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// No DB: per-user token validation is backed by the validTokens map.
vi.mock('../src/web/web-tokens.js', () => ({
  validateWebToken: async (token: string) => {
    const chatId = validTokens.get(token);
    return chatId
      ? { valid: true, chatId, isLegacy: false, tokenPrefix: token.slice(0, 8) }
      : { valid: false, chatId: null, isLegacy: false, tokenPrefix: null };
  },
  logTokenAudit: async () => {},
}));

// Import AFTER mocking
import { authenticateApiRequest, checkRateLimit, isOriginAllowed } from '../src/web/server.js';

// ── Fake req/res helpers ────────────────────────────────────

// The auth-failure maps in server.ts are module-level and not resettable,
// so every test uses fresh IPs to stay isolated.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

interface ReqOpts {
  bearer?: string;       // Authorization: Bearer <value>
  queryToken?: string;   // ?token=<value>
  ip?: string;
  method?: string;
}

function makeReq(opts: ReqOpts = {}): import('node:http').IncomingMessage {
  const headers: Record<string, string> = { host: 'localhost:3030' };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  const url = opts.queryToken !== undefined
    ? `/api/sim?token=${encodeURIComponent(opts.queryToken)}`
    : '/api/sim';
  return {
    method: opts.method ?? 'GET',
    url,
    headers,
    socket: { remoteAddress: opts.ip ?? uniqueIp() },
  } as unknown as import('node:http').IncomingMessage;
}

interface CapturedRes {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

function makeRes(): { res: import('node:http').ServerResponse; out: CapturedRes } {
  const out: CapturedRes = { statusCode: 0, headers: {}, body: '' };
  const res = {
    setHeader(k: string, v: unknown) { out.headers[k.toLowerCase()] = v; },
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v;
      return res;
    },
    end(body?: string | Buffer) { out.body = body ? body.toString() : ''; },
  };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}

beforeEach(() => {
  validTokens.clear();
  mockConfig.VOICE_WEB_TOKEN = '';
  mockConfig.VOICE_WEB_ORIGIN = '';
  mockConfig.ALLOWED_CHAT_ID = '111111,222222';
});

afterEach(() => {
  vi.useRealTimers();
});

// ── authenticateApiRequest ──────────────────────────────────

describe('authenticateApiRequest: missing/invalid tokens', () => {
  it('missing token → 401 with JSON error body', async () => {
    const { res, out } = makeRes();
    const chatId = await authenticateApiRequest(makeReq(), res);

    expect(chatId).toBeNull();
    expect(out.statusCode).toBe(401);
    expect(out.headers['content-type']).toBe('application/json');
    expect(JSON.parse(out.body).error).toMatch(/Unauthorized/);
  });

  it('invalid token → 401, and each failure is counted by the rate limiter', async () => {
    const ip = uniqueIp();
    const valid = 'a'.repeat(64);
    validTokens.set(valid, '111111');

    // AUTH_FAIL_MAX = 3: the IP stays clean for the first two failures…
    for (let i = 0; i < 2; i++) {
      const { res, out } = makeRes();
      expect(await authenticateApiRequest(makeReq({ bearer: 'wrong-token', ip }), res)).toBeNull();
      expect(out.statusCode).toBe(401);
      expect(JSON.parse(out.body).error).toMatch(/invalid token/);
    }
    expect(checkRateLimit(ip)).toBe(true);

    // …and the third recorded failure trips the per-minute limit.
    const { res } = makeRes();
    await authenticateApiRequest(makeReq({ bearer: 'wrong-token', ip }), res);
    expect(checkRateLimit(ip)).toBe(false);
  });
});

describe('authenticateApiRequest: per-user tokens', () => {
  it('valid per-user token via Bearer header → authorized with scoped chatId', async () => {
    const token = 'b'.repeat(64);
    validTokens.set(token, '999999');

    const { res, out } = makeRes();
    const chatId = await authenticateApiRequest(makeReq({ bearer: token }), res);

    expect(chatId).toBe('999999');
    expect(out.statusCode).toBe(0); // no error response written — caller proceeds to the 200 path
    expect(out.body).toBe('');
  });

  it('valid per-user token via ?token= query param → authorized', async () => {
    const token = 'c'.repeat(64);
    validTokens.set(token, '888888');

    const { res } = makeRes();
    const chatId = await authenticateApiRequest(makeReq({ queryToken: token }), res);

    expect(chatId).toBe('888888');
  });
});

describe('authenticateApiRequest: legacy VOICE_WEB_TOKEN fallback', () => {
  it('correct legacy token → authorized, scoped to first ALLOWED_CHAT_ID', async () => {
    mockConfig.VOICE_WEB_TOKEN = 'legacy-secret-token-1234';
    mockConfig.ALLOWED_CHAT_ID = ' 111111 ,222222'; // first entry is trimmed

    const { res } = makeRes();
    const chatId = await authenticateApiRequest(makeReq({ bearer: 'legacy-secret-token-1234' }), res);

    expect(chatId).toBe('111111');
  });

  it('wrong-length candidate → 401 (length check guards timingSafeEqual)', async () => {
    mockConfig.VOICE_WEB_TOKEN = 'legacy-secret-token-1234';

    const { res, out } = makeRes();
    const chatId = await authenticateApiRequest(makeReq({ bearer: 'short' }), res);

    expect(chatId).toBeNull();
    expect(out.statusCode).toBe(401);
    expect(JSON.parse(out.body).error).toMatch(/invalid token/);
  });

  it('empty-string legacy token configured → branch never matches', async () => {
    mockConfig.VOICE_WEB_TOKEN = '';

    // A non-empty candidate cannot match an empty config token…
    const { res: res1, out: out1 } = makeRes();
    expect(await authenticateApiRequest(makeReq({ bearer: 'x' }), res1)).toBeNull();
    expect(out1.statusCode).toBe(401);

    // …and an empty candidate (?token=) is treated as missing, never compared.
    const { res: res2, out: out2 } = makeRes();
    expect(await authenticateApiRequest(makeReq({ queryToken: '' }), res2)).toBeNull();
    expect(out2.statusCode).toBe(401);
    expect(JSON.parse(out2.body).error).toMatch(/provide token/);
  });
});

// ── Rate limiting ───────────────────────────────────────────

describe('auth-failure rate limiting (per IP)', () => {
  it('3 failures within a minute → IP rejected; different IP unaffected', async () => {
    const hotIp = uniqueIp();
    const coldIp = uniqueIp();

    for (let i = 0; i < 3; i++) {
      const { res } = makeRes();
      await authenticateApiRequest(makeReq({ bearer: 'nope', ip: hotIp }), res);
    }

    // The connection gate (used by the WS handler, which closes with 4029)
    // now rejects the offending IP only.
    expect(checkRateLimit(hotIp)).toBe(false);
    expect(checkRateLimit(coldIp)).toBe(true);
  });

  it('hourly ban triggers after 15 failures and expires after 1 hour (rc.113 fix)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    const ip = uniqueIp();

    for (let i = 0; i < 15; i++) {
      const { res } = makeRes();
      await authenticateApiRequest(makeReq({ bearer: 'nope', ip }), res);
    }
    expect(checkRateLimit(ip)).toBe(false);

    // The ban outlives the per-minute window…
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit(ip)).toBe(false);

    // …and lifts after the 1-hour ban window.
    vi.advanceTimersByTime(3_600_000);
    expect(checkRateLimit(ip)).toBe(true);
  });

  it('per-minute window expires → IP admitted again after 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      const { res } = makeRes();
      await authenticateApiRequest(makeReq({ bearer: 'nope', ip }), res);
    }
    expect(checkRateLimit(ip)).toBe(false);

    // 61 seconds later the per-minute window has expired.
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit(ip)).toBe(true);
  });
});

// ── isOriginAllowed (WebSocket origin validation) ───────────

describe('isOriginAllowed', () => {
  it('allows requests with no Origin header (same-origin)', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
  });

  it('allows localhost and 127.0.0.1 on any port', () => {
    expect(isOriginAllowed('http://localhost:3030')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:9999')).toBe(true);
  });

  it('rejects foreign origins', () => {
    expect(isOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('allows an exact VOICE_WEB_ORIGIN match only', () => {
    mockConfig.VOICE_WEB_ORIGIN = 'https://luna.example.com';
    expect(isOriginAllowed('https://luna.example.com')).toBe(true);
    expect(isOriginAllowed('https://luna.example.com:8443')).toBe(false);
    expect(isOriginAllowed('https://luna.example.com.evil.net')).toBe(false);
  });

  it('rejects garbage origin strings (URL parse failure)', () => {
    expect(isOriginAllowed('not a url at all')).toBe(false);
  });
});
