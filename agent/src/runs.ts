import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import type { ConfigStore } from './config.ts';
import { HttpError, json, jsonBody } from './http.ts';
import { isValidName, resolveReal } from './paths.ts';
import { killTree } from './pty.ts';
import {
  CONFIG_FILE,
  detectConfigs,
  fileCommand,
  findTools,
  parseProjectConfig,
  validateProjectConfig,
  type RunConfig,
  type RunShell,
  type RunType,
  type Tools,
} from './runconfig.ts';
import { detectShells } from './shells.ts';

export const MAX_LOG_LINES = 10_000;
/** Finished runs kept per configuration (besides a running one), so earlier output can be looked at. */
export const KEPT_RUNS = 3;
const MAX_LINE_CHARS = 8000;
const CTRL_SCRIPT = fileURLToPath(new URL('ctrl.ps1', import.meta.url));
const UNBUFFERED_C = fileURLToPath(new URL('unbuffered.c', import.meta.url));
/** How long a program gets after Ctrl+C, and then after Ctrl+Break, before it's killed. */
const GRACE_MS = 2000;

export type RunStatus = 'starting' | 'running' | 'ready' | 'stopping' | 'exited' | 'crashed';
/** Stream of a log line: program output, its errors, a note from PocketIDE, or input that was sent. */
export type LogStream = 'out' | 'err' | 'info' | 'in';

export interface LogLine {
  seq: number;
  /** Time the line started (ms since 1970). */
  t: number;
  s: LogStream;
  text: string;
}

/**
 * Output split into lines, keeping the last MAX_LOG_LINES. An unfinished line (a prompt like "Name: ") is a
 * line too; later output extends it. After a lone \r the next text replaces the line (progress bars).
 * `onChange` gets every line that was added or changed.
 */
export function createLog(onChange: (line: LogLine) => void, max = MAX_LOG_LINES) {
  const lines: LogLine[] = [];
  const open: Partial<Record<LogStream, LogLine>> = {};
  const overwrite: Partial<Record<LogStream, boolean>> = {};
  let seq = 0;

  const add = (s: LogStream, text: string) => {
    const line = { seq: seq++, t: Date.now(), s, text };
    lines.push(line);
    if (lines.length > max + 500) lines.splice(0, lines.length - max); // trimmed in batches
    onChange(line);
    return line;
  };

  return {
    /** The kept lines (at most `max`, plus up to 500 waiting to be trimmed). */
    lines: () => (lines.length > max ? lines.slice(-max) : lines),
    write(s: LogStream, text: string) {
      for (const piece of text.split(/(\r|\n)/)) {
        if (piece === '\n') {
          delete open[s];
          overwrite[s] = false;
        } else if (piece === '\r') overwrite[s] = true;
        else if (piece) {
          const line = open[s];
          if (!line) open[s] = add(s, piece);
          else {
            line.text = overwrite[s] ? piece : line.text + piece;
            onChange(line);
          }
          overwrite[s] = false;
          // A huge line (minified output) continues on a new one.
          while (open[s]!.text.length > MAX_LINE_CHARS) {
            const rest = open[s]!.text.slice(MAX_LINE_CHARS);
            open[s]!.text = open[s]!.text.slice(0, MAX_LINE_CHARS);
            open[s] = add(s, rest);
          }
        }
      }
    },
    /** A whole line of its own (notes, echoed input). */
    note(s: LogStream, text: string) {
      delete open.out;
      delete open.err;
      add(s, text);
    },
    clear() {
      lines.length = 0;
      delete open.out;
      delete open.err;
    },
  };
}

interface Run {
  id: string;
  /** Runs of the same configuration (or file) share a key; only one of them can be active. */
  key: string;
  project: string;
  name: string;
  /** console: no program, just the errors a previewed page reports (see preview.ts). */
  kind: 'config' | 'file' | 'console';
  /** The folder it runs in, relative to the projects folder ('/'-separated). */
  cwd: string;
  type: RunType;
  port?: number;
  command: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  child?: ChildProcess;
  log: ReturnType<typeof createLog>;
  changed: Map<number, LogLine>;
  flushTimer?: NodeJS.Timeout;
  stopRequested: boolean;
  exited: Promise<void>;
}

export type RunEvent = { type: 'runs'; project: string };

const isActive = (run: Run) => run.endedAt === null;

