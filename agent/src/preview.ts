import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  Agent,
  createServer,
  request,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE, SESSION_TTL_MS, sessionCookie, sessionToken, type Auth } from './auth.ts';
import type { ConfigStore } from './config.ts';
import { HttpError, isAllowedHost, json, jsonBody, readBody } from './http.ts';
import { isValidName, resolveReal } from './paths.ts';
import { listening, type createRuns } from './runs.ts';
import { onPath } from './shells.ts';

const CLIENT_SCRIPT = readFileSync(fileURLToPath(new URL('preview-client.js', import.meta.url)));
const SCRIPT_TAG = Buffer.from('<script src="/__pocketide/preview.js"></script>');
/** HTML larger than this is passed through without the console script. */
const MAX_INJECT_BYTES = 5 * 1024 * 1024;
/**
 * A preview closes when its dev server has been gone for `downMs`, or when nothing has used it (and no page holds a
 * WebSocket open) for `idleMs`; checked every `sweepMs`. Tests shorten them.
 */
export const PREVIEW_TIMINGS = { sweepMs: 15_000, downMs: 60_000, idleMs: 30 * 60_000 };
const HANDOFF_MS = 60_000;

export type Tailscale = string[] | null;
type Runs = ReturnType<typeof createRuns>;

interface Preview {
  /** The dev server's port on this PC. */
  port: number;
  project: string;
  /** The proxy for it, on 127.0.0.1. */
  server: Server;
  local: number;
  /** The tailnet HTTPS port it's published on with `tailscale serve`, once a phone asked for it. */
  ext: number | null;
  publishError: string | null;
  /** Dev servers listen on IPv4 or IPv6 localhost, whichever `localhost` resolved to. */
  upstream: '127.0.0.1' | '::1';
  agent: Agent;
  lastUsed: number;
  downSince: number | null;
  connections: Set<Socket>;
  /** Open WebSockets (HMR): a page is showing the preview. */
  upgraded: Set<Socket>;
  /** One-time tokens for "Open in Safari" (Safari has its own cookies). */
  handoffs: Map<string, number>;
  console: ReturnType<Runs['previewConsole']>;
  consoleBudget: { count: number; since: number };
}

/**
 * Web previews: each dev server port gets its own proxy, and so its own origin (https://<pc>.ts.net:<port + 10000>
 * through `tailscale serve`, or http://localhost:<proxy> on the PC). Apps load from the origin's root, so absolute
 * URLs and HMR WebSockets work unchanged. Only the PocketIDE session gets through; the proxy only ever connects to
 * this PC's loopback, and never to the agent itself.
 */
