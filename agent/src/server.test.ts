import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createAuth } from './auth.ts';
import { createApp } from './server.ts';

const dir = mkdtempSync(join(tmpdir(), 'pocketide-'));
mkdirSync(join(dir, 'static'));
writeFileSync(join(dir, 'static', 'index.html'), '<h1>PocketIDE</h1>');
const auth = createAuth(join(dir, 'auth.json')); // sits next to static/, so traversal would expose it
const server = createApp(auth, join(dir, 'static'));
let port = 0;
let origin = '';

before(async () => {
  await auth.setPassword('correct horse');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
after(() => server.close());

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // Options form sends `path` verbatim (a URL string would normalize away the `..`).
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const login = (password: string, headers: Record<string, string> = {}) =>
  call('/api/login', 'POST', { 'Content-Type': 'application/json', Origin: origin, ...headers }, JSON.stringify({ password }));

/** Resolves with 101 if the upgrade succeeded, else the HTTP status of the refusal. */
function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws/events`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      resolve(res.statusCode!);
    });
    ws.on('error', () => {});
  });
}

test('serves the app shell but not files outside it', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /PocketIDE/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  for (const path of ['/../auth.json', '/..%2fauth.json', '/..%5cauth.json', '/%2e%2e/auth.json', '/CON']) {
    assert.equal((await call(path)).status, 404, path);
  }
});

test('rejects foreign Host headers (DNS rebinding) and cross-origin writes', async () => {
  assert.equal((await call('/', 'GET', { Host: 'attacker.example' })).status, 403);
  assert.equal((await call('/', 'GET', { Host: 'pc.tail1234.ts.net' })).status, 200);
  assert.equal((await login('correct horse', { Origin: 'https://attacker.example' })).status, 403);
});

test('login, session, websocket auth, logout', async () => {
  assert.equal((await call('/api/session')).status, 401);
  assert.equal((await login('wrong horse')).status, 401);

  const ok = await login('correct horse');
  assert.equal(ok.status, 200);
  const setCookie = ok.headers['set-cookie']![0];
  assert.match(setCookie, /^__Host-pocketide=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  const cookie = setCookie.split(';')[0];

  assert.equal((await call('/api/session', 'GET', { Cookie: cookie })).status, 200);
  assert.equal(await upgrade({}), 401);
  assert.equal(await upgrade({ Cookie: cookie, Origin: 'https://attacker.example' }), 403);
  assert.equal(await upgrade({ Cookie: cookie, Origin: origin }), 101);

  assert.equal((await call('/api/logout', 'POST', { Cookie: cookie, Origin: origin })).status, 200);
  assert.equal((await call('/api/session', 'GET', { Cookie: cookie })).status, 401);
  assert.equal(await upgrade({ Cookie: cookie, Origin: origin }), 401);
});

test('locks a client out after 5 failed logins', async () => {
  const client = { 'X-Forwarded-For': '100.64.0.7' };
  for (let i = 0; i < 5; i++) assert.equal((await login('nope', client)).status, 401);
  const blocked = await login('correct horse', client);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await login('correct horse', { 'X-Forwarded-For': '100.64.0.8' })).status, 200);
});
