import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, relative } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import headless from '@xterm/headless';
import type { RawData, WebSocket } from 'ws';
import { keepScrolledLines } from '../../client/src/lib/termProtocol.ts';
import type { ConfigStore } from './config.ts';
import { HttpError, json, jsonBody } from './http.ts';
import { resolveReal } from './paths.ts';
import { spawnPty, type Pty } from './pty.ts';
import { detectShells, type Shell } from './shells.ts';

export const MAX_TERMINALS = 8;
const DEFAULT_SCROLLBACK = 5000;
const BATCH_MS = 16;
/** A client this far behind (unsent, or sent but not yet rendered) stops getting output... */
const HIGH_WATER = 1 << 20;
/** ...until it has caught up to this, then gets a fresh snapshot instead of the backlog. */
const LOW_WATER = 128 << 10;
/** Unparsed output in the mirror before the shell is paused. */
const MIRROR_HIGH_WATER = 4 << 20;
const EXITED_TTL_MS = 60 * 60_000;
/** Output paused this long after Ctrl+L: the program has redrawn. */
const QUIET_MS = 100;

/**
 * Tells xterm.js (the mirror here, and the app's) that ConPTY is on the other end: when the screen grows,
 * ConPTY adds empty rows at the bottom instead of bringing history back into view, and xterm.js must do the
 * same or that history gets painted over. The bundled ConPTY (see pty.ts) re-wraps lines on resize like the
 * one in Windows builds 21376 and later, so xterm.js keeps re-wrapping enabled too.
 */
const WINDOWS_PTY = { backend: 'conpty' as const, buildNumber: 21376 };

/**
 * The serialize addon (0.14) writes "move 0 columns" (ESC[0C, ESC[0D) after a wrapped row that is entirely
 * blank, but terminals read a count of 0 as 1, so the restored screen kept a stray "-" (the addon's filler).
 * Escape sequences can't occur inside cell text, so dropping zero-count moves is safe.
 */