export function createPreviews(opts: {
  auth: Auth;
  config: ConfigStore;
  runs: Runs;
  agentPort: () => number | undefined;
  tailscale: Tailscale;
  timings?: typeof PREVIEW_TIMINGS;
}) {
  const timings = opts.timings ?? PREVIEW_TIMINGS;
  const { auth, config, runs, tailscale } = opts;
  const previews = new Map<number, Promise<Preview>>();
  const live = new Map<number, Preview>();
  const checked = new Map<string, number>();

  // Serve entries left behind by a crash are removed at startup; only ports recorded as ours are touched.
  const recorded = () => config.read().previewServe ?? [];
  const record = (ports: number[]) => config.write({ ...config.read(), previewServe: ports });
  const leftover = recorded();
  const cleanedUp = leftover.length
    ? Promise.all(leftover.map((ext) => runTailscale(['serve', `--https=${ext}`, 'off']))).then(() => record([]))
    : Promise.resolve();

  /** Re-reads auth.json at most every 10s per session; a page loads hundreds of modules. */
  function authorized(req: IncomingMessage): boolean {
    const token = sessionToken(req);
    if (!token) return false;
    if ((checked.get(token) ?? 0) > Date.now()) return true;
    if (!auth.isValidSession(token)) return false;
    checked.set(token, Date.now() + 10_000);
    return true;
  }

  function runTailscale(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!tailscale) return Promise.resolve({ code: -1, stdout: '', stderr: "Tailscale isn't installed on the PC" });
    return new Promise((resolve) =>
      execFile(tailscale[0], [...tailscale.slice(1), ...args], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr: stderr || (err?.message ?? '') }),
      ),
    );
  }

  /** Publishes the preview on the tailnet: `tailscale serve --bg --https=<ext> http://127.0.0.1:<proxy>`. */
  async function publish(p: Preview) {
    await cleanedUp;
    const status = await runTailscale(['serve', 'status', '--json']);
    if (status.code !== 0) {
      p.publishError = `Couldn't read the Tailscale serve settings: ${status.stderr.trim()}`;
      return;
    }
    let taken: string[];
    try {
      taken = Object.keys(JSON.parse(status.stdout || '{}').TCP ?? {});
    } catch {
      taken = [];
    }
    const ours = [...live.values()].map((q) => q.ext);
    let ext = p.port <= 55535 ? p.port + 10000 : p.port - 10000;
    // A port someone else serves (your own `tailscale serve` settings, another preview) is never replaced.
    while (taken.includes(String(ext)) || ours.includes(ext)) ext++;
    record([...new Set([...recorded(), ext])]); // before creating it, so a crash in between still cleans it up
    const result = await runTailscale(['serve', '--bg', `--https=${ext}`, `http://127.0.0.1:${p.local}`]);
    if (result.code === 0) {
      p.ext = ext;
      p.publishError = null;
    } else {
      record(recorded().filter((x) => x !== ext));
      p.publishError = `tailscale serve failed: ${result.stderr.trim() || `exit code ${result.code}`}`;
    }
  }

  async function open(project: string, port: number, viaTailnet: boolean): Promise<Preview> {
    let pending = previews.get(port);
    if (!pending) {
      pending = start(project, port);
      previews.set(port, pending);
      pending.catch(() => previews.delete(port));
    }
    const p = await pending;
    p.lastUsed = Date.now();
    if (viaTailnet && p.ext === null) await publish(p);
    return p;
  }

  async function start(project: string, port: number): Promise<Preview> {
    const p: Preview = {
      port,
      project,
      server: createServer(),
      local: 0,
      ext: null,
      publishError: null,
      upstream: '127.0.0.1',
      agent: new Agent({ keepAlive: true }),
      lastUsed: Date.now(),
      downSince: null,
      connections: new Set(),
      upgraded: new Set(),
      handoffs: new Map(),
      console: runs.previewConsole(project, port),
      consoleBudget: { count: 0, since: Date.now() },
    };
    p.server.on('request', (req, res) => {
      handle(p, req, res).catch((err) => {
        if (!res.headersSent) page(res, 500, 'Preview error', String((err as Error).message));
        else res.destroy();
      });
    });
    p.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => upgrade(p, req, socket, head));
    p.server.on('connection', (socket: Socket) => {
      p.connections.add(socket);
      socket.on('close', () => p.connections.delete(socket));
    });
    // The same number as the tailnet port when it's free, so the two addresses are easy to match up.
    const preferred = port <= 55535 ? port + 10000 : port - 10000;
    p.local = await listen(p.server, preferred).catch(() => listen(p.server, 0));
    p.upstream = await pickUpstream(port);
    live.set(port, p);
    return p;
  }

  async function handle(p: Preview, req: IncomingMessage, res: ServerResponse) {
    p.lastUsed = Date.now();
    if (!isAllowedHost(req)) return page(res, 403, 'Not allowed', 'This address is only for PocketIDE.');
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://x');
    if (pathname === '/__pocketide/handoff') return handoff(p, req, res, searchParams);
    if (!authorized(req)) {
      return page(res, 401, 'Sign in to PocketIDE', 'This preview is only shown to your PocketIDE session. Open it from the Preview tab in PocketIDE (or with its Open in Safari button).');
    }
    if (pathname.startsWith('/__pocketide/')) return internal(p, req, res, pathname, searchParams);
    forward(p, req, res);
  }

  function forward(p: Preview, req: IncomingMessage, res: ServerResponse) {
    const headers = upstreamHeaders(req.headers, p.port);
    const up = request({ host: p.upstream, port: p.port, method: req.method, path: req.url, headers, agent: p.agent }, (upRes) => {
      const status = upRes.statusCode ?? 502;
      const out = downstreamHeaders(upRes.headers, p.port, frameAncestors(req));
      const html = /^text\/html/i.test(String(upRes.headers['content-type'] ?? ''));
      const encoded = upRes.headers['content-encoding'] && upRes.headers['content-encoding'] !== 'identity';
      if (!html || encoded || req.method === 'HEAD' || status === 204 || status === 304) {
        res.writeHead(status, upRes.statusMessage, out);
        upRes.pipe(res);
        return;
      }
      // Pages get the console script; bodies are small, so they're buffered (huge ones pass through as they are).
      const chunks: Buffer[] = [];
      let size = 0;
      let passing = false;
      upRes.on('data', (chunk: Buffer) => {
        if (passing) return void res.write(chunk);
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_INJECT_BYTES) {
          passing = true;
          res.writeHead(status, upRes.statusMessage, out);
          for (const c of chunks) res.write(c);
        }
      });
      upRes.on('end', () => {
        if (passing) return void res.end();
        const body = injectScript(Buffer.concat(chunks));
        delete out['transfer-encoding'];
        out['content-length'] = body.length;
        res.writeHead(status, upRes.statusMessage, out);
        res.end(body);
      });
      upRes.on('error', () => res.destroy());
    });
    up.on('error', async (err: NodeJS.ErrnoException) => {
      if (res.headersSent) return void res.destroy();
      p.upstream = await pickUpstream(p.port); // maybe it came back on the other address
      if (err.code === 'ECONNREFUSED') return waiting(res, p.port);
      page(res, 502, 'Preview error', `The dev server on port ${p.port} didn't answer: ${err.message}`);
    });
    req.pipe(up);
  }

  function upgrade(p: Preview, req: IncomingMessage, socket: Socket, head: Buffer) {
    socket.on('error', () => socket.destroy());
    if (!isAllowedHost(req) || !authorized(req)) {
      return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    p.lastUsed = Date.now();
    const up = request({ host: p.upstream, port: p.port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, p.port), agent: false });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(statusLine(101, upRes.statusMessage) + rawHeaderLines(upRes.rawHeaders) + '\r\n');
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      p.upgraded.add(socket);
      const end = () => {
        p.upgraded.delete(socket);
        p.lastUsed = Date.now();
        socket.destroy();
        upSocket.destroy();
      };
      socket.on('close', end);
      upSocket.on('close', end);
      upSocket.on('error', end);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    // The dev server answered without switching protocols (e.g. it rejected the request): pass that on.
    up.on('response', (upRes) => {
      socket.write(statusLine(upRes.statusCode ?? 502, upRes.statusMessage) + rawHeaderLines(upRes.rawHeaders) + '\r\n');
      upRes.pipe(socket);
    });
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    up.end();
  }

  async function internal(p: Preview, req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) {
    if (pathname === '/__pocketide/preview.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return void res.end(CLIENT_SCRIPT);
    }
    if (pathname === '/__pocketide/alive') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({ up: await listening(p.port) }));
    }
    if (pathname === '/__pocketide/hard-reload') {
      // Empties this preview's browser cache (only this origin's), then loads the page again.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache"' });
      return void res.end(goTo(safePath(query.get('path'))));
    }
    if (pathname === '/__pocketide/console' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      let entries: unknown;
      try {
        entries = JSON.parse(body?.toString('utf8') ?? '');
      } catch {
        entries = [];
      }
      for (const entry of [entries].flat() as { level?: unknown; text?: unknown }[]) {
        if (!entry || typeof entry.text !== 'string') continue;
        const budget = p.consoleBudget;
        if (Date.now() - budget.since > 10_000) Object.assign(budget, { count: 0, since: Date.now() });
        if (++budget.count > 200) continue; // a page logging in a loop shouldn't flood the log
        p.console.write(entry.level === 'warn' ? 'warn' : 'error', projectPaths(entry.text.slice(0, 8000)));
      }
      res.writeHead(204);
      return void res.end();
    }
    page(res, 404, 'Not found', '');
  }

  /** "Open in Safari": a one-time token that gives Safari (with its own cookies) a PocketIDE session. */
  function handoff(p: Preview, _req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
    const token = query.get('t') ?? '';
    const expires = p.handoffs.get(token);
    p.handoffs.delete(token);
    if (!expires || expires < Date.now()) {
      return page(res, 401, 'Link expired', 'This link works once, for a minute. Use Open in Safari in PocketIDE again.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(auth.createSession(), SESSION_TTL_MS / 1000),
      'Referrer-Policy': 'no-referrer',
    });
    // A page (not a redirect) moves on, so the next request is a same-site one that carries the new cookie.
    res.end(goTo(safePath(query.get('path'))));
  }

  async function close(p: Preview) {
    previews.delete(p.port);
    live.delete(p.port);
    p.server.close();
    for (const socket of [...p.connections, ...p.upgraded]) socket.destroy();
    p.agent.destroy();
    p.console.close();
    if (p.ext !== null) {
      const ext = p.ext;
      p.ext = null;
      await runTailscale(['serve', `--https=${ext}`, 'off']);
      record(recorded().filter((x) => x !== ext));
    }
  }

  // Previews of dev servers that stopped, or that nobody looks at any more, close (and leave the tailnet).
  const sweeper = setInterval(async () => {
    for (const p of live.values()) {
      if (!(await listening(p.port))) p.downSince ??= Date.now();
      else p.downSince = null;
      const idle = !p.upgraded.size && Date.now() - p.lastUsed > timings.idleMs;
      if (idle || (p.downSince !== null && Date.now() - p.downSince > timings.downMs)) void close(p);
    }
  }, timings.sweepMs);
  sweeper.unref();

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    'POST /api/preview/open': async (req, res) => {
      const { project, port } = await jsonBody(req);
      if (typeof project !== 'string' || !isValidName(project)) throw new HttpError(400, 'Invalid project');
      const root = config.read().projectsRoot;
      if (!root || (await resolveReal(root, project)) === null) throw new HttpError(403, 'That project is outside the projects folder');
      const target = checkPort(port);
      const viaTailnet = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase().endsWith('.ts.net');
      const p = await open(project, target, viaTailnet);
      json(res, 200, { port: p.port, local: p.local, ext: p.ext, publishError: p.publishError });
    },
    'POST /api/preview/handoff': async (req, res) => {
      const { port, path } = await jsonBody(req);
      const p = live.get(checkPort(port));
      if (!p) throw new HttpError(404, 'That preview is closed');
      const token = randomBytes(32).toString('base64url');
      for (const [t, expires] of p.handoffs) if (expires < Date.now()) p.handoffs.delete(t);
      p.handoffs.set(token, Date.now() + HANDOFF_MS);
      json(res, 200, { path: `/__pocketide/handoff?t=${token}&path=${encodeURIComponent(safePath(path))}` });
    },
    'GET /api/preview/ports': async (_req, res) => {
      const exclude = new Set([opts.agentPort(), ...[...live.values()].map((p) => p.local)]);
      json(res, 200, { ports: (await listeningPorts()).filter((p) => !exclude.has(p.port)) });
    },
  };

  /** Only ports on this PC, never the agent itself or a preview proxy (the proxy only ever dials loopback). */
  function checkPort(value: unknown): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'A port is a number from 1 to 65535');
    if (port === opts.agentPort()) throw new HttpError(400, "That's PocketIDE's own port");
    if ([...live.values()].some((p) => p.local === port)) throw new HttpError(400, "That's one of PocketIDE's preview ports");
    return port;
  }

  return {
    routes,
    /** Synchronous, for the agent's exit: closes the proxies and removes their `tailscale serve` entries. */
    shutdown() {
      clearInterval(sweeper);
      for (const p of live.values()) {
        p.server.close();
        for (const socket of [...p.connections, ...p.upgraded]) socket.destroy();
        if (p.ext !== null && tailscale) {
          try {
            execFileSync(tailscale[0], [...tailscale.slice(1), 'serve', `--https=${p.ext}`, 'off'], { timeout: 10_000, windowsHide: true, stdio: 'ignore' });
          } catch {
            // already gone; the record below would retry at the next start otherwise
          }
          p.ext = null;
        }
      }
      live.clear();
      previews.clear();
      if (recorded().length) record([]);
    },
  };
}

