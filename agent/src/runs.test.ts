import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createLog, KEPT_RUNS, listening, MAX_LOG_LINES, type LogLine } from './runs.ts';
import { startAgent } from './testing.ts';

const windowsOnly = { skip: process.platform !== 'win32' };
const agent = await startAgent();
const projects = join(agent.dir, 'projects');
const app = join(projects, 'app');
let cookie = '';

before(async () => {
  cookie = await agent.cookie();
  mkdirSync(app, { recursive: true });
  await api('/api/config', 'PATCH', { projectsRoot: projects });
  const files: Record<string, string> = {
    'hello.js': `console.log('hello \\x1b[32mgreen\\x1b[0m'); console.error('oops');`,
    'fail.js': `console.log('about to fail'); process.exit(3);`,
    // Starts a grandchild, reports both PIDs, and says goodbye on Ctrl+C / Ctrl+Break.
    'tree.js': `const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('pids', process.pid, child.pid);
for (const signal of ['SIGINT', 'SIGBREAK']) process.on(signal, () => { console.log('bye from ' + signal); process.exit(0); });
setInterval(() => {}, 1000);`,
    // Ignores Ctrl+C and Ctrl+Break, so only the forced kill ends it.
    'stubborn.js': `for (const signal of ['SIGINT', 'SIGBREAK']) process.on(signal, () => console.log('ignoring ' + signal));
console.log('pid', process.pid); setInterval(() => {}, 1000);`,
    'server.js': `setTimeout(() => require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening')), 700);`,
    'ask.js': `process.stdout.write('Name: '); process.stdin.once('data', (d) => { console.log('Hello, ' + String(d).trim()); process.exit(0); });`,
    'many.js': `for (let i = 0; i < ${MAX_LOG_LINES + 2000}; i++) console.log('line ' + i);`,
    'ask.c': `#include <stdio.h>\nint main(void) { int n; printf("Number: "); if (scanf("%d", &n) != 1) return 2; printf("twice is %d\\n", 2 * n); return 0; }\n`,
    'broken.c': `int main(void) { return missing; }\n`,
    'ask.py': `name = input('Your name: ')\nprint(f'Hi {name}')\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(app, name), text);
});
after(() => {
  agent.server.stopRuns();
  agent.server.closeAllConnections();
  agent.server.close();
});

async function api(path: string, method = 'GET', body?: object) {
  const res = await agent.call(path, method, { Cookie: cookie, Origin: agent.origin, 'Content-Type': 'application/json' }, body && JSON.stringify(body));
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
}

type RunInfo = { id: string; name: string; status: string; exitCode: number | null; endedAt: number | null };
const writeConfig = (configs: object[]) => writeFileSync(join(app, 'pocketide.json'), JSON.stringify({ configs }));
const start = async (name: string) => {
  const res = await api('/api/runs/start', 'POST', { project: 'app', name });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as RunInfo;
};
const runInfo = async (id: string) => ((await api('/api/runs?project=app')).body.runs as RunInfo[]).find((r) => r.id === id)!;
const log = async (id: string) => (await api(`/api/runs/log?id=${id}`)).body.lines as LogLine[];
// Without colors: FORCE_COLOR makes node color the numbers in console.log.
const text = async (id: string) => (await log(id)).map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
/** Waits until the run's log matches; a timeout shows the log. */
async function logMatch(id: string, re: RegExp, timeout = 15_000): Promise<RegExpExecArray> {
  try {
    return (await waitFor(async () => re.exec(await text(id)), `the log to match ${re}`, timeout))!;
  } catch (err) {
    throw new Error(`${(err as Error).message}; the log:\n${await text(id)}`);
  }
}

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const finished = (id: string): Promise<RunInfo> =>
  waitFor(async () => ((await runInfo(id)).endedAt ? runInfo(id) : null), 'the run to finish', 30_000) as Promise<RunInfo>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the log keeps lines, prompts, progress bars and only the newest lines', () => {
  const changes: LogLine[] = [];
  const log = createLog((line) => changes.push({ ...line }), 5);
  log.write('out', 'Name: ');
  log.write('err', 'warning\n');
  log.write('out', 'Ann\r\nsecond');
  log.write('out', ' line\n10%\r50%\r100%\n');
  assert.deepEqual(log.lines().map((l) => [l.s, l.text]), [
    ['out', 'Name: Ann'],
    ['err', 'warning'],
    ['out', 'second line'],
    ['out', '100%'],
  ]);
  assert.ok(changes.some((c) => c.text === 'Name: '), 'an unfinished prompt is sent right away');
  log.note('in', '42');
  for (let i = 0; i < 600; i++) log.write('out', `n${i}\n`);
  assert.deepEqual(log.lines().map((l) => l.text), ['n595', 'n596', 'n597', 'n598', 'n599']);
  log.clear();
  assert.deepEqual(log.lines(), []);
});

test('runs need a session and stay inside the projects folder', windowsOnly, async () => {
  const anonymous = await agent.call('/api/runs/start', 'POST', { 'Content-Type': 'application/json', Origin: agent.origin }, '{"project":"app","name":"x"}');
  assert.equal(anonymous.status, 401);
  assert.equal((await api('/api/runs/start', 'POST', { project: '..', name: 'x' })).status, 400);
  assert.equal((await api('/api/runs/start', 'POST', { file: 'app/../../auth.json' })).status, 403);
  writeConfig([{ name: 'Out', type: 'task', command: 'node hello.js', cwd: '../..' }]);
  assert.equal((await api('/api/runs/start', 'POST', { project: 'app', name: 'Out' })).status, 400, 'invalid pocketide.json is refused');
  assert.equal((await api('/api/runs/start', 'POST', { project: 'app', name: 'Nope' })).status, 400);
});

test('a task: output, errors and colors are logged, then it exits', windowsOnly, async () => {
  writeConfig([{ name: 'Hello', type: 'task', command: 'node hello.js' }, { name: 'Fail', type: 'task', command: 'node fail.js' }]);
  const ok = await start('Hello');
  const done = await finished(ok.id);
  assert.equal(done.status, 'exited');
  assert.equal(done.exitCode, 0);
  const lines = await log(ok.id);
  assert.ok(lines.some((l) => l.s === 'out' && l.text === 'hello \x1b[32mgreen\x1b[0m'), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.s === 'err' && l.text === 'oops'));
  assert.match(lines.at(-1)!.text, /Exited with code 0/);

  const bad = await finished((await start('Fail')).id);
  assert.equal(bad.status, 'crashed');
  assert.equal(bad.exitCode, 3);
});

test('Stop ends the whole process tree, gracefully when the program allows it', windowsOnly, async () => {
  writeConfig([
    { name: 'Tree', type: 'task', command: 'node tree.js' },
    { name: 'Stubborn', type: 'task', command: 'node stubborn.js' },
  ]);
  const run = await start('Tree');
  const [, parent, child] = (await logMatch(run.id, /pids (\d+) (\d+)/)).map(Number);
  assert.ok(alive(parent) && alive(child));
  const stopped = (await api('/api/runs/stop', 'POST', { id: run.id })).body as RunInfo;
  assert.equal(stopped.status, 'exited');
  assert.match(await text(run.id), /bye from SIG(INT|BREAK)/, 'it got Ctrl+C or Ctrl+Break first');
  await waitFor(() => !alive(parent) && !alive(child), 'both processes to end', 5000);

  const stubborn = await start('Stubborn');
  const pid = Number((await logMatch(stubborn.id, /pid (\d+)/))[1]);
  await api('/api/runs/stop', 'POST', { id: stubborn.id });
  await waitFor(() => !alive(pid), 'the forced kill', 5000);
  assert.match(await text(stubborn.id), /Stopped after/);
});

test('a web configuration is ready once its port listens', windowsOnly, async () => {
  const port = await freePort();
  writeConfig([{ name: 'Web', type: 'web', command: 'node server.js', port, env: { PORT: String(port) } }]);
  const run = await start('Web');
  assert.equal((await runInfo(run.id)).status, 'starting');
  await waitFor(async () => (await runInfo(run.id)).status === 'ready', 'ready');
  assert.ok(await listening(port));
  await api('/api/runs/stop', 'POST', { id: run.id });
  assert.equal(await listening(port), false);
});

test('input goes to the program, and the log is kept and bounded', windowsOnly, async () => {
  writeConfig([
    { name: 'Ask', type: 'task', command: 'node ask.js' },
    { name: 'Many', type: 'task', command: 'node many.js' },
    { name: 'Hello', type: 'task', command: 'node hello.js' },
  ]);
  const ask = await start('Ask');
  await logMatch(ask.id, /Name: /);
  assert.equal((await api('/api/runs/input', 'POST', { id: ask.id, text: 'Ann' })).status, 200);
  await finished(ask.id);
  const lines = await log(ask.id);
  assert.ok(lines.some((l) => l.s === 'in' && l.text === 'Ann'));
  assert.ok(lines.some((l) => l.text === 'Hello, Ann'));

  const many = await start('Many');
  await finished(many.id);
  const kept = await log(many.id);
  assert.equal(kept.length, MAX_LOG_LINES);
  assert.equal(kept.at(-2)!.text, `line ${MAX_LOG_LINES + 1999}`);

  // Only the newest finished runs of a configuration stay.
  const first = await finished((await start('Hello')).id);
  for (let i = 0; i < KEPT_RUNS; i++) await finished((await start('Hello')).id);
  const runs = (await api('/api/runs?project=app')).body.runs as RunInfo[];
  assert.equal(runs.filter((r) => r.name === 'Hello').length, KEPT_RUNS);
  assert.equal(runs.some((r) => r.id === first.id), false, 'the oldest run was dropped');
});

test('the log streams to a watching socket, and Clear empties it', windowsOnly, async () => {
  writeConfig([{ name: 'Ask', type: 'task', command: 'node ask.js' }]);
  const run = await start('Ask');
  const ws = agent.socket({ Cookie: cookie, Origin: agent.origin });
  const got: { lines: LogLine[]; clear?: boolean }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'log' && msg.id === run.id) got.push(msg);
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'log', id: run.id }));
  await logMatch(run.id, /Name: /);
  await api('/api/runs/input', 'POST', { id: run.id, text: 'Bo' });
  await waitFor(() => got.some((m) => m.lines.some((l) => l.text === 'Hello, Bo')), 'the live line');
  await api('/api/runs/clear', 'POST', { id: run.id });
  await waitFor(() => got.some((m) => m.clear), 'the clear message');
  assert.deepEqual(await log(run.id), []);
  ws.close();
});

test('Run current file: a C program that reads input, and a compiler error', { skip: process.platform !== 'win32' || !hasGcc() }, async () => {
  const run = (await api('/api/runs/start', 'POST', { file: 'app/ask.c' })).body as RunInfo;
  await logMatch(run.id, /Number: /, 30_000);
  await api('/api/runs/input', 'POST', { id: run.id, text: '21' });
  assert.equal((await finished(run.id)).exitCode, 0);
  assert.match(await text(run.id), /twice is 42/);

  const broken = await finished(((await api('/api/runs/start', 'POST', { file: 'app/broken.c' })).body as RunInfo).id);
  assert.equal(broken.status, 'crashed');
  assert.match(await text(broken.id), /broken\.c:1:\d+:.*error/);
  const missing = await api('/api/runs/start', 'POST', { file: 'app/hello.txt' });
  assert.equal(missing.status, 404);
});

test('Run current file: a Python program that reads input', { skip: process.platform !== 'win32' || !has('py') }, async () => {
  const run = (await api('/api/runs/start', 'POST', { file: 'app/ask.py' })).body as RunInfo;
  await logMatch(run.id, /Your name: /, 30_000);
  await api('/api/runs/input', 'POST', { id: run.id, text: 'Ann' });
  assert.equal((await finished(run.id)).exitCode, 0);
  assert.match(await text(run.id), /Hi Ann/);
});

function hasGcc() {
  return has('gcc');
}

function has(tool: string) {
  try {
    execFileSync('where', [tool], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