const ZERO_MOVES = /\x1b\[0[ABCD]/g;

/** Answers for programs that ask the terminal for its colors (Claude Code does, to pick a dark or light theme). */
const THEME_COLORS: Record<number, string> = { 10: 'e6e6/eded/f3f3', 11: '0d0d/1111/1717', 12: '4a4a/dede/8080' };

type Mirror = InstanceType<typeof headless.Terminal>;

/** Output, or a size change at exactly this point in the output. */
type Pending = string | { cols: number; rows: number };

interface Client {
  ws: WebSocket;
  /** The size that fits this client's screen; it becomes the session's size while this client is the active one. */
  cols: number;
  rows: number;
  lastActive: number;
  /** syncing: waiting for its snapshot (output is held); behind: too slow, output is dropped until a resync. */
  state: 'syncing' | 'live' | 'behind';
  pending: Pending[];
  /** Bumped by every resync, so an older snapshot still being prepared is dropped. */
  syncs: number;
  sent: number;
  acked: number;
  drainTimer?: NodeJS.Timeout;
}

interface Session {
  id: string;
  shell: Shell;
  /** Root-relative folder it started in ('' for the projects root, null outside it). */
  cwd: string | null;
  name: string;
  /** Set by the user; otherwise the program's own title (OSC 0/2), otherwise the folder name. */
  title: string | null;
  programTitle: string;
  pty: Pty;
  mirror: Mirror;
  serializer: SerializeAddon;
  cols: number;
  rows: number;
  exitCode: number | null;
  clients: Set<Client>;
  /** The most recently active client: its size is the session's size. */
  controller?: Client;
  flushTimer?: NodeJS.Timeout;
  mirrorBacklog: number;
  paused: boolean;
  lastActivity: number;
  lastOutput: number;
  removeTimer?: NodeJS.Timeout;
}

export type TerminalEvent = { type: 'terminals' } | { type: 'activity'; id: string };

/** Terminal sessions that outlive any connection: phones attach, detach and re-attach at will. */
export function createTerminals(config: ConfigStore, notify: (event: TerminalEvent) => void) {
  const sessions = new Map<string, Session>();
  const shells = detectShells();
  let listChanged: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(listChanged);
    listChanged = setTimeout(() => notify({ type: 'terminals' }), 50);
  };

  function info(s: Session) {
    return {
      id: s.id,
      title: s.title ?? (s.programTitle || s.name),
      shell: s.shell.label,
      cwd: s.cwd,
      running: s.exitCode === null,
      exitCode: s.exitCode,
      cols: s.cols,
      rows: s.rows,
    };
  }

  async function create(body: Record<string, unknown>) {
    if (sessions.size >= MAX_TERMINALS) {
      // Make room by dropping the oldest exited terminal, if there is one.
      const exited = [...sessions.values()].find((s) => s.exitCode !== null);
      if (!exited) throw new HttpError(409, `You can have up to ${MAX_TERMINALS} terminals: close one first`);
      remove(exited);
    }
    const shell = shells.find((s) => s.id === body.shell) ?? shells[0];
    const root = config.read().projectsRoot;
    let cwd = homedir();
    let cwdRel: string | null = null;
    if (root) {
      const rel = typeof body.cwd === 'string' ? body.cwd : '';
      const dir = await resolveReal(root, rel);
      if (dir === null) throw new HttpError(403, 'That folder is outside the projects folder');
      if (!(await stat(dir)).isDirectory()) throw new HttpError(400, 'Not a folder');
      cwd = dir;
      cwdRel = relative((await resolveReal(root, ''))!, dir).replaceAll('\\', '/');
    }
    const cols = clamp(body.cols, 10, 500, 80);
    const rows = clamp(body.rows, 5, 200, 24);
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    // Inherited from whatever terminal started the agent; would mislead programs about where they run.
    delete env.TERM_PROGRAM;
    delete env.TERM_PROGRAM_VERSION;
    const pty = spawnPty(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env });

    const scrollback = config.read().terminalScrollback ?? DEFAULT_SCROLLBACK;
    const mirror = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true, windowsPty: WINDOWS_PTY });
    mirror.loadAddon(new Unicode11Addon()); // same character widths as the phone's xterm.js
    mirror.unicode.activeVersion = '11';
    keepScrolledLines(mirror);
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    const s: Session = {
      id: randomBytes(9).toString('base64url'),
      shell,
      cwd: cwdRel,
      name: basename(cwd) || cwd,
      title: null,
      programTitle: '',
      pty,
      mirror,
      serializer,
      cols,
      rows,
      exitCode: null,
      clients: new Set(),
      mirrorBacklog: 0,
      paused: false,
      lastActivity: 0,
      lastOutput: 0,
    };
    sessions.set(s.id, s);

    // The mirror is the one terminal that answers queries (ConPTY waits for one at startup); the app's
    // xterm.js stays quiet, or every attached device would answer and the extra answers would arrive as input.
    const reply = (data: string) => s.exitCode === null && pty.proc.write(data);
    mirror.onData(reply);
    for (const [osc, color] of Object.entries(THEME_COLORS)) {
      mirror.parser.registerOscHandler(Number(osc), (data) => {
        if (data !== '?') return false;
        reply(`\x1b]${osc};rgb:${color}\x1b\\`);
        return true;
      });
    }

    mirror.onTitleChange((title) => {
      // Shells set the title to their own .exe path; only a program's own name (e.g. a TUI's) is worth showing.
      const useful = /\.exe\b/i.test(title) ? '' : title.trim();
      if (useful === s.programTitle) return;
      s.programTitle = useful;
      changed();
    });
    pty.proc.onData((data) => output(s, data));
    pty.proc.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      if (!sessions.has(s.id)) return s.mirror.dispose(); // closed by the user: nobody will look at it again
      output(s, `\r\n\x1b[2m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      flush(s);
      for (const c of s.clients) c.ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
      s.removeTimer = setTimeout(() => remove(s), EXITED_TTL_MS);
      s.removeTimer.unref();
      changed();
    });
    changed();
    return s;
  }

  /** Every byte goes to the mirror (for snapshots) and to each attached client's queue. */
  function output(s: Session, data: string) {
    s.mirrorBacklog += data.length;
    s.mirror.write(data, () => {
      s.mirrorBacklog -= data.length;
      if (s.paused && s.mirrorBacklog < MIRROR_HIGH_WATER / 4) {
        s.paused = false;
        s.pty.proc.resume();
      }
    });
    if (!s.paused && s.mirrorBacklog > MIRROR_HIGH_WATER && s.exitCode === null) {
      s.paused = true;
      s.pty.proc.pause();
    }
    for (const c of s.clients) if (c.state !== 'behind') c.pending.push(data);
    s.flushTimer ??= setTimeout(() => flush(s), BATCH_MS);
    const now = Date.now();
    s.lastOutput = now;
    if (now - s.lastActivity > 1000) {
      s.lastActivity = now;
      notify({ type: 'activity', id: s.id });
    }
  }

  function flush(s: Session) {
    clearTimeout(s.flushTimer);
    s.flushTimer = undefined;
    for (const c of s.clients) if (c.state === 'live') sendPending(s, c);
  }

  function sendPending(s: Session, c: Client) {
    if (!c.pending.length) return;
    if (c.sent - c.acked > HIGH_WATER) return fallBehind(s, c);
    let text = '';
    const sendText = () => {
      if (!text) return;
      const data = Buffer.from(text);
      c.sent += data.length;
      c.ws.send(data);
      text = '';
    };
    for (const item of c.pending) {
      if (typeof item === 'string') text += item;
      else {
        // The client resizes when it reaches this message, after the output before it, like the mirror did.
        sendText();
        c.ws.send(JSON.stringify({ t: 'size', cols: item.cols, rows: item.rows }));
      }
    }
    sendText();
    c.pending = [];
  }

  /** Drops a slow client's backlog; once it has caught up it gets a snapshot, which is never larger. */
  function fallBehind(s: Session, c: Client) {
    c.state = 'behind';
    c.pending = [];
    c.drainTimer = setInterval(() => {
      if (c.sent - c.acked > LOW_WATER) return;
      clearInterval(c.drainTimer);
      sync(s, c);
    }, 100);
  }

  /** Sends the mirror's screen, scrollback and modes, then whatever arrived meanwhile. */
  function sync(s: Session, c: Client) {
    c.state = 'syncing';
    c.pending = []; // already in the mirror, so already in the snapshot
    const generation = ++c.syncs;
    s.mirror.write('', () => {
      if (c.ws.readyState !== c.ws.OPEN || !s.clients.has(c) || generation !== c.syncs) return;
      // The client takes this size and then a full reset (ESC c), in stream order, so the snapshot replaces
      // whatever it showed before instead of landing on top of it.
      const { cols, rows } = s.mirror;
      c.ws.send(JSON.stringify({ t: 'restore', cols, rows, windowsPty: WINDOWS_PTY, exitCode: s.exitCode }));
      const snapshot = Buffer.from('\x1bc' + s.serializer.serialize().replace(ZERO_MOVES, ''));
      c.sent += snapshot.length;
      c.ws.send(snapshot);
      c.state = 'live';
      sendPending(s, c);
    });
  }

  /**
   * Changes the size at this point in the output, for the shell, the mirror and every client alike: what was
   * printed before is laid out at the old size everywhere, what comes after at the new one. Clients never
   * resize on their own, which is what kept a phone's screen from drifting away from the shell's.
   */
  function resize(s: Session, cols: number, rows: number) {
    if (cols === s.cols && rows === s.rows) return;
    s.cols = cols;
    s.rows = rows;
    if (s.exitCode === null) s.pty.proc.resize(cols, rows);
    s.mirror.write('', () => s.mirror.resize(cols, rows));
    for (const c of s.clients) if (c.state !== 'behind') c.pending.push({ cols, rows });
    flush(s);
  }

  /** The most recently active client sets the session's size; the others follow it. */
  function activate(s: Session, c: Client) {
    c.lastActive = Date.now();
    s.controller = c;
    resize(s, c.cols, c.rows);
  }

  function attach(ws: WebSocket, id: string, query: URLSearchParams, authorized: () => boolean) {
    const s = sessions.get(id)!;
    const c: Client = {
      ws,
      cols: clamp(query.get('cols'), 10, 500, s.cols),
      rows: clamp(query.get('rows'), 5, 200, s.rows),
      lastActive: 0,
      state: 'syncing',
      pending: [],
      syncs: 0,
      sent: 0,
      acked: 0,
    };
    s.clients.add(c);
    activate(s, c);
    sync(s, c);
    ws.on('message', (data: RawData, isBinary) => {
      if (!authorized()) return ws.close(4401, 'Logged out');
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        // Keystrokes and pastes; the app splits large pastes so each message stays under the size limit.
        if (s.exitCode !== null) return;
        activate(s, c);
        s.pty.proc.write(buf.toString('utf8'));
        return;
      }
      let msg: { t?: unknown; cols?: unknown; rows?: unknown; n?: unknown };
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (msg.t === 'resize') {
        // What fits the client's screen now (rotation, keyboard, text size); it also counts as being active.
        c.cols = clamp(msg.cols, 10, 500, c.cols);
        c.rows = clamp(msg.rows, 5, 200, c.rows);
        activate(s, c);
      } else if (msg.t === 'ack' && typeof msg.n === 'number') {
        // The app reports bytes it has rendered, so a busy phone isn't buried under output.
        c.acked = Math.min(c.sent, c.acked + msg.n);
        if (c.state === 'live') sendPending(s, c);
      } else if (msg.t === 'clear') {
        // "Clear terminal": Ctrl+L asks the program (PowerShell, bash, Claude Code) to clear and redraw the screen
        // itself, and PowerShell does that by scrolling the old screen into the history. So the history is
        // cleared after the redraw, in the stream, for the mirror and every client.
        if (s.exitCode === null && s.shell.ctrlLClears) {
          s.pty.proc.write('\x0c');
          clearHistoryAfterRedraw(s);
        } else output(s, '\x1b[3J');
      }
    });
    ws.on('close', () => {
      clearInterval(c.drainTimer);
      s.clients.delete(c);
      if (s.controller !== c) return;
      // Hand the size back to whoever was active before, e.g. the phone once the PC browser is closed.
      const next = [...s.clients].sort((a, b) => b.lastActive - a.lastActive)[0];
      s.controller = next;
      if (next) resize(s, next.cols, next.rows);
    });
  }

  /** Clears the history once the program's reply has arrived and paused, or a second on (a busy program). */
  function clearHistoryAfterRedraw(s: Session) {
    const asked = Date.now();
    const check = () => {
      if (!sessions.has(s.id)) return;
      const now = Date.now();
      if ((s.lastOutput > asked && now - s.lastOutput >= QUIET_MS) || now - asked >= 1000) output(s, '\x1b[3J');
      else setTimeout(check, QUIET_MS).unref();
    };
    setTimeout(check, QUIET_MS).unref();
  }

  function remove(s: Session) {
    sessions.delete(s.id);
    clearTimeout(s.removeTimer);
    clearTimeout(s.flushTimer);
    for (const c of s.clients) c.ws.close(4404, 'Terminal closed');
    if (s.exitCode === null) s.pty.killTree(); // the exit handler disposes the mirror
    else s.mirror.dispose();
    changed();
  }

  const find = (id: unknown) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!s) throw new HttpError(404, 'No such terminal');
    return s;
  };

  type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const routes: Record<string, Handler> = {
    'GET /api/terminals': async (_req, res) =>
      json(res, 200, {
        terminals: [...sessions.values()].map(info),
        shells: shells.map(({ id, label }) => ({ id, label })),
        max: MAX_TERMINALS,
      }),
    'POST /api/terminals': async (req, res) => json(res, 200, info(await create(await jsonBody(req)))),
    'POST /api/terminals/rename': async (req, res) => {
      const { id, title } = await jsonBody(req);
      const s = find(id);
      if (typeof title !== 'string' || title.length > 60) throw new HttpError(400, 'Invalid title');
      s.title = title.trim() || null;
      changed();
      json(res, 200, info(s));
    },
    'POST /api/terminals/close': async (req, res) => {
      remove(find((await jsonBody(req)).id));
      json(res, 200, {});
    },
  };

  return {
    routes,
    has: (id: string) => sessions.has(id),
    attach,
    closeAll() {
      for (const s of [...sessions.values()]) remove(s);
    },
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