/** Runs pocketide.json configurations and single files; output is kept here so the app can reopen it. */
export function createRuns(config: ConfigStore, notify: (event: RunEvent) => void) {
  const runs = new Map<string, Run>();
  const watching = new Map<WebSocket, string>();
  const shells = detectShells();
  let toolCache: { at: number; tools: Promise<Tools> } | undefined;

  // Tools are looked up by file on PATH; a newly installed compiler shows up within half a minute.
  const tools = () => {
    if (!toolCache || Date.now() - toolCache.at > 30_000) toolCache = { at: Date.now(), tools: findTools() };
    return toolCache.tools;
  };

  const root = () => {
    const dir = config.read().projectsRoot;
    if (!dir) throw new HttpError(409, 'Choose a projects folder first');
    return dir;
  };

  async function projectDir(project: unknown): Promise<string> {
    if (typeof project !== 'string' || !isValidName(project)) throw new HttpError(400, 'Invalid project');
    const dir = await resolveReal(root(), project);
    if (dir === null) throw new HttpError(403, 'That project is outside the projects folder');
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(404, 'No such project');
    return dir;
  }

  /** pocketide.json, or (without one) what the project looks like it needs. */
  async function loadConfigs(project: unknown) {
    const dir = await projectDir(project);
    const text = await readFile(join(dir, CONFIG_FILE), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (text === null) return { source: 'detected' as const, configs: await detectConfigs(dir, await tools()), default: null, errors: [] };
    const { config, errors } = parseProjectConfig(text);
    return { source: 'file' as const, configs: config?.configs ?? [], default: config?.default ?? null, errors };
  }

  function info(run: Run) {
    const { id, project, name, kind, cwd, type, port, command, status, exitCode, startedAt, endedAt } = run;
    return { id, project, name, kind, cwd, type, port: port ?? null, command, status, exitCode, startedAt, endedAt };
  }

  const changed = (run: Run) => notify({ type: 'runs', project: run.project });

  function flush(run: Run) {
    run.flushTimer = undefined;
    const lines = [...run.changed.values()];
    run.changed.clear();
    const msg = JSON.stringify({ type: 'log', id: run.id, lines });
    for (const [ws, id] of watching) if (id === run.id) ws.send(msg);
  }

  /** The command line for the configuration's shell, run with a hidden console of its own. */
  function shellCommand(shell: RunShell | undefined, command: string): [string, string[], boolean] {
    const found = shells.find((s) => s.id === (shell ?? 'cmd'));
    if (!found) throw new HttpError(424, `The ${shell} shell isn't installed on the PC`);
    // UTF-8 output from cmd's own commands and from programs that follow the console code page.
    if (found.id === 'cmd') return [found.file, ['/d', '/s', '/c', `"chcp 65001 >nul & ${command}"`], true];
    if (found.id === 'bash') return [found.file, ['-lc', command], false];
    return [found.file, ['-NoProfile', '-Command', command], false];
  }

  async function start(spec: { project: string; key: string; name: string; kind: Run['kind']; config: RunConfig; cwd: string }): Promise<Run> {
    const previous = [...runs.values()].find((r) => r.key === spec.key && isActive(r));
    if (previous) await stop(previous);
    const { config } = spec;
    const [file, args, verbatim] = shellCommand(config.shell, config.command);
    const env = {
      ...process.env,
      // Programs see a pipe, not a terminal: ask them for colors (shown in the Logs tab) and unbuffered output.
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      CARGO_TERM_COLOR: 'always',
      DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      ...config.env,
    };
    const realRoot = (await resolveReal(root(), ''))!;
    const portTaken = config.type === 'web' && config.port ? await listening(config.port) : false;
    // windowsHide gives the program a hidden console of its own (for Ctrl+C); its windows still show normally.
    const child = spawn(file, args, { cwd: spec.cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: 'pipe' });
    const run: Run = {
      id: randomBytes(9).toString('base64url'),
      key: spec.key,
      project: spec.project,
      name: spec.name,
      kind: spec.kind,
      cwd: relative(realRoot, spec.cwd).replaceAll('\\', '/'),
      type: config.type,
      port: config.port,
      command: config.command,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      child,
      log: createLog((line) => {
        run.changed.set(line.seq, line);
        run.flushTimer ??= setTimeout(() => flush(run), 50);
      }),
      changed: new Map(),
      stopRequested: false,
      exited: new Promise((resolve) => child.once('exit', () => resolve())),
    };
    runs.set(run.id, run);
    run.log.note('info', `▶ ${config.command}`);
    if (portTaken) run.log.note('info', `Something is already listening on port ${config.port}; the app may pick another port.`);

    const output = (s: 'out' | 'err') => (text: string) => {
      run.log.write(s, text);
      // npm, yarn and pnpm are batch files: after Ctrl+C cmd asks this and waits.
      // shortcut: English Windows wording only; other languages wait for the forced kill (about 5 s).
      if (run.stopRequested && text.includes('Terminate batch job (Y/N)?')) child.stdin!.write('Y\r\n');
    };
    child.stdout!.setEncoding('utf8').on('data', output('out'));
    child.stderr!.setEncoding('utf8').on('data', output('err'));
    child.stdin!.on('error', () => {}); // input sent after the program closed it
    child.on('spawn', () => {
      if (run.status !== 'starting') return;
      if (config.type === 'web') void waitForPort(run);
      else run.status = 'running';
      changed(run);
    });
    child.on('error', (err) => {
      // Spawning failed (the shell is missing); 'exit' doesn't follow.
      if (!isActive(run)) return;
      run.log.note('info', `Couldn't start: ${err.message}`);
      finish(run, -1);
    });
    child.on('exit', (code) => finish(run, code ?? -1));
    forgetOld(spec.key);
    changed(run);
    return run;
  }

  function finish(run: Run, code: number) {
    if (!isActive(run)) return;
    run.exitCode = code;
    run.endedAt = Date.now();
    run.status = run.stopRequested || code === 0 ? 'exited' : 'crashed';
    const took = `${((run.endedAt - run.startedAt) / 1000).toFixed(1)} s`;
    if (run.kind === 'console') run.log.note('info', '■ The preview was closed');
    else run.log.note('info', run.stopRequested ? `■ Stopped after ${took}` : `■ Exited with code ${code} after ${took}`);
    forgetOld(run.key);
    changed(run);
  }

  /** Only the newest KEPT_RUNS finished runs of a configuration stay. */
  function forgetOld(key: string) {
    const finished = [...runs.values()].filter((r) => r.key === key && !isActive(r)).sort((a, b) => b.startedAt - a.startedAt);
    for (const run of finished.slice(KEPT_RUNS)) runs.delete(run.id);
  }

  /** Polls the port until the server accepts connections (it's "ready"), or the run ends. */
  async function waitForPort(run: Run) {
    while (run.status === 'starting') {
      if (await listening(run.port!)) {
        if (run.status !== 'starting') return;
        run.status = 'ready';
        run.log.note('info', `Ready: something is listening on port ${run.port}`);
        changed(run);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * Stops a run: Ctrl+C, then Ctrl+Break, then a forced kill of the whole process tree, each after a short wait.
   * Its windows (a desktop app) are asked to close at the start, like clicking their close button.
   */
  async function stop(run: Run) {
    if (!isActive(run)) return;
    if (!run.child) return finish(run, 0);
    if (!run.stopRequested) {
      run.stopRequested = true;
      run.status = 'stopping';
      changed(run);
      const pid = run.child.pid;
      if (pid) {
        void killTree(pid, false);
        for (const ctrlEvent of [0, 1]) {
          await sendCtrl(pid, ctrlEvent);
          if (await within(run.exited, GRACE_MS)) break;
        }
        if (isActive(run)) await killTree(pid);
      }
    }
    await within(run.exited, 5000);
  }

  function forceStopAll() {
    for (const run of runs.values()) {
      if (!isActive(run) || !run.child?.pid) continue;
      run.stopRequested = true;
      try {
        execFileSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      } catch {
        // already gone
      }
    }
  }

  const find = (id: unknown) => {
    const run = typeof id === 'string' ? runs.get(id) : undefined;
    if (!run) throw new HttpError(404, 'No such run');
    return run;
  };

  async function startConfig(project: string, name: unknown) {
    const { configs, errors } = await loadConfigs(project);
    if (errors.length) throw new HttpError(400, `${CONFIG_FILE} has errors: ${errors[0]}`);
    const config = configs.find((c) => c.name === name);
    if (!config) throw new HttpError(404, 'No configuration with that name');
    const cwd = await resolveReal(root(), `${project}/${config.cwd ?? ''}`);
    if (cwd === null) throw new HttpError(403, 'Its folder is outside the projects folder');
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new HttpError(400, `Its folder "${config.cwd}" doesn't exist`);
    return start({ project, key: `${project}\0${config.name}`, name: config.name, kind: 'config', config, cwd });
  }

  async function startFile(path: unknown) {
    if (typeof path !== 'string') throw new HttpError(400, 'Missing path');
    const project = path.split('/')[0];
    await projectDir(project);
    const full = await resolveReal(root(), path);
    if (full === null) throw new HttpError(403, 'That file is outside the projects folder');
    if (!(await stat(full).catch(() => null))?.isFile()) throw new HttpError(404, 'File not found');
    const outDir = join(tmpdir(), 'pocketide-run', createHash('sha1').update(full).digest('hex').slice(0, 8));
    let command: string;
    try {
      command = fileCommand(basename(full), await tools(), outDir, UNBUFFERED_C);
    } catch (err) {
      throw new HttpError(424, (err as Error).message);
    }
    await mkdir(outDir, { recursive: true });
    const name = basename(full);
    return start({ project, key: `${project}\0file:${path}`, name, kind: 'file', config: { name, type: 'task', command }, cwd: dirname(full) });
  }

  type Handler = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams) => Promise<void>;
  const routes: Record<string, Handler> = {
    'GET /api/runs': async (_req, res, query) => {
      const project = query.get('project');
      const list = [...runs.values()].filter((r) => r.project === project).sort((a, b) => b.startedAt - a.startedAt);
      json(res, 200, { runs: list.map(info) });
    },
    'GET /api/runs/configs': async (_req, res, query) => json(res, 200, await loadConfigs(query.get('project'))),
    'POST /api/runs/configs': async (req, res) => {
      const { project, configs, default: preferred } = await jsonBody(req);
      const data = preferred ? { configs, default: preferred } : { configs };
      const errors = validateProjectConfig(data);
      if (errors.length) return json(res, 400, { error: errors[0], errors });
      await writeFile(join(await projectDir(project), CONFIG_FILE), JSON.stringify(data, null, 2) + '\n');
      json(res, 200, await loadConfigs(project));
    },
    'POST /api/runs/start': async (req, res) => {
      const body = await jsonBody(req);
      const run = body.file !== undefined ? await startFile(body.file) : await startConfig(String(body.project), body.name);
      json(res, 200, info(run));
    },
    'POST /api/runs/stop': async (req, res) => {
      const run = find((await jsonBody(req)).id);
      await stop(run);
      json(res, 200, info(run));
    },
    'GET /api/runs/log': async (_req, res, query) => json(res, 200, { lines: find(query.get('id')).log.lines() }),
    'POST /api/runs/input': async (req, res) => {
      const { id, text } = await jsonBody(req);
      const run = find(id);
      if (typeof text !== 'string' || text.length > 10_000) throw new HttpError(400, 'Invalid input');
      if (!isActive(run) || !run.child) throw new HttpError(409, 'The program has finished');
      run.log.note('in', text);
      run.child.stdin!.write(text + '\n');
      json(res, 200, {});
    },
    'POST /api/runs/clear': async (req, res) => {
      const run = find((await jsonBody(req)).id);
      run.log.clear();
      for (const [ws, id] of watching) if (id === run.id) ws.send(JSON.stringify({ type: 'log', id: run.id, clear: true, lines: [] }));
      json(res, 200, {});
    },
  };

  return {
    routes,
    /** The events socket shows one run's log at a time; null stops it. */
    watch(ws: WebSocket, id: string | null) {
      if (id === null || !runs.has(id)) watching.delete(ws);
      else watching.set(ws, id);
    },
    unwatch: (ws: WebSocket) => watching.delete(ws),
    /** Synchronous, so it also works while the agent is exiting. */
    stopAll: forceStopAll,
    previewConsole,
  };

  /**
   * The "Preview console" log for a previewed port: errors and warnings the page reports. File links in it are
   * resolved from the folder of the web configuration on that port (where the dev server serves from).
   */
  function previewConsole(project: string, port: number) {
    const key = `${project}\0console:${port}`;
    let run = [...runs.values()].find((r) => r.key === key && isActive(r));
    if (!run) {
      const web = [...runs.values()].filter((r) => r.project === project && r.port === port && r.kind === 'config').sort((a, b) => b.startedAt - a.startedAt)[0];
      const created: Run = {
        id: randomBytes(9).toString('base64url'),
        key,
        project,
        name: `Preview console :${port}`,
        kind: 'console',
        cwd: web?.cwd ?? project,
        type: 'web',
        port,
        command: '',
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        log: createLog((line) => {
          created.changed.set(line.seq, line);
          created.flushTimer ??= setTimeout(() => flush(created), 50);
        }),
        changed: new Map(),
        stopRequested: false,
        exited: Promise.resolve(),
      };
      run = created;
      runs.set(run.id, run);
      run.log.note('info', `Errors and warnings from the page previewed on port ${port}`);
      forgetOld(key);
      changed(run);
    }
    const page = run;
    return {
      write: (level: 'error' | 'warn', text: string) => page.log.note(level === 'error' ? 'err' : 'out', level === 'warn' ? `⚠ ${text}` : text),
      close: () => finish(page, 0),
    };
  }
}

/** True if something accepts connections on the port (IPv4 or IPv6 localhost: dev servers use either). */
export async function listening(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host, timeout: 1000 });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    });
  return (await Promise.all([tryHost('127.0.0.1'), tryHost('::1')])).some(Boolean);
}

/** Sends Ctrl+C (0) or Ctrl+Break (1) to the console of process `pid`. */
function sendCtrl(pid: number, ctrlEvent: number): Promise<void> {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CTRL_SCRIPT],
      { env: { ...process.env, POCKETIDE_PID: String(pid), POCKETIDE_EVENT: String(ctrlEvent) }, windowsHide: true, timeout: 10_000 },
      () => resolve(),
    ),
  );
}

/** True if `promise` settles within `ms`. */
const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);

