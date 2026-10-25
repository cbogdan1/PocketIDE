import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import headless from '@xterm/headless';
import { applyMessage, keepScrolledLines } from '../../client/src/lib/termProtocol.ts';
import { startAgent } from './testing.ts';

// Terminals need ConPTY.
const windowsOnly = { skip: process.platform !== 'win32' };

const agent = await startAgent();
const projects = join(agent.dir, 'projects');
let cookie = '';

before(async () => {
  cookie = await agent.cookie();
  mkdirSync(join(projects, 'app'), { recursive: true });
  await api('/api/config', 'PATCH', { projectsRoot: projects });
  // A small full-screen program: colors, box drawing and absolute cursor moves, then it waits.
  writeFileSync(
    join(projects, 'app', 'tui.js'),
    `process.stdout.write('\\x1b[2J\\x1b[H\\x1b[1;44m TITLE \\x1b[0m\\x1b[5;10H\\x1b[32m╭────╮\\x1b[6;10H│ hé │\\x1b[7;10H╰────╯\\x1b[0m\\x1b[9;1Hready');
setInterval(() => {}, 1e9);`,
  );
  // Reads raw keystrokes until it has the expected number of characters, then prints their hash.
  writeFileSync(
    join(projects, 'app', 'count.js'),
    `const want = Number(process.argv[2]); let got = '';
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { got += d; if (got.length >= want) { console.log('got', got.length, require('crypto').createHash('sha1').update(got).digest('hex')); process.exit(0); } });`,
  );
});
after(async () => {
  for (const t of await list()) await api('/api/terminals/close', 'POST', { id: t.id });
  agent.server.closeAllConnections();
  agent.server.close();
});

async function api(path: string, method = 'GET', body?: object) {
  const res = await agent.call(path, method, { Cookie: cookie, Origin: agent.origin, 'Content-Type': 'application/json' }, body && JSON.stringify(body));
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
}

const newTerminal = async (extra: object = {}) => (await api('/api/terminals', 'POST', { cwd: 'app', shell: 'cmd', ...extra })).body;
const list = async () =>
  (await api('/api/terminals')).body.terminals as { id: string; running: boolean; exitCode: number | null; cols: number; rows: number }[];

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A stand-in for the phone: an xterm that follows the agent with the app's own code (termProtocol.ts). */
async function attach(id: string, cols: number, rows: number, { ack = true } = {}) {
  const ws = agent.socket({ Cookie: cookie, Origin: agent.origin }, `/ws/terminal?id=${id}&cols=${cols}&rows=${rows}`);
  const term = new headless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  keepScrolledLines(term);
  const phone = { ws, term, restores: 0, received: 0, lastMessage: Date.now(), exitCode: null as number | null, ack };
  ws.on('message', (data, isBinary) => {
    phone.lastMessage = Date.now();
    if (isBinary) phone.received += (data as Buffer).length;
    const msg = applyMessage(term, isBinary ? (data as Buffer) : String(data), (n) => phone.ack && ws.send(JSON.stringify({ t: 'ack', n })));
    if (msg?.t === 'restore') phone.restores++;
    else if (msg?.t === 'exit') phone.exitCode = msg.code ?? null;
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return phone;
}

type Phone = Awaited<ReturnType<typeof attach>>;

/** The visible screen as text; after the xterm has parsed everything received so far. */
async function screen(phone: Phone): Promise<string> {
  await new Promise<void>((r) => phone.term.write('', r));
  const buf = phone.term.buffer.active;
  const lines: string[] = [];
  // ConPTY pads some lines with real spaces.
  for (let i = 0; i < phone.term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)!.translateToString(true).trimEnd());
  return lines.join('\n');
}

const type = (phone: Phone, text: string) => phone.ws.send(Buffer.from(text));
const propose = (phone: Phone, cols: number, rows: number) => phone.ws.send(JSON.stringify({ t: 'resize', cols, rows }));

/** Waits until the agent has been quiet for a moment and everything received is parsed. */
async function settle(phone: Phone) {
  await waitFor(() => Date.now() - phone.lastMessage > 600, 'output to settle');
  await new Promise<void>((r) => phone.term.write('', r));
}

/** Every line (history and screen) as far as it's visible, the cursor and where the screen starts. */
function dump(term: Phone['term']) {
  const b = term.buffer.active;
  const lines: string[] = [];
  // Cells past the right edge (left from a wider size) can't be seen; a widening resyncs every client anyway.
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true, 0, term.cols).trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return { size: `${term.cols}x${term.rows}`, lines, cursor: `${b.cursorX},${b.baseY + b.cursorY}`, base: b.baseY };
}

