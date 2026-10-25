import { getJson, message, q, sendJson } from './api.ts';
import { editor, goTo, openFile, save } from './editor.svelte.ts';
import { onEvent, send } from './events.svelte.ts';
import { toast, ui } from './ui.svelte.ts';
import { workspace } from './workspace.svelte.ts';

export type RunType = 'web' | 'desktop' | 'task';
export type RunShell = 'cmd' | 'powershell' | 'pwsh' | 'bash';
export type RunStatus = 'starting' | 'running' | 'ready' | 'stopping' | 'exited' | 'crashed';

export interface RunConfig {
  name: string;
  type: RunType;
  command: string;
  port?: number;
  windowTitle?: string;
  cwd?: string;
  env?: Record<string, string>;
  shell?: RunShell;
}

export interface RunInfo {
  id: string;
  project: string;
  name: string;
  /** console: the errors a previewed page reports, not a program. */
  kind: 'config' | 'file' | 'console';
  /** Root-relative folder it runs in. */
  cwd: string;
  type: RunType;
  port: number | null;
  command: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

export interface LogLine {
  seq: number;
  t: number;
  s: 'out' | 'err' | 'info' | 'in';
  text: string;
}

const MAX_LINES = 10_000;
const CHUNK = 200;
export const CONFIG_FILE = 'pocketide.json';
export const isActive = (run: RunInfo | undefined) => !!run && run.endedAt === null;
/** Files "Run current file" can run; the agent says which compiler is missing, if any. */
export const runnable = (path: string) => /\.(c|cc|cpp|cxx|rs|py|js|mjs|cjs|ts|mts|cts|ps1)$/i.test(path);

const stored = (key: string, fallback: boolean) => {
  try {
    return (localStorage.getItem(key) ?? String(fallback)) === 'true';
  } catch {
    return fallback;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private browsing: just not remembered
  }
};

export const runs = $state({
  project: null as string | null,
  configs: [] as RunConfig[],
  /** Where the configurations came from: the project's pocketide.json, or guessed from its files. */
  source: 'detected' as 'file' | 'detected',
  default: null as string | null,
  errors: [] as string[],
  selected: null as string | null,
  list: [] as RunInfo[],
  /** The run shown in the Logs tab. */
  viewing: null as string | null,
  /** Runs that finished while the Logs tab wasn't open; `crashed` if one of them failed. */
  unseen: 0,
  crashed: false,
  /** Run/Restart opens the Logs tab. */
  autoLogs: stored('pocketide.autoLogs', true),
  timestamps: stored('pocketide.timestamps', false),
  busy: false,
});

/** The viewed run's lines, in chunks: only the chunk that changed is drawn again. */
class LogState {
  chunks = $state.raw<LogLine[][]>([]);
}
export const log = new LogState();
let lines: LogLine[] = [];

function setLines(next: LogLine[]) {
  lines = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
  const chunks: LogLine[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));
  log.chunks = chunks;
}

/** Applies new and changed lines (an unfinished line grows), redrawing only the chunks they touch. */
function applyLines(changed: LogLine[]) {
  const chunks = [...log.chunks];
  for (const line of changed) {
    let last = chunks.at(-1);
    const lastSeq = last?.at(-1)?.seq ?? -1;
    if (line.seq <= lastSeq) {
      // An update to a line we have: find its chunk and replace the line.
      let c = chunks.length - 1;
      while (c >= 0 && chunks[c][0].seq > line.seq) c--;
      const i = c < 0 ? -1 : chunks[c].findIndex((l) => l.seq === line.seq);
      if (i < 0) continue;
      chunks[c] = chunks[c].slice();
      chunks[c][i] = line;
    } else if (!last || last.length >= CHUNK) chunks.push([line]);
    else chunks[chunks.length - 1] = [...last, line];
  }
  while (chunks.length && chunks.reduce((n, c) => n + c.length, 0) > MAX_LINES + CHUNK) chunks.shift();
  log.chunks = chunks;
  lines = chunks.flat();
}

export const allLines = () => lines;

const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** "Running", "Ready on port 5173", "Exited with code 1 after 3.2 s"... */
export function statusText(run: RunInfo | undefined): string {
  if (!run) return 'Not running';
  if (run.kind === 'console') return run.endedAt ? 'The preview was closed' : 'Errors and warnings from the previewed page';
  const took = run.endedAt ? ` after ${seconds(run.endedAt - run.startedAt)}` : '';
  switch (run.status) {
    case 'starting':
      return run.type === 'web' ? `Starting, waiting for port ${run.port}` : 'Starting';
    case 'running':
      return 'Running';
    case 'ready':
      return `Ready on port ${run.port}`;
    case 'stopping':
      return 'Stopping';
    case 'crashed':
      return `Failed with exit code ${run.exitCode}${took}`;
    default:
      return run.exitCode === 0 ? `Finished${took}` : `Stopped${took}`;
  }
}