/** The Tailscale CLI, if installed. */
export function findTailscale(): Tailscale {
  const file = onPath('tailscale.exe') ?? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')].find(existsSync);
  return file ? [file] : null;
}

const listen = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });

async function pickUpstream(port: number): Promise<'127.0.0.1' | '::1'> {
  const works = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ port, host, timeout: 1000 });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
      s.once('timeout', () => (s.destroy(), resolve(false)));
    });
  return (await works('127.0.0.1')) || !(await works('::1')) ? '127.0.0.1' : '::1';
}

// Proxy and tailnet headers would make dev servers build URLs for the wrong host, or reject the request.
const DROPPED = /^(x-forwarded-|forwarded$|x-real-ip$|tailscale-)/i;

/** What the dev server sees: a request from a browser on this PC, for localhost:<port>. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !DROPPED.test(name)) out[name] = value;
  const local = `localhost:${port}`;
  out.host = local;
  if (headers.origin) out.origin = `http://${local}`;
  if (headers.referer) out.referer = headers.referer.replace(/^https?:\/\/[^/]+/i, `http://${local}`);
  // The PocketIDE session never reaches the app (its code could read it and use it).
  const cookies = (headers.cookie ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length) out.cookie = cookies.join('; ');
  else delete out.cookie;
  // Pages come uncompressed, so the console script can be added; everything else keeps its compression.
  const page = headers['sec-fetch-dest'] === 'document' || headers['sec-fetch-dest'] === 'iframe' || /text\/html/.test(String(headers.accept ?? ''));
  if (page) out['accept-encoding'] = 'identity';
  return out;
}

/** What the browser gets: frameable by PocketIDE only, with redirects and cookies that work at the preview origin. */
export function downstreamHeaders(headers: IncomingHttpHeaders, port: number, ancestors: string): OutgoingHttpHeaders {
  // Plain names: Node types some headers (like CSP) as single strings, but they can repeat.
  const out: Record<string, number | string | string[] | undefined> = { ...headers };
  delete out['x-frame-options'];
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const value = out[name] as string | string[] | undefined;
    if (value === undefined) continue;
    const kept = [value]
      .flat()
      .map((policy) => policy.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim())
      .filter((policy) => policy.replace(/;/g, '').trim());
    if (kept.length) out[name] = kept;
    else delete out[name];
  }
  out['content-security-policy'] = [...[(out['content-security-policy'] as string[] | undefined) ?? []].flat(), `frame-ancestors ${ancestors}`];
  if (typeof out.location === 'string') {
    out.location = out.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:${port})?(?=[/?#]|$)`, 'i'), '') || '/';
  }
  if (Array.isArray(out['set-cookie'])) {
    out['set-cookie'] = out['set-cookie']
      .filter((c) => !c.trimStart().startsWith(`${SESSION_COOKIE}=`))
      .map((c) => c.replace(/;\s*domain=[^;]*/gi, '')); // set for localhost; the browser is at the preview host
  }
  return out;
}