/** The phone must match a fresh client of the agent's mirror (attached at the current size) line for line. */
async function assertMatchesMirror(phone: Phone, id: string, when: string) {
  await settle(phone);
  const { cols, rows } = (await list()).find((t) => t.id === id)!;
  const observer = await attach(id, cols, rows);
  await waitFor(() => observer.restores === 1, 'the observer to restore');
  await settle(observer);
  const [mine, mirror] = [dump(phone.term), dump(observer.term)];
  await close(observer);
  if (JSON.stringify(mine) === JSON.stringify(mirror)) return;
  const diff = mine.lines
    .map((line, i) => (line === mirror.lines[i] ? '' : `  line ${i}: phone ${JSON.stringify(line)} / mirror ${JSON.stringify(mirror.lines[i])}`))
    .filter(Boolean);
  assert.fail(`${when}: the phone differs from the mirror (${mine.size} vs ${mirror.size}, cursor ${mine.cursor} vs ${mirror.cursor})\n${diff.slice(0, 8).join('\n')}`);
}
const close = (phone: Phone) =>
  new Promise((r) => {
    if (phone.ws.readyState === phone.ws.CLOSED) return r(undefined); // e.g. the agent removed the terminal
    phone.ws.once('close', r);
    phone.ws.close();
  });

function upgrade(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = agent.socket(headers, path);
    ws.on('open', () => (ws.close(), resolve(101)));
    ws.on('unexpected-response', (req, res) => (req.destroy(), resolve(res.statusCode!)));
    ws.on('error', () => {});
  });
}

test('terminal sockets need a session, pass the Host/Origin checks and cap message size', windowsOnly, async () => {
  const { id } = await newTerminal();
  const path = `/ws/terminal?id=${id}&cols=80&rows=24`;
  assert.equal(await upgrade(path, { Origin: agent.origin }), 401);
  assert.equal(await upgrade(path, { Cookie: cookie, Origin: 'https://attacker.example' }), 403);
  assert.equal(await upgrade(path, { Cookie: cookie, Origin: agent.origin, Host: 'attacker.example' }), 403);
  assert.equal(await upgrade('/ws/terminal?id=nope', { Cookie: cookie, Origin: agent.origin }), 404);
  assert.equal(await upgrade(path, { Cookie: cookie, Origin: agent.origin }), 101);
  assert.equal((await agent.call('/api/terminals', 'POST', { Origin: agent.origin }, '{}')).status, 401);

  const phone = await attach(id, 80, 24);
  const closed = new Promise<number>((r) => phone.ws.once('close', r));
  phone.ws.send(Buffer.alloc(65 * 1024, 'a')); // over the 64 KB message limit
  assert.equal(await closed, 1009);
  await api('/api/terminals/close', 'POST', { id });
});

