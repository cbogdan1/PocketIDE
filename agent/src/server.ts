import { readFile, stat } from 'node:fs/promises';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLimiter, SESSION_TTL_MS, type Auth } from './auth.ts';
import { resolveInside } from './paths.ts';

const COOKIE = '__Host-pocketide';
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export function createApp(auth: Auth, staticDir: string) {
  const limiter = createLimiter(5, 15 * 60_000);
  const wss = new WebSocketServer({ noServer: true });

  // Ping every 30s and drop clients that missed the last pong (phone slept, network changed).
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.delete(ws)) ws.ping();
      else ws.terminate();
    }
  }, 30_000);
  heartbeat.unref();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'Internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!isAllowedHost(req)) return json(res, 403, { error: 'Host not allowed' });
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead && !isSameOrigin(req)) return json(res, 403, { error: 'Cross-origin request blocked' });

    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (pathname === '/api/login' && req.method === 'POST') return login(req, res);
    if (pathname.startsWith('/api/')) {
      const token = sessionToken(req);
      if (!token || !auth.isValidSession(token)) return json(res, 401, { error: 'Not logged in' });
      if (pathname === '/api/session' && isRead) return json(res, 200, { host: hostname() });
      if (pathname === '/api/logout' && req.method === 'POST') {
        auth.deleteSession(token);
        res.setHeader('Set-Cookie', cookie('', 0));
        return json(res, 200, {});
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (isRead) return serveStatic(req, res, pathname);
    json(res, 405, { error: 'Method not allowed' });
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    // Counted before the (slow) hash check, so parallel guesses can't slip past the limit.
    const wait = limiter.hit(ip);
    if (wait) {
      res.setHeader('Retry-After', Math.ceil(wait / 1000));
      return json(res, 429, { error: 'Too many attempts' });
    }
    const body = await readJson(req);
    const password = (body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !(await auth.checkPassword(password))) {
      return json(res, 401, { error: 'Wrong password' });
    }
    limiter.reset(ip);
    res.setHeader('Set-Cookie', cookie(auth.createSession(), SESSION_TTL_MS / 1000));
    json(res, 200, {});
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: 'Bad path' });
    }
    const file = resolveInside(staticDir, rel.endsWith('/') ? rel + 'index.html' : rel);
    // stat first: it reports Windows device names (CON, NUL...) as missing instead of opening them.
    const info = file ? await stat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) return json(res, 404, { error: 'Not found' });
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // Vite fingerprints everything under /assets, so those files never change.
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body); // Node drops the body itself for HEAD
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const status =
      !isAllowedHost(req) || !isSameOrigin(req) ? 403
      : !auth.isValidSession(sessionToken(req)) ? 401
      : pathname !== '/ws/events' ? 404
      : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
    });
  });
  server.on('close', () => clearInterval(heartbeat));

  return server;
}

/** Only names the agent is legitimately reached by; blocks DNS-rebinding pages on the PC. */
function isAllowedHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.ts.net');
}

/** Browsers always send Origin on cross-origin writes and WebSocket handshakes; reject any foreign one. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host?.toLowerCase();
  } catch {
    return false;
  }
}

/** tailscale serve appends the real client address to X-Forwarded-For; the socket peer is always loopback. */
function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()!.trim();
  return forwarded || req.socket.remoteAddress || '';
}

function sessionToken(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.match(COOKIE_RE)?.[1];
}

function cookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
