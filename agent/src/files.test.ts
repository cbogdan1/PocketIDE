import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findInRecycleBin, purgeFromRecycleBin, startAgent } from './testing.ts';

const agent = await startAgent();
after(() => agent.server.close());
const projects = join(agent.dir, 'projects');
const outside = join(agent.dir, 'outside');
let cookie = '';

/** An authenticated same-origin request; objects are sent as JSON. */
function api(path: string, method = 'GET', body?: object | string | Buffer, headers: Record<string, string> = {}) {
  const isJson = body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body);
  return agent.call(
    path,
    method,
    { Cookie: cookie, Origin: agent.origin, ...(isJson && { 'Content-Type': 'application/json' }), ...headers },
    isJson ? JSON.stringify(body) : body,
  );
}
const q = (path: string) => encodeURIComponent(path);

before(async () => {
  cookie = await agent.cookie();
  for (const name of ['app', 'app10', 'app2', '.hidden']) mkdirSync(join(projects, name), { recursive: true });
  mkdirSync(join(projects, 'app', 'src'));
  mkdirSync(join(projects, 'app', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(projects, 'app', 'src', 'main.ts'), 'console.log(1);\n');
  writeFileSync(join(projects, 'app', 'node_modules', 'dep', 'index.js'), '');
  writeFileSync(join(projects, 'app', 'file10.txt'), '');
  writeFileSync(join(projects, 'app', 'file2.txt'), '');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(projects, 'app', 'escape'), 'junction');
});

test('every file endpoint needs a session', async () => {
  const routes = ['GET /api/config', 'PATCH /api/config', 'GET /api/projects', 'GET /api/fs/list', 'GET /api/fs/files',
    'GET /api/fs/file', 'PUT /api/fs/file', 'POST /api/fs/mkdir', 'POST /api/fs/rename', 'POST /api/fs/delete'];
  for (const route of routes) {
    const [method, path] = route.split(' ');
    assert.equal((await agent.call(`${path}?path=app`, method, { Origin: agent.origin })).status, 401, route);
  }
});

test('the projects root must be an existing folder; projects list in natural order', async () => {
  assert.equal((await api('/api/projects')).status, 409, 'no root yet');
  assert.equal((await api('/api/config', 'PATCH', { projectsRoot: 'projects' })).status, 400, 'relative');
  assert.equal((await api('/api/config', 'PATCH', { projectsRoot: join(agent.dir, 'nope') })).status, 400, 'missing');
  const set = await api('/api/config', 'PATCH', { projectsRoot: projects });
  assert.equal(set.status, 200);
  assert.equal(JSON.parse(set.body).projectsRoot, projects);
  assert.deepEqual(JSON.parse((await api('/api/projects')).body).projects, ['app', 'app2', 'app10']);

  await api('/api/config', 'PATCH', { lastProject: 'app', openFiles: { app: { paths: ['app/src/main.ts'], active: 'app/src/main.ts' } } });
  const config = JSON.parse((await api('/api/config')).body);
  assert.equal(config.lastProject, 'app');
  assert.deepEqual(config.openFiles.app.paths, ['app/src/main.ts']);
  assert.equal((await api('/api/config', 'PATCH', { openFiles: { app: { paths: 'x' } } })).status, 400);
});

test('lists folders first in natural order, and quick-open skips hidden folders', async () => {
  const list = JSON.parse((await api(`/api/fs/list?path=app`)).body).entries;
  assert.deepEqual(
    list.map((e: { name: string; dir: boolean }) => `${e.dir ? 'd' : 'f'}:${e.name}`),
    ['d:escape', 'd:node_modules', 'd:src', 'f:file2.txt', 'f:file10.txt'],
  );
  const files = JSON.parse((await api('/api/fs/files?path=app')).body).files;
  assert.deepEqual(files.sort(), ['file10.txt', 'file2.txt', 'src/main.ts'], 'no node_modules, no walking into links');
  const all = JSON.parse((await api('/api/fs/files?path=app&all=1')).body).files;
  assert.ok(all.includes('node_modules/dep/index.js'));
});