test('a terminal keeps running while detached and restores its screen on re-attach', windowsOnly, async () => {
  const { id } = await newTerminal();
  const first = await attach(id, 60, 15);
  await waitFor(async () => (await screen(first)).includes('>'), 'the prompt');
  type(first, 'echo before-detach & ping -n 3 127.0.0.1 >nul & echo after-detach\r');
  await waitFor(async () => (await screen(first)).includes('before-detach\n'), 'output while attached');
  await close(first);

  await new Promise((r) => setTimeout(r, 3000)); // "after-detach" is printed while nobody is attached
  const second = await attach(id, 60, 15);
  await waitFor(async () => (await screen(second)).includes('after-detach\n'), 'output produced while detached');
  assert.equal(second.restores, 1, 'starts from a snapshot, not a replay');

  // A full-screen program: the restored screen must match cell for cell, colors included.
  type(second, 'node tui.js\r');
  await waitFor(async () => (await screen(second)).includes('ready'), 'the full-screen program');
  const expected = await screen(second);
  await close(second);
  const third = await attach(id, 60, 15);
  await waitFor(async () => (await screen(third)).includes('ready'), 'the restored program');
  assert.equal(await screen(third), expected);
  assert.match(expected, /^ TITLE/);
  assert.equal(expected.split('\n')[5].slice(9, 15), '│ hé │');
  const cell = third.term.buffer.active.getLine(third.term.buffer.active.viewportY + 4)!.getCell(9)!;
  assert.ok(cell.isFgPalette() && cell.getFgColor() === 2, 'the green box stays green');
  await api('/api/terminals/close', 'POST', { id });
  await close(third);
});

test('the most recently active client sets the size', windowsOnly, async () => {
  const { id } = await newTerminal();
  const pc = await attach(id, 100, 30);
  const phone = await attach(id, 45, 20);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(pc, 'mode con | findstr Columns\r'); // typing makes the PC the active client
  await waitFor(async () => /Columns:\s+100/.test(await screen(pc)), 'the PC size');
  phone.ws.send(JSON.stringify({ t: 'resize', cols: 45, rows: 20 })); // e.g. the iOS keyboard opened
  type(phone, 'cls & mode con | findstr Columns\r');
  await waitFor(async () => /Columns:\s+45/.test(await screen(phone)), 'the phone size');
  await Promise.all([close(pc), close(phone)]);
  await api('/api/terminals/close', 'POST', { id });
});

test('large pastes arrive intact when split into messages under the limit', windowsOnly, async () => {
  const { id } = await newTerminal();
  const phone = await attach(id, 80, 24);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  const size = 150_000;
  type(phone, `node count.js ${size}\r`);
  await new Promise((r) => setTimeout(r, 1500)); // let node start and switch to raw mode
  const paste = Array.from({ length: size }, (_, i) => 'abcdefghij'[i % 10]).join('');
  for (let i = 0; i < size; i += 48_000) type(phone, paste.slice(i, i + 48_000));
  const hash = createHash('sha1').update(paste).digest('hex');
  await waitFor(async () => (await screen(phone)).includes(`got ${size} ${hash}`), 'the whole paste', 30_000);
  await close(phone);
  await api('/api/terminals/close', 'POST', { id });
});

test('a client that stops keeping up gets a fresh snapshot instead of the backlog', windowsOnly, async () => {
  const { id } = await newTerminal();
  const phone = await attach(id, 80, 24, { ack: false });
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(phone, 'node -e "for (let i = 0; i < 60000; i++) console.log(i + \' \' + \'x\'.repeat(70))"\r');
  await waitFor(() => phone.received > 1 << 20, 'over 1 MB of output', 30_000);
  await new Promise((r) => setTimeout(r, 1000));
  const capped = phone.received;
  assert.ok(capped < 2 << 20, `output stops once the client is far behind (got ${capped})`);
  phone.ack = true;
  phone.ws.send(JSON.stringify({ t: 'ack', n: capped })); // it caught up
  await waitFor(() => phone.restores === 2, 'a resync snapshot');
  await waitFor(async () => (await screen(phone)).includes('59999 xxx'), 'the latest output');
  await close(phone);
  await api('/api/terminals/close', 'POST', { id });
});

