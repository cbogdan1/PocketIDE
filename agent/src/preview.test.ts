import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createAuth } from './auth.ts';
import { createConfig } from './config.ts';
import { downstreamHeaders, injectScript, parseNetstat, projectPaths, tailnetPort, upstreamHeaders } from './preview.ts';
import { createApp } from './server.ts';
import { startAgent } from './testing.ts';

// A stand-in for the Tailscale CLI: keeps "serve" entries in state.json next to it and logs every call.
const fakeDir = realpathSync(mkdtempSync(join(tmpdir(), 'pocketide-tailscale-')));
writeFileSync(
  join(fakeDir, 'tailscale.mjs'),
  `import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('state.json', import.meta.url);
let state;
try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = { TCP: { '443': { HTTPS: true } }, calls: [] }; }
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
// Like the real CLI (a round trip to tailscaled): calls running at the same time would overwrite each other.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
let code = 0;
if (args[1] === 'status') process.stdout.write(JSON.stringify({ TCP: state.TCP }));
else {
  const port = args.find((a) => a.startsWith('--https=')).slice(8);
  if (args.at(-1) === 'off') {
    if (state.TCP[port]) delete state.TCP[port];
    else { process.stderr.write('error: failed to remove web serve: handler does not exist'); code = 1; }
  } else state.TCP[port] = { HTTPS: true, proxy: args.at(-1) };
}
writeFileSync(file, JSON.stringify(state));
process.exit(code);`,
);
const tailscale = [process.execPath, join(fakeDir, 'tailscale.mjs')];
const serveState = (): { TCP: Record<string, { proxy?: string }>; calls: string[] } => JSON.parse(readFileSync(join(fakeDir, 'state.json'), 'utf8'));
const setServeState = (TCP: Record<string, object>) => writeFileSync(join(fakeDir, 'state.json'), JSON.stringify({ TCP, calls: [] }));

const agent = await startAgent({ tailscale, previewTimings: { sweepMs: 150, downMs: 500, idleMs: 60_000 } });
const projects = join(agent.dir, 'projects');
const TAILNET = 'pc.example.ts.net';
let cookie = '';

// A dev server: a page with headers that would stop it from being framed, a redirect, cookies, and HMR over WebSocket.
let seen: IncomingHttpHeaders = {};
const dev = createServer((req, res) => {
  seen = req.headers;
  const port = (dev.address() as AddressInfo).port;
  if (req.url === '/redirect') return void res.writeHead(302, { Location: `http://localhost:${port}/after?x=1` }).end();
  if (req.url === '/data.json') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'Set-Cookie': ['app=1; Domain=localhost; Path=/', '__Host-pocketide=planted; Path=/; Secure'],
  });
  res.end('<!doctype html><html lang="en"><head><title>Dev</title></head><body>hello</body></html>');
});
const hmr = new WebSocketServer({ server: dev });
hmr.on('connection', (ws, req) => {
  ws.send(`origin ${req.headers.origin} host ${req.headers.host}`);
  ws.on('message', (data) => ws.send(`echo ${data}`));
});

before(async () => {
  cookie = await agent.cookie();
  mkdirSync(join(projects, 'app'), { recursive: true });
  await api('/api/config', 'PATCH', { projectsRoot: projects });
  await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
});
after(() => {
  agent.server.shutdown();
  agent.server.closeAllConnections();
  agent.server.close();
  hmr.close();
  dev.close();
});

async function api(path: string, method = 'GET', body?: object, host?: string) {
  const headers: Record<string, string> = { Cookie: cookie, Origin: host ? `https://${host}` : agent.origin, 'Content-Type': 'application/json' };
  if (host) headers.Host = host;
  const res = await agent.call(path, method, headers, body && JSON.stringify(body));
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
}

const devPort = () => (dev.address() as AddressInfo).port;
const open = async (port = devPort(), host?: string) => {
  const res = await api('/api/preview/open', 'POST', { project: 'app', port }, host);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { port: number; local: number; ext: number | null; publishError: string | null };
};

