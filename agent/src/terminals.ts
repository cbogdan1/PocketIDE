import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, relative } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import headless from '@xterm/headless';
import type { RawData, WebSocket } from 'ws';
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

type Mirror = InstanceType<typeof headless.Terminal>;

interface Client {
  ws: WebSocket;
  cols: number;
  rows: number;
  /** syncing: waiting for its snapshot (output is held); behind: too slow, output is dropped until a resync. */
  state: 'syncing' | 'live' | 'behind';
  pending: string[];
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
  flushTimer?: NodeJS.Timeout;
  mirrorBacklog: number;
  paused: boolean;
  lastActivity: number;
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
    const env: Record<string, string> = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    // Inherited from whatever terminal started the agent; would mislead programs about where they run.
    delete env.TERM_PROGRAM;
    delete env.TERM_PROGRAM_VERSION;
    const pty = await spawnPty(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env });

    const scrollback = config.read().terminalScrollback ?? DEFAULT_SCROLLBACK;
    const mirror = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true });
    mirror.loadAddon(new Unicode11Addon()); // same character widths as the phone's xterm.js
    mirror.unicode.activeVersion = '11';
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
    };
    sessions.set(s.id, s);

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
    const data = Buffer.from(c.pending.join(''));
    c.pending = [];
    c.sent += data.length;
    c.ws.send(data);
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
    s.mirror.write('', () => {
      if (c.ws.readyState !== c.ws.OPEN || !s.clients.has(c)) return;
      const snapshot = Buffer.from(s.serializer.serialize());
      c.ws.send(JSON.stringify({ t: 'restore', exitCode: s.exitCode }));
      c.sent += snapshot.length;
      c.ws.send(snapshot);
      c.state = 'live';
      sendPending(s, c);
    });
  }

  /** The most recently active client sets the session's size. */
  function activate(s: Session, c: Client) {
    if (s.exitCode !== null || (c.cols === s.cols && c.rows === s.rows)) return;
    s.cols = c.cols;
    s.rows = c.rows;
    s.pty.proc.resize(c.cols, c.rows);
    s.mirror.resize(c.cols, c.rows);
  }

  function attach(ws: WebSocket, id: string, query: URLSearchParams, authorized: () => boolean) {
    const s = sessions.get(id)!;
    const c: Client = {
      ws,
      cols: clamp(query.get('cols'), 10, 500, s.cols),
      rows: clamp(query.get('rows'), 5, 200, s.rows),
      state: 'syncing',
      pending: [],
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
        c.cols = clamp(msg.cols, 10, 500, c.cols);
        c.rows = clamp(msg.rows, 5, 200, c.rows);
        activate(s, c);
      } else if (msg.t === 'ack' && typeof msg.n === 'number') {
        // The app reports bytes it has rendered, so a busy phone isn't buried under output.
        c.acked = Math.min(c.sent, c.acked + msg.n);
        if (c.state === 'live') sendPending(s, c);
      }
    });
    ws.on('close', () => {
      clearInterval(c.drainTimer);
      s.clients.delete(c);
    });
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