test('exited terminals report their exit code and leave nothing running', windowsOnly, async () => {
  const hosts = () =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} and Name='OpenConsole.exe'").Count`]).toString().trim();
  // node-pty's reader thread shows up as a MessagePort in this process.
  const readers = () => process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
  // The terminals of earlier tests are all closed by now, and closing must have released theirs too.
  await waitFor(() => hosts() === '0', 'earlier terminals to release their console hosts', 10_000);
  const readersBefore = readers();
  const { id } = await newTerminal();
  await waitFor(() => hosts() === '1', 'this terminal\'s console host', 10_000);
  const phone = await attach(id, 80, 24);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(phone, 'exit 3\r');
  await waitFor(() => phone.exitCode === 3, 'the exit message');
  await waitFor(async () => (await screen(phone)).includes('[Process exited with code 3]'), 'the exit line');
  const info = (await list()).find((t) => t.id === id)!;
  assert.deepEqual([info.running, info.exitCode], [false, 3]);
  await waitFor(() => hosts() === '0', 'OpenConsole.exe to go away', 5000);
  await waitFor(() => readers() <= readersBefore, 'the reader thread to be released', 5000);
  await close(phone);
  await api('/api/terminals/close', 'POST', { id });
});

test('closing a terminal ends its whole process tree', windowsOnly, async () => {
  const pings = () => (execFileSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/NH']).toString().match(/PING\.EXE/gi) ?? []).length;
  const before = pings();
  const { id } = await newTerminal();
  const phone = await attach(id, 80, 24);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(phone, 'start /b ping -t 127.0.0.1 >nul\r'); // a background child the shell doesn't wait for
  await waitFor(() => pings() === before + 1, 'the background ping');
  const gone = new Promise<number>((r) => phone.ws.once('close', r));
  await api('/api/terminals/close', 'POST', { id });
  assert.equal(await gone, 4404, 'attached clients are told the terminal is gone');
  await waitFor(() => pings() === before, 'the background ping to be killed', 5000);
  assert.equal((await list()).some((t) => t.id === id), false);
});

test('the phone always shows exactly what the mirror has: keyboard, rotation, another device, re-attach', windowsOnly, async () => {
  const { id } = await newTerminal();
  let phone = await attach(id, 50, 40);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(phone, 'for /L %i in (1,1,60) do @echo line %i\r');
  await waitFor(async () => (await screen(phone)).includes('line 60'), 'the output');
  const history = () => dump(phone.term).lines.filter((line) => /^line \d+$/.test(line));
  const all60 = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);

  // The iOS keyboard opens (fewer rows), something is typed, and it closes again.
  propose(phone, 50, 16);
  type(phone, 'echo keyboard-open\r');
  await waitFor(async () => (await screen(phone)).includes('keyboard-open\n'), 'output with the keyboard open');
  propose(phone, 50, 40);
  await assertMatchesMirror(phone, id, 'after the keyboard opened and closed');
  assert.deepEqual(history(), all60, 'growing the screen must not lose history');

  // Rotation to landscape and back, with a line too long for portrait; then landscape once more, which
  // brings the cut-off end of that line back into view.
  propose(phone, 110, 14);
  type(phone, `echo landscape-${'x'.repeat(70)}\r`);
  await waitFor(async () => (await screen(phone)).includes('xxxxx\n'), 'output in landscape');
  propose(phone, 50, 40);
  await assertMatchesMirror(phone, id, 'after rotating back to portrait');
  assert.deepEqual(history(), all60, 'rotating must not lose history');
  propose(phone, 110, 14);
  await assertMatchesMirror(phone, id, 'after rotating to landscape again');
  propose(phone, 50, 40);
  await assertMatchesMirror(phone, id, 'back in portrait');

  // A desktop browser takes over while it types, then leaves; the phone follows, then gets the size back.
  const pc = await attach(id, 150, 45);
  type(pc, 'echo from-the-pc\r');
  await waitFor(() => phone.term.cols === 150 && phone.term.rows === 45, 'the phone to follow the PC size');
  await waitFor(async () => (await screen(phone)).includes('from-the-pc\n'), 'the PC command on the phone');
  await assertMatchesMirror(phone, id, 'while the PC sets the size');
  await close(pc);
  await waitFor(() => phone.term.cols === 50 && phone.term.rows === 40, 'the size to return to the phone');
  type(phone, 'echo phone-again\r');
  await waitFor(async () => (await screen(phone)).includes('phone-again\n'), 'typing on the phone again');
  await assertMatchesMirror(phone, id, 'after the PC left');

  // Away and back (re-attach): the same screen, and still the same history.
  await close(phone);
  phone = await attach(id, 50, 40);
  await assertMatchesMirror(phone, id, 'after re-attaching');
  assert.deepEqual(history(), all60);
  await close(phone);
  await api('/api/terminals/close', 'POST', { id });
});

