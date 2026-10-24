import { watch, type FSWatcher } from 'node:fs';
import type { WebSocket } from 'ws';
import { isValidName, resolveReal } from './paths.ts';

interface ProjectWatch {
  watcher: FSWatcher;
  clients: Set<WebSocket>;
  changed: Set<string>;
  overflow: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * One recursive fs.watch per project that some client has open. Changes are batched for 200ms and sent
 * as `{type: 'fs', project, paths}` with root-relative paths, or `paths: null` for "reload everything".
 */
export function createWatcher(getRoot: () => string | undefined) {
  const watches = new Map<string, ProjectWatch>();
  const projectOf = new Map<WebSocket, string>();
  const latest = new Map<WebSocket, symbol>();

  function send(project: string, w: ProjectWatch) {
    w.timer = undefined;
    const paths = w.overflow || w.changed.size > 500 ? null : [...w.changed];
    w.changed.clear();
    w.overflow = false;
    const msg = JSON.stringify({ type: 'fs', project, paths });
    for (const ws of w.clients) ws.send(msg);
  }

  function stop(project: string) {
    const w = watches.get(project);
    if (!w) return;
    clearTimeout(w.timer);
    w.watcher.close();
    watches.delete(project);
  }

  function unsubscribe(ws: WebSocket) {
    latest.delete(ws);
    const project = projectOf.get(ws);
    if (project === undefined) return;
    projectOf.delete(ws);
    const w = watches.get(project);
    w?.clients.delete(ws);
    if (w && !w.clients.size) stop(project);
  }

  async function subscribe(ws: WebSocket, project: string) {
    unsubscribe(ws);
    const token = Symbol();
    latest.set(ws, token);
    const root = getRoot();
    if (!root || !isValidName(project)) return;
    const dir = await resolveReal(root, project).catch(() => null);
    // The socket may have closed or switched projects while we waited.
    if (!dir || latest.get(ws) !== token) return;
    let w = watches.get(project);
    if (!w) {
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, { recursive: true });
      } catch {
        return; // missing or not a folder
      }
      const entry: ProjectWatch = { watcher, clients: new Set(), changed: new Set(), overflow: false };
      watcher.on('change', (_event, filename) => {
        if (filename === null) entry.overflow = true; // the OS dropped events
        else {
          const parts = String(filename).split(/[\\/]/);
          // Skip churn inside .git and node_modules, but not those folders appearing or vanishing.
          if (parts.slice(0, -1).some((p) => p === '.git' || p === 'node_modules')) return;
          entry.changed.add(`${project}/${parts.join('/')}`);
        }
        entry.timer ??= setTimeout(() => send(project, entry), 200);
      });
      watcher.on('error', () => {
        entry.overflow = true;
        send(project, entry);
        stop(project);
      });
      watches.set(project, (w = entry));
    }
    w.clients.add(ws);
    projectOf.set(ws, project);
  }

  return {
    subscribe,
    unsubscribe,
    /** The projects root changed: every project name now means something else. */
    closeAll() {
      for (const project of [...watches.keys()]) stop(project);
      projectOf.clear();
      latest.clear();
    },
  };
}