/** A request to a preview proxy, as the phone's browser would make it. */
function get(local: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: local, path, headers: { Host: `127.0.0.1:${local}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('header rewriting: the dev server sees localhost, the browser can frame the page', () => {
  const up = upstreamHeaders(
    {
      host: `${TAILNET}:15173`,
      origin: `https://${TAILNET}:15173`,
      referer: `https://${TAILNET}:15173/about?x=1`,
      cookie: '__Host-pocketide=secret; theme=dark',
      'x-forwarded-host': `${TAILNET}:15173`,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '100.1.2.3',
      'tailscale-user-login': 'me@example.com',
      'sec-fetch-dest': 'iframe',
      'accept-encoding': 'gzip, br',
    },
    5173,
  );
  assert.deepEqual(up, {
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    referer: 'http://localhost:5173/about?x=1',
    cookie: 'theme=dark',
    'sec-fetch-dest': 'iframe',
    'accept-encoding': 'identity',
  });
  assert.equal(upstreamHeaders({ cookie: '__Host-pocketide=secret', 'accept-encoding': 'gzip' }, 3000).cookie, undefined);
  assert.equal(upstreamHeaders({ 'accept-encoding': 'gzip', accept: 'application/javascript' }, 3000)['accept-encoding'], 'gzip');

  const down = downstreamHeaders(
    {
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'none'; script-src 'self'",
      'content-security-policy-report-only': "frame-ancestors 'self'",
      location: 'http://127.0.0.1:5173/login?next=%2F',
      'set-cookie': ['sid=1; Domain=localhost; Path=/; HttpOnly', '__Host-pocketide=x; Path=/'],
    },
    5173,
    "'self' https://pc.example.ts.net:*",
  );
  assert.equal(down['x-frame-options'], undefined);
  assert.deepEqual(down['content-security-policy'], ["script-src 'self'", "frame-ancestors 'self' https://pc.example.ts.net:*"]);
  assert.equal(down['content-security-policy-report-only'], undefined);
  assert.equal(down.location, '/login?next=%2F');
  assert.deepEqual(down['set-cookie'], ['sid=1; Path=/; HttpOnly']);
  assert.equal(downstreamHeaders({ location: 'http://localhost:5173' }, 5173, "'self'").location, '/');
  assert.equal(downstreamHeaders({ location: 'http://localhost:51730/x' }, 5173, "'self'").location, 'http://localhost:51730/x');
  assert.equal(downstreamHeaders({ location: 'https://example.com/x' }, 5173, "'self'").location, 'https://example.com/x');
});

test('the console script goes at the start of <head>', () => {
  const tag = '<script src="/__pocketide/preview.js"></script>';
  assert.equal(injectScript(Buffer.from('<!DOCTYPE html><html><HEAD lang=x><title>t</title></HEAD>')).toString(), `<!DOCTYPE html><html><HEAD lang=x>${tag}<title>t</title></HEAD>`);
  assert.equal(injectScript(Buffer.from('<!doctype html><p>no head')).toString(), `<!doctype html>${tag}<p>no head`);
  assert.equal(injectScript(Buffer.from('<p>fragment')).toString(), `${tag}<p>fragment`);
  assert.equal(projectPaths('at App (https://pc.example.ts.net:15173/src/App.tsx?t=171:12:5)'), 'at App (src/App.tsx:12:5)');
  assert.equal(projectPaths('http://localhost:15173/main.js:3:1 and http://x.test/a/b.js'), 'main.js:3:1 and a/b.js');
});

test('listening ports from netstat: local ones only, one per port', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4321',
    '  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4',
    '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4321',
    '  TCP    [::1]:3000             [::]:0                 LISTENING       777',
    '  TCP    [::]:5173              [::]:0                 LISTENING       4321',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(text), [
    { port: 135, pid: 1200 },
    { port: 3000, pid: 777 },
    { port: 5173, pid: 4321 },
  ]);
});