test('lines scrolled off by Enter in the last row stay in the history', windowsOnly, async () => {
  const { id } = await newTerminal({ shell: 'powershell' });
  const phone = await attach(id, 100, 12);
  await waitFor(async () => /PS .*>/.test(await screen(phone)), 'the prompt', 20_000);
  type(phone, '1..20 | % { "line $_" }\r');
  await waitFor(async () => (await screen(phone)).includes('line 20\n'), 'the lines');
  // Every command now starts in the last row, where ConPTY scrolls with CSI S on Enter.
  for (const word of ['one', 'two', 'three', 'four']) {
    type(phone, `echo ${word}\r`);
    await waitFor(async () => (await screen(phone)).includes(`\n${word}\n`), `the output of echo ${word}`);
  }
  await settle(phone);
  const numbered = dump(phone.term).lines.filter((line) => /^line \d+$/.test(line));
  assert.deepEqual(numbered, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
  await assertMatchesMirror(phone, id, 'after the commands');
  await close(phone);
  await api('/api/terminals/close', 'POST', { id });
});

test('clear and cls also clear the history, and so does Clear terminal', windowsOnly, async () => {
  const cases = [
    { shell: 'powershell', print: '1..80 | % { "row $_" }', clear: (p: Phone) => type(p, 'clear\r') },
    { shell: 'cmd', print: 'for /L %i in (1,1,80) do @echo row %i', clear: (p: Phone) => type(p, 'cls\r') },
    { shell: 'powershell', print: '1..80 | % { "row $_" }', clear: (p: Phone) => p.ws.send(JSON.stringify({ t: 'clear' })) },
  ];
  for (const { shell, print, clear } of cases) {
    const { id } = await newTerminal({ shell });
    const phone = await attach(id, 60, 20);
    await waitFor(async () => /PS .*>|>$/m.test(await screen(phone)), `the ${shell} prompt`, 20_000);
    type(phone, `${print}\r`);
    await waitFor(async () => (await screen(phone)).includes('row 80\n'), 'the rows');
    await settle(phone);
    assert.ok(phone.term.buffer.active.baseY > 0, 'there is history to clear');
    phone.term.scrollLines(-30); // looking at old output
    clear(phone);
    const rows = () => dump(phone.term).lines.filter((line) => /^row \d+$/.test(line));
    await waitFor(() => phone.term.buffer.active.baseY === 0 && !rows().length, `${shell}: history and rows gone`);
    const b = phone.term.buffer.active;
    assert.equal(b.viewportY, b.baseY, 'back at the bottom');
    await assertMatchesMirror(phone, id, `after clearing in ${shell}`);
    await close(phone);
    await api('/api/terminals/close', 'POST', { id });
  }
});

test('at most 8 terminals; an exited one makes room', windowsOnly, async () => {
  for (const t of await list()) await api('/api/terminals/close', 'POST', { id: t.id });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await newTerminal()).id);
  const ninth = await api('/api/terminals', 'POST', { shell: 'cmd' });
  assert.equal(ninth.status, 409);
  assert.match(ninth.body.error, /up to 8/);

  const phone = await attach(ids[0], 80, 24);
  await waitFor(async () => (await screen(phone)).includes('>'), 'the prompt');
  type(phone, 'exit\r');
  await waitFor(async () => (await list()).find((t) => t.id === ids[0])?.running === false, 'the exit');
  assert.equal((await api('/api/terminals', 'POST', { shell: 'cmd' })).status, 200);
  const after = await list();
  assert.equal(after.length, 8);
  assert.equal(after.some((t) => t.id === ids[0]), false, 'the exited terminal was dropped');
  await close(phone);
  for (const t of after) await api('/api/terminals/close', 'POST', { id: t.id });
});
