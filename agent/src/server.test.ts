import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startAgent } from './testing.ts';

const agent = await startAgent();
const { call, login, origin } = agent;
after(() => agent.server.close());

/** Resolves with 101 if the upgrade succeeded, else the HTTP status of the refusal. */
function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = agent.socket(headers);
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