test('requests reach the dev server through the preview, rewritten both ways', async () => {
  const { local } = await open();
  const page = await get(local, '/', {
    Cookie: `${cookie}; theme=dark`,
    'X-Forwarded-Host': `${TAILNET}:15173`,
    'Tailscale-User-Login': 'me@example.com',
    'Sec-Fetch-Dest': 'iframe',
  });
  assert.equal(page.status, 200);
  assert.equal(seen.host, `localhost:${devPort()}`);
  assert.equal(seen.cookie, 'theme=dark', 'the PocketIDE session never reaches the dev server');
  assert.equal(seen['x-forwarded-host'], undefined);
  assert.equal(seen['tailscale-user-login'], undefined);
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.deepEqual(page.headers['content-security-policy'], "default-src 'self', frame-ancestors 'self' http://localhost:* http://127.0.0.1:*");
  assert.deepEqual(page.headers['set-cookie'], ['app=1; Path=/'], 'no Domain=localhost, and no planted PocketIDE cookie');
  assert.match(page.body, /<head><script src="\/__pocketide\/preview\.js"><\/script><title>Dev<\/title>/);
  assert.equal(Number(page.headers['content-length']), Buffer.byteLength(page.body));

  const redirect = await get(local, '/redirect', { Cookie: cookie });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/after?x=1');
  const data = await get(local, '/data.json', { Cookie: cookie });
  assert.equal(data.body, '{"ok":true}', 'non-HTML passes through untouched');
  const script = await get(local, '/__pocketide/preview.js', { Cookie: cookie });
  assert.match(script.body, /__pocketide/);
});

test('WebSockets (HMR) are proxied, with the Origin a dev server expects', async () => {
  const { local } = await open();
  const ws = new WebSocket(`ws://127.0.0.1:${local}/hmr`, { headers: { Cookie: cookie, Origin: `https://${TAILNET}:15173` } });
  const messages: string[] = [];
  ws.on('message', (data) => messages.push(String(data)));
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  ws.send('update');
  await waitFor(() => messages.length >= 2, 'the dev server to answer');
  assert.equal(messages[0], `origin http://localhost:${devPort()} host localhost:${devPort()}`);
  assert.equal(messages[1], 'echo update');
  ws.close();
});

test('only the PocketIDE session gets in, and Open in Safari works once', async () => {
  const { local, port } = await open();
  assert.equal((await get(local, '/')).status, 401);
  assert.equal((await get(local, '/', { Cookie: '__Host-pocketide=forged' })).status, 401);
  assert.equal((await get(local, '/', { Cookie: cookie, Host: 'evil.example:80' })).status, 403, 'DNS rebinding');
  const refused = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${local}/hmr`);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!));
    ws.on('open', () => resolve(101));
  });
  assert.equal(refused, 401);

  const { body } = await api('/api/preview/handoff', 'POST', { port, path: '/about' });
  const first = await get(local, body.path);
  assert.equal(first.status, 200);
  const session = String(first.headers['set-cookie']).split(';')[0];
  assert.match(session, /^__Host-pocketide=/);
  assert.match(first.body, /location\.replace\("\/about"\)/);
  assert.equal((await get(local, '/', { Cookie: session })).status, 200, 'Safari now has a session');
  assert.equal((await get(local, body.path)).status, 401, 'the link works only once');
  const evil = await api('/api/preview/handoff', 'POST', { port, path: '//evil.example/x' });
  assert.match((await get(local, evil.body.path)).body, /location\.replace\("\/"\)/, 'never leaves the preview');
});

test('previews only reach ports on this PC, never PocketIDE itself', async () => {
  const agentPort = (agent.server.address() as AddressInfo).port;
  const { local } = await open();
  for (const port of [0, 70000, 'x', 3.5, agentPort, local]) {
    assert.equal((await api('/api/preview/open', 'POST', { project: 'app', port })).status, 400, `port ${port}`);
  }
  assert.equal((await api('/api/preview/open', 'POST', { project: '..', port: devPort() })).status, 400);
  const anonymous = await agent.call('/api/preview/open', 'POST', { 'Content-Type': 'application/json', Origin: agent.origin }, JSON.stringify({ project: 'app', port: devPort() }));
  assert.equal(anonymous.status, 401);

  // A dev server that only listens on IPv6 localhost is found too.
  const v6: Server = createServer((_req, res) => res.end('six'));
  await new Promise<void>((r) => v6.listen(0, '::1', r));
  const preview = await open((v6.address() as AddressInfo).port);
  assert.equal((await get(preview.local, '/', { Cookie: cookie })).body, 'six');
  v6.close();
});

test("the page's errors go to the Preview console log, with clickable paths", async () => {
  const { local, port } = await open();
  const res = await new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port: local, path: '/__pocketide/console', method: 'POST', headers: { Host: `127.0.0.1:${local}`, Cookie: cookie } }, (r) => resolve(r.statusCode!));
    req.end(JSON.stringify([{ level: 'error', text: `TypeError: x is undefined\n    at App (https://${TAILNET}:15173/src/App.tsx?t=1:12:5)` }, { level: 'warn', text: 'careful' }]));
  });
  assert.equal(res, 204);
  const runs = (await api('/api/runs?project=app')).body.runs as { id: string; kind: string; name: string }[];
  const consoleRun = runs.find((r) => r.kind === 'console' && r.name === `Preview console :${port}`);
  assert.ok(consoleRun, JSON.stringify(runs));
  type Line = { s: string; text: string };
  const lines = (await waitFor(async () => {
    const got = (await api(`/api/runs/log?id=${consoleRun.id}`)).body.lines as Line[];
    return got.length >= 3 && got;
  }, 'the console lines')) as Line[];
  assert.ok(lines.some((l) => l.s === 'err' && l.text.includes('at App (src/App.tsx:12:5)')), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.s === 'out' && l.text === '⚠ careful'));
});