test('reads text with an ETag; refuses binary and oversized files', async () => {
  const read = await api(`/api/fs/file?path=${q('app/src/main.ts')}`);
  assert.equal(read.status, 200);
  assert.equal(read.body, 'console.log(1);\n');
  const etag = read.headers.etag!;
  assert.equal((await api(`/api/fs/file?path=${q('app/src/main.ts')}`, 'GET', undefined, { 'If-None-Match': etag })).status, 304);

  writeFileSync(join(projects, 'app', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(projects, 'app', 'latin1.txt'), Buffer.from('caf\xe9', 'latin1'));
  writeFileSync(join(projects, 'app', 'big.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
  assert.equal((await api(`/api/fs/file?path=${q('app/logo.png')}`)).status, 415);
  assert.equal((await api(`/api/fs/file?path=${q('app/latin1.txt')}`)).status, 415, 'not UTF-8: saving would corrupt it');
  const big = await api(`/api/fs/file?path=${q('app/big.log')}`);
  assert.equal(big.status, 413);
  assert.match(JSON.parse(big.body).error, /2\.0 MB/);
});

test('saving detects changes on disk and never overwrites them', async () => {
  const path = `/api/fs/file?path=${q('app/src/main.ts')}`;
  const file = join(projects, 'app', 'src', 'main.ts');
  const opened = (await api(path)).headers.etag!;

  writeFileSync(file, 'edited in the terminal\n'); // someone else saves first
  const stale = await api(path, 'PUT', 'my version\n', { 'If-Match': opened });
  assert.equal(stale.status, 412);
  assert.equal(readFileSync(file, 'utf8'), 'edited in the terminal\n', 'their change survives');

  const current = (await api(path)).headers.etag!;
  const saved = await api(path, 'PUT', 'my version\n', { 'If-Match': current });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(file, 'utf8'), 'my version\n');
  assert.equal(JSON.parse(saved.body).etag, (await api(path)).headers.etag, 'the save returns the new ETag');

  assert.equal((await api(path, 'PUT', 'blind write\n')).status, 428, 'no precondition, no write');
  assert.equal((await api(path, 'PUT', 'x', { 'If-None-Match': '*' })).status, 409, 'create refuses to replace');
  assert.equal((await api(path, 'PUT', Buffer.alloc(2 * 1024 * 1024 + 1), { 'If-Match': current })).status, 413);

  rmSync(file);
  const gone = await api(path, 'PUT', 'my version\n', { 'If-Match': JSON.parse(saved.body).etag });
  assert.equal(gone.status, 412, 'deleted on disk counts as changed');
  assert.equal(existsSync(file), false);
  assert.equal((await api(path, 'PUT', 'recreated\n', { 'If-None-Match': '*' })).status, 200);
  assert.equal(readFileSync(file, 'utf8'), 'recreated\n');
});

test('creates folders, renames, and deletes to the Recycle Bin', { skip: process.platform !== 'win32' }, async (t) => {
  assert.equal((await api('/api/fs/mkdir', 'POST', { path: 'app/lib' })).status, 200);
  assert.equal((await api('/api/fs/mkdir', 'POST', { path: 'app/lib' })).status, 409);
  assert.equal((await api('/api/fs/mkdir', 'POST', { path: 'app/con' })).status, 400, 'reserved device name');
  assert.equal((await api('/api/fs/mkdir', 'POST', { path: 'app/what?' })).status, 400);

  writeFileSync(join(projects, 'app', 'lib', 'a.ts'), 'a');
  writeFileSync(join(projects, 'app', 'lib', 'b.ts'), 'b');
  assert.equal((await api('/api/fs/rename', 'POST', { from: 'app/lib/a.ts', to: 'app/lib/b.ts' })).status, 409, 'never replaces');
  assert.equal(readFileSync(join(projects, 'app', 'lib', 'b.ts'), 'utf8'), 'b');
  assert.equal((await api('/api/fs/rename', 'POST', { from: 'app/lib/a.ts', to: 'app/lib/A.ts' })).status, 200, 'case-only');
  assert.equal((await api('/api/fs/rename', 'POST', { from: 'app/lib/A.ts', to: 'app/lib/c.ts' })).status, 200);
  assert.equal(readFileSync(join(projects, 'app', 'lib', 'c.ts'), 'utf8'), 'a');

  const doomed = join(projects, 'app', 'lib', 'c.ts');
  t.after(() => purgeFromRecycleBin(findInRecycleBin(doomed)));
  assert.equal((await api('/api/fs/delete', 'POST', { path: 'app/lib/c.ts' })).status, 200);
  assert.equal(existsSync(doomed), false);
  assert.equal(findInRecycleBin(doomed).length, 1, 'it went to the Recycle Bin');
  assert.equal((await api('/api/fs/delete', 'POST', { path: 'app/lib/c.ts' })).status, 404);
  assert.equal((await api('/api/fs/delete', 'POST', { path: '' })).status, 400, 'not the projects root');
});

test('blocks traversal and junction escapes on every endpoint', async () => {
  const blocked = [
    ['GET', '/api/fs/list?path=app/escape'],
    ['GET', `/api/fs/file?path=${q('app/escape/secret.txt')}`],
    ['GET', `/api/fs/file?path=${q('../outside/secret.txt')}`],
    ['GET', `/api/fs/file?path=${q('app/..\\..\\outside\\secret.txt')}`],
    ['GET', `/api/fs/file?path=${q(join(outside, 'secret.txt'))}`],
    ['GET', '/api/fs/files?path=app/escape'],
    ['PUT', `/api/fs/file?path=${q('app/escape/secret.txt')}`],
    ['PUT', `/api/fs/file?path=${q('app/escape/new.txt')}`],
  ];
  for (const [method, path] of blocked) {
    const res = await api(path, method, method === 'PUT' ? 'pwned' : undefined, { 'If-None-Match': '*' });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  for (const [path, body] of [
    ['/api/fs/mkdir', { path: 'app/escape/x' }],
    ['/api/fs/rename', { from: 'app/src/main.ts', to: '../outside/main.ts' }],
    ['/api/fs/rename', { from: 'app/escape/secret.txt', to: 'app/secret.txt' }],
    ['/api/fs/delete', { path: 'app/escape' }],
    ['/api/fs/delete', { path: 'app/escape/secret.txt' }],
  ] as const) {
    assert.equal((await api(path, 'POST', body)).status, 403, `${path} ${JSON.stringify(body)}`);
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
  assert.equal(existsSync(join(outside, 'new.txt')), false);
  assert.equal(existsSync(join(outside, 'x')), false);
});

test('pushes file changes to sockets watching the project', async () => {
  const ws = agent.socket({ Cookie: cookie, Origin: agent.origin });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'watch', project: 'app' }));
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the watcher start

  const message = new Promise<{ type: string; project: string; paths: string[] | null }>((resolve) =>
    ws.on('message', (data) => resolve(JSON.parse(String(data)))),
  );
  writeFileSync(join(projects, 'app', 'src', 'new.ts'), 'export {};\n');
  const msg = await message;
  ws.close();
  assert.equal(msg.type, 'fs');
  assert.equal(msg.project, 'app');
  assert.ok(msg.paths === null || msg.paths.includes('app/src/new.ts'), JSON.stringify(msg.paths));
});