/** Who may show the preview in a frame: PocketIDE, on the tailnet host or on this PC. */
function frameAncestors(req: IncomingMessage): string {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const tailnet = host.endsWith('.ts.net') ? ` https://${host}:*` : '';
  return `'self'${tailnet} http://localhost:* http://127.0.0.1:*`;
}

/** Adds the console script at the start of <head> (or as early as possible without changing the document mode). */
export function injectScript(body: Buffer): Buffer {
  const start = body.subarray(0, 65536).toString('latin1');
  const tag = /<head\b[^>]*>/i.exec(start) ?? /<html\b[^>]*>/i.exec(start) ?? /<!doctype[^>]*>/i.exec(start);
  const at = tag ? tag.index + tag[0].length : 0;
  return Buffer.concat([body.subarray(0, at), SCRIPT_TAG, body.subarray(at)]);
}

/** Browser stack traces name files by URL (https://<pc>:15173/src/App.tsx?t=1:3:5); the log wants src/App.tsx:3:5. */
export function projectPaths(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s/'"()]+\/([^\s'"()?#:]*)(?:\?[^\s'"():]*)?/g, '$1');
}

/** A path within the preview: absolute, and never protocol-relative (//evil.example). */
function safePath(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

function goTo(path: string): string {
  const target = JSON.stringify(path).replace(/</g, '\\u003c');
  return `<!doctype html><meta name="viewport" content="width=device-width"><script>location.replace(${target})</script>`;
}

const statusLine = (code: number, message?: string) => `HTTP/1.1 ${code} ${message || STATUS_CODES[code] || ''}\r\n`;

function rawHeaderLines(raw: string[]): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 2) out += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return out;
}