test('tailscale serve entries: added for the phone, removed when the dev server stops and at shutdown', async () => {
  // Someone else's entry on the port the preview would get: it's left alone and the next port is used.
  const other: Server = createServer((_req, res) => res.end('other'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const port = (other.address() as AddressInfo).port;
  setServeState({ '443': { HTTPS: true }, [tailnetPort(port)]: { HTTPS: true, proxy: 'theirs' } });

  const local = await open(port); // from a desktop browser on the PC: nothing is published
  assert.equal(local.ext, null);
  assert.deepEqual(serveState().calls, []);
  const phone = await open(port, TAILNET);
  assert.equal(phone.ext, tailnetPort(port) + 1);
  assert.equal(serveState().TCP[tailnetPort(port) + 1].proxy, `http://127.0.0.1:${phone.local}`);
  assert.equal(serveState().TCP[tailnetPort(port)].proxy, 'theirs');
  const config = () => JSON.parse(readFileSync(join(agent.dir, 'config.json'), 'utf8'));
  assert.deepEqual(config().previewServe, [tailnetPort(port) + 1]);

  // The dev server stops: the preview closes after a while and leaves the tailnet.
  other.close();
  other.closeAllConnections();
  await waitFor(() => !serveState().TCP[tailnetPort(port) + 1], 'the serve entry to be removed');
  await waitFor(() => config().previewServe.length === 0, 'the record to be cleared');
  assert.ok(serveState().TCP['443'] && serveState().TCP[tailnetPort(port)], 'other entries are untouched');

  // Shutdown removes the rest (synchronously, as on Ctrl+C).
  await open(devPort(), TAILNET);
  assert.ok(serveState().TCP[tailnetPort(devPort())]);
  agent.server.shutdown();
  assert.equal(serveState().TCP[tailnetPort(devPort())], undefined);
  assert.ok(serveState().TCP['443']);
  assert.deepEqual(config().previewServe, []);
});

test('entries left behind by a crash are removed at the next start', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pocketide-')));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ previewServe: [23456, 23458, 23459] }));
  setServeState({ '443': { HTTPS: true }, '23456': { HTTPS: true }, '23457': { HTTPS: true }, '23458': { HTTPS: true }, '23459': { HTTPS: true } });
  const app = createApp(createAuth(join(dir, 'auth.json')), createConfig(join(dir, 'config.json')), dir, { tailscale });
  // All of them: the CLI calls run one at a time (at once, they'd overwrite each other's changes).
  await waitFor(() => !serveState().TCP['23456'] && !serveState().TCP['23458'] && !serveState().TCP['23459'], 'the leftovers to be removed');
  assert.ok(serveState().TCP['443'] && serveState().TCP['23457'], 'only what the agent made is removed');
  await waitFor(() => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).previewServe?.length === 0, 'the record to be cleared');
  app.shutdown();
});
