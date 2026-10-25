import { getJson, message, sendJson } from './api.ts';
import { runs, type RunConfig } from './runs.svelte.ts';
import { workspace } from './workspace.svelte.ts';

/** The agent's preview of a port: its proxy on the PC (`local`) and, for the phone, its tailnet port (`ext`). */
export interface Opened {
  port: number;
  local: number;
  ext: number | null;
  publishError: string | null;
  /** When the agent started this preview; a new one means the page must be loaded again. */
  since: number;
}

export interface ListeningPort {
  port: number;
  process: string;
}

interface Remembered {
  port?: number;
  config?: string;
  path?: string;
}

export const preview = $state({
  /** A port picked in the Preview tab; null shows the selected web configuration. */
  port: null as number | null,
  /** The web configuration shown while the header has a non-web one selected. */
  config: null as string | null,
  /** The page's path (as the page reports it), remembered per project. */
  path: '/',
  opened: null as Opened | null,
  error: '',
  fullscreen: false,
  /** The page runs PocketIDE's script, so Back/Forward/Reload and the address bar go through it. */
  connected: false,
});

const key = (project: string) => `pocketide.preview.${project}`;

function remembered(project: string): Remembered {
  try {
    return JSON.parse(localStorage.getItem(key(project)) ?? '{}');
  } catch {
    return {};
  }
}

function remember(): void {
  if (!workspace.project) return;
  const data: Remembered = { port: preview.port ?? undefined, config: preview.config ?? undefined, path: preview.path };
  try {
    localStorage.setItem(key(workspace.project), JSON.stringify(data));
  } catch {
    // private browsing: just not remembered
  }
}

/** The web configuration shown: the header's selection if it's a web one, else the last one shown here. */
export function shownConfig(): RunConfig | undefined {
  const web = runs.configs.filter((c) => c.type === 'web');
  return web.find((c) => c.name === runs.selected) ?? web.find((c) => c.name === preview.config) ?? web[0];
}

export function setPath(path: string): void {
  preview.path = path;
  remember();
}

/** Another app starts at its home page; the same one keeps its path. */
const pathFor = (port: number | undefined) => (port !== undefined && port === preview.opened?.port ? preview.path : '/');

export function showPort(port: number): void {
  Object.assign(preview, { port, path: pathFor(port), opened: null, connected: false, error: '' });
  remember();
}

export function showConfig(name: string): void {
  const port = runs.configs.find((c) => c.name === name)?.port;
  Object.assign(preview, { port: null, config: name, path: pathFor(port), opened: null, connected: false, error: '' });
  remember();
}

/**
 * Asks the agent for the preview of `port` (it starts one if needed). Resolves true if the page has to be
 * (re)loaded: the first time, or because the agent started a new preview meanwhile.
 */
export async function openPreview(port: number): Promise<boolean> {
  const project = workspace.project;
  if (!project) return false;
  try {
    const opened = await sendJson<Opened>('/api/preview/open', { project, port });
    if (workspace.project !== project) return false;
    const before = preview.opened;
    preview.opened = opened;
    preview.error = onTailnet() && !opened.ext ? (opened.publishError ?? "The preview couldn't be published on your tailnet") : '';
    return !before || before.port !== opened.port || before.since !== opened.since || before.ext !== opened.ext;
  } catch (err) {
    preview.error = message(err);
    return false;
  }
}

const onTailnet = () => location.hostname.endsWith('.ts.net');

/** Where the page is: its own port on the tailnet (from the phone), or the proxy itself (on the PC). */
export function previewOrigin(): string | null {
  const opened = preview.opened;
  if (!opened) return null;
  if (onTailnet()) return opened.ext ? `https://${location.hostname}:${opened.ext}` : null;
  return `${location.protocol}//${location.hostname}:${opened.local}`;
}

/** A one-time link for Safari, which has its own cookies (it signs Safari in). */
export async function safariLink(): Promise<string | null> {
  const origin = previewOrigin();
  if (!origin || !preview.opened) return null;
  try {
    const { path } = await sendJson<{ path: string }>('/api/preview/handoff', { port: preview.opened.port, path: preview.path });
    return origin + path;
  } catch {
    return origin + preview.path;
  }
}

/** Ports that programs on the PC listen on, likely dev servers first. */
export async function listeningPorts(): Promise<ListeningPort[]> {
  const { ports } = await getJson<{ ports: ListeningPort[] }>('/api/preview/ports');
  const dev = (p: ListeningPort) => /^(node|python\d*|pythonw|py|deno|bun|ruby|php|java|dotnet|go)\.exe$/i.test(p.process);
  return [...ports.filter(dev), ...ports.filter((p) => !dev(p))];
}

// Another project: its own remembered preview.
$effect.root(() => {
  let project: string | null = null;
  $effect(() => {
    if (workspace.project === project) return;
    project = workspace.project;
    const saved = project ? remembered(project) : {};
    Object.assign(preview, { port: saved.port ?? null, config: saved.config ?? null, path: saved.path ?? '/', opened: null, error: '', connected: false });
  });
});