const STYLE = 'body{margin:30vh 24px 0;background:#0d1117;color:#e6edf3;font:16px/1.4 -apple-system,system-ui,sans-serif;text-align:center}p+p{color:#8b949e}';

function page(res: ServerResponse, status: number, title: string, text: string) {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>${STYLE}</style><p>${escape(title)}</p><p>${escape(text)}</p>`);
}

/** The dev server isn't up (yet, or it's restarting): a page that reloads itself as soon as it is. */
function waiting(res: ServerResponse, port: number) {
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Waiting for the dev server</title><style>${STYLE}</style>` +
      `<p>Nothing answers on port ${port} yet.</p><p>This page reloads by itself as soon as the dev server is up.</p>` +
      `<script>setInterval(async()=>{try{if((await (await fetch('/__pocketide/alive')).json()).up)location.reload()}catch{}},1000)</script>`,
  );
}

export interface ListeningPort {
  port: number;
  pid: number;
  process: string;
}

// Windows' own services listen on plenty of ports; they're never what you want to preview.
const SYSTEM = new Set(['system', 'idle', 'svchost.exe', 'lsass.exe', 'wininit.exe', 'services.exe', 'spoolsv.exe', 'tailscaled.exe', 'msedgewebview2.exe']);

/** Ports that programs on this PC listen on locally (dev servers, mostly), with the program's name. */
export async function listeningPorts(): Promise<ListeningPort[]> {
  const run = (file: string, args: string[]) =>
    new Promise<string>((resolve) => execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 << 20 }, (_err, stdout) => resolve(stdout ?? '')));
  const [netstat, tasks] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']).then(async (v4) => v4 + (await run('netstat', ['-ano', '-p', 'TCPv6']))), run('tasklist', ['/fo', 'csv', '/nh'])]);
  const names = new Map<number, string>();
  for (const line of tasks.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1]);
  }
  return parseNetstat(netstat)
    .filter(({ pid, port }) => port >= 1024 && pid !== process.pid && pid > 4)
    .map(({ port, pid }) => ({ port, pid, process: names.get(pid) ?? `PID ${pid}` }))
    .filter((p) => !SYSTEM.has(p.process.toLowerCase()));
}

/** Local listening TCP ports from `netstat -ano` (loopback or all addresses), one entry per port. */
export function parseNetstat(text: string): { port: number; pid: number }[] {
  const found = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (!m || !['127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(m[1])) continue;
    if (!found.has(Number(m[2]))) found.set(Number(m[2]), Number(m[3]));
  }
  return [...found].map(([port, pid]) => ({ port, pid })).sort((a, b) => a.port - b.port);
}