/** The newest run of the selected configuration. */
export const selectedRun = () =>
  runs.list.find((r) => r.kind === 'config' && r.name === runs.selected) ?? undefined;

export const viewedRun = () => runs.list.find((r) => r.id === runs.viewing);

interface ConfigsReply {
  source: 'file' | 'detected';
  configs: RunConfig[];
  default: string | null;
  errors: string[];
}

export async function loadRunConfigs(): Promise<void> {
  const project = workspace.project;
  if (!project) return;
  try {
    const data = await getJson<ConfigsReply>(`/api/runs/configs?project=${q(project)}`);
    if (workspace.project !== project) return;
    Object.assign(runs, { project, configs: data.configs, source: data.source, default: data.default, errors: data.errors });
    const remembered = localStorageGet(`pocketide.run.${project}`);
    const names = data.configs.map((c) => c.name);
    if (!runs.selected || !names.includes(runs.selected)) {
      runs.selected = [remembered, data.default, names[0]].find((n) => n && names.includes(n)) ?? null;
    }
  } catch (err) {
    toast(message(err));
  }
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function selectConfig(name: string): void {
  runs.selected = name;
  if (runs.project) store(`pocketide.run.${runs.project}`, name);
}

let listLoads = 0;

export async function loadRuns(): Promise<void> {
  const project = workspace.project;
  if (!project) return;
  const load = ++listLoads;
  try {
    const { runs: list } = await getJson<{ runs: RunInfo[] }>(`/api/runs?project=${q(project)}`);
    // An older request answering late would bring back a stale list (and a second "finished").
    if (workspace.project !== project || load !== listLoads) return;
    notifyFinished(list);
    runs.list = list;
    if (!runs.viewing || !list.some((r) => r.id === runs.viewing)) view(list[0]?.id ?? null);
  } catch (err) {
    toast(message(err));
  }
}

/** A run that finished while the Logs tab is closed raises a badge (and a short message). */
function notifyFinished(list: RunInfo[]) {
  for (const run of list) {
    const before = runs.list.find((r) => r.id === run.id);
    if (!isActive(before) || isActive(run) || run.kind === 'console') continue;
    if (ui.tab === 'logs' && document.visibilityState === 'visible') continue;
    runs.unseen++;
    if (run.status === 'crashed') runs.crashed = true;
    toast(run.status === 'crashed' ? `${run.name} failed (exit code ${run.exitCode})` : `${run.name} finished`);
  }
}

export function seenLogs(): void {
  runs.unseen = 0;
  runs.crashed = false;
}

/** Shows a run's log in the Logs tab: the whole kept log, then live lines over the events socket. */
export async function view(id: string | null): Promise<void> {
  runs.viewing = id;
  setLines([]);
  send({ type: 'log', id });
  if (!id) return;
  try {
    const { lines: all } = await getJson<{ lines: LogLine[] }>(`/api/runs/log?id=${q(id)}`);
    // Live lines that arrived meanwhile are newer or the same; keep whichever is newer.
    if (runs.viewing === id) setLines(mergeLines(all, lines));
  } catch (err) {
    toast(message(err));
  }
}

const mergeLines = (base: LogLine[], live: LogLine[]) => {
  const bySeq = new Map(base.map((l) => [l.seq, l]));
  for (const l of live) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

async function started(run: RunInfo, openLogs = runs.autoLogs) {
  runs.list = [run, ...runs.list.filter((r) => r.id !== run.id)];
  await view(run.id);
  if (openLogs) ui.tab = 'logs';
}

/** Runs (or, if it's running, restarts) the selected configuration. The Preview tab stays put (`openLogs`). */
export async function runSelected(openLogs = runs.autoLogs): Promise<void> {
  if (!runs.project || !runs.selected || runs.busy) return;
  runs.busy = true;
  try {
    await started(await sendJson<RunInfo>('/api/runs/start', { project: runs.project, name: runs.selected }), openLogs);
  } catch (err) {
    toast(message(err));
  } finally {
    runs.busy = false;
  }
}

/** "Run current file": saves it first, then compiles and runs it on the PC. */
export async function runFile(path: string): Promise<void> {
  if (runs.busy) return;
  const doc = editor.docs.find((d) => d.path === path);
  if (doc?.dirty) {
    await save(path);
    if (doc.dirty) return; // the save failed (and said why)
  }
  runs.busy = true;
  try {
    await started(await sendJson<RunInfo>('/api/runs/start', { file: path }));
  } catch (err) {
    toast(message(err));
  } finally {
    runs.busy = false;
  }
}

export async function stopRun(id: string): Promise<void> {
  const run = runs.list.find((r) => r.id === id);
  if (run) run.status = 'stopping';
  try {
    await sendJson('/api/runs/stop', { id });
  } catch (err) {
    toast(message(err));
  }
}

/** Starts the same configuration or file again (the agent stops the running one first). */
export async function restartRun(run: RunInfo): Promise<void> {
  if (run.kind === 'console') return;
  if (run.kind === 'file') return runFile(run.cwd ? `${run.cwd}/${run.name}` : run.name);
  selectConfig(run.name);
  return runSelected();
}

export async function sendInput(id: string, text: string): Promise<void> {
  try {
    await sendJson('/api/runs/input', { id, text });
  } catch (err) {
    toast(message(err));
  }
}

export async function clearLog(id: string): Promise<void> {
  try {
    await sendJson('/api/runs/clear', { id });
    if (runs.viewing === id) setLines([]);
  } catch (err) {
    toast(message(err));
  }
}

/** Saves configurations as the project's pocketide.json; resolves to an error message, or undefined. */
export async function saveConfigs(configs: RunConfig[], preferred: string | null): Promise<string | undefined> {
  try {
    const data = await sendJson<ConfigsReply>('/api/runs/configs', { project: runs.project, configs, default: preferred || undefined });
    Object.assign(runs, { configs: data.configs, source: data.source, default: data.default, errors: data.errors });
    if (runs.selected && !data.configs.some((c) => c.name === runs.selected)) runs.selected = data.configs[0]?.name ?? null;
  } catch (err) {
    return message(err);
  }
}

/** Opens pocketide.json in the editor, creating it first (from what was detected) if the project has none. */
export async function editConfigFile(): Promise<void> {
  if (!runs.project) return;
  const path = `${runs.project}/${CONFIG_FILE}`;
  if (runs.source === 'detected') {
    const configs: RunConfig[] = runs.configs.length ? runs.configs : [{ name: 'Run', type: 'task', command: 'echo Hello from PocketIDE' }];
    const error = await saveConfigs(configs, null);
    if (error) return toast(error);
  }
  if (await openFile(path)) ui.tab = 'editor';
}

/** Opens a file at a line (from a compiler error in the log). */
export async function openAt(path: string, line: number, col?: number): Promise<void> {
  if (!(await openFile(path))) return; // it said why
  ui.tab = 'editor';
  requestAnimationFrame(() => goTo(line, col)); // once the editor is visible and can measure
}

export function setAutoLogs(on: boolean): void {
  runs.autoLogs = on;
  store('pocketide.autoLogs', String(on));
}

export function setTimestamps(on: boolean): void {
  runs.timestamps = on;
  store('pocketide.timestamps', String(on));
}

onEvent((event) => {
  if (event.type === 'connected') {
    // Back online: everything may have changed, and the log subscription went with the old socket.
    if (!workspace.project) return;
    void loadRunConfigs();
    void loadRuns().then(() => {
      if (runs.viewing) void view(runs.viewing);
    });
  } else if (event.type === 'runs' && event.project === workspace.project) void loadRuns();
  else if (event.type === 'log' && event.id === runs.viewing) {
    if (event.clear) setLines([]);
    else applyLines(event.lines);
  } else if (event.type === 'fs' && event.project === workspace.project) {
    // pocketide.json edited (here or on the PC): reload, and say if it now has mistakes.
    if (event.paths && !event.paths.includes(`${event.project}/${CONFIG_FILE}`)) return;
    void loadRunConfigs().then(() => {
      if (event.paths && runs.errors.length) toast(`${CONFIG_FILE}: ${runs.errors[0]}`);
    });
  }
});

// A new project: its configurations and runs.
$effect.root(() => {
  $effect(() => {
    const project = workspace.project;
    if (project === runs.project) return;
    Object.assign(runs, { project, configs: [], errors: [], selected: null, list: [], viewing: null, unseen: 0, crashed: false });
    setLines([]);
    if (project) {
      void loadRunConfigs();
      void loadRuns();
    }
  });
});
