import { api, ApiError, basename, getJson, message, parentOf, q, sendJson } from './api.ts';
import { activate, checkFile, closeAll, confirmDiscard, editor, forgetPaths, openFile, renamePaths } from './editor.svelte.ts';
import { onEvent, send } from './events.svelte.ts';
import { toast, ui } from './ui.svelte.ts';

export interface Entry {
  name: string;
  dir: boolean;
}

interface Config {
  projectsRoot: string | null;
  suggestedRoot: string;
  /** Folder names hidden unless "Show hidden folders" is on. */
  hidden: string[];
  lastProject: string | null;
  openFiles: Record<string, { paths: string[]; active: string | null }>;
}

/** Paths are root-relative ("my-app/src"); the project's own path is its name. */
export const workspace = $state({
  config: null as Config | null,
  projects: [] as string[],
  project: null as string | null,
  /** Showing the project list while a project stays open behind it. */
  picking: false,
  /** Folder listings that have been loaded. */
  dirs: {} as Record<string, Entry[]>,
  expanded: {} as Record<string, boolean>,
  /** The folder at the top of the tree: the project, or a subfolder picked with "Show only this folder". */
  treeRoot: '',
  showHidden: false,
  /** Quick-open's list of every file, relative to the project; null until needed (or stale). */
  files: null as string[] | null,
});

export async function loadConfig(): Promise<void> {
  try {
    workspace.config = await getJson<Config>('/api/config');
    if (!workspace.config.projectsRoot) return;
    await loadProjects();
    const last = workspace.config.lastProject;
    if (!workspace.project && last && workspace.projects.includes(last)) await openProject(last);
  } catch (err) {
    toast(message(err));
  }
}

/** Resolves to an error message, or undefined once saved. */
export async function setProjectsRoot(path: string): Promise<string | undefined> {
  if (!confirmDiscard('Change the projects folder')) return;
  try {
    workspace.config = await sendJson<Config>('/api/config', { projectsRoot: path.trim() }, 'PATCH');
  } catch (err) {
    return message(err);
  }
  reset();
  await loadProjects();
}

export async function loadProjects(): Promise<void> {
  try {
    workspace.projects = (await getJson<{ projects: string[] }>('/api/projects')).projects;
  } catch (err) {
    toast(message(err));
  }
}

/** Back to a blank state (logout, new projects root); callers check confirmDiscard() first. */
export function reset(): void {
  closeAll();
  Object.assign(workspace, { project: null, picking: false, dirs: {}, expanded: {}, treeRoot: '', files: null });
}

export async function openProject(name: string): Promise<void> {
  if (name === workspace.project) {
    workspace.picking = false;
    return;
  }
  if (!confirmDiscard(`Open ${name}`)) return;
  closeAll();
  Object.assign(workspace, { project: name, picking: false, dirs: {}, expanded: {}, treeRoot: name, files: null });
  send({ type: 'watch', project: name });
  sendJson('/api/config', { lastProject: name }, 'PATCH').catch(() => {});
  await loadDir(name);
  // Reopen last time's tabs; files that are gone (or now binary) are skipped quietly.
  const tabs = workspace.config?.openFiles[name];
  if (!tabs) return;
  for (const path of tabs.paths) {
    if (workspace.project !== name) return;
    await openFile(path, { focus: false, quiet: true });
  }
  if (tabs.active && editor.docs.some((d) => d.path === tabs.active)) activate(tabs.active);
}

// Remember each project's tabs, so they come back next time (debounced; writes go to the agent's config).
let tabsTimer: ReturnType<typeof setTimeout> | undefined;
$effect.root(() => {
  $effect(() => {
    const project = workspace.project;
    const tabs = { paths: editor.docs.map((d) => d.path), active: editor.active };
    if (!project || !workspace.config) return;
    clearTimeout(tabsTimer);
    tabsTimer = setTimeout(() => {
      workspace.config!.openFiles[project] = tabs;
      sendJson('/api/config', { openFiles: { [project]: tabs } }, 'PATCH').catch(() => {});
    }, 1000);
  });
});

export async function loadDir(dir: string): Promise<void> {
  try {
    workspace.dirs[dir] = (await getJson<{ entries: Entry[] }>(`/api/fs/list?path=${q(dir)}`)).entries;
  } catch (err) {
    delete workspace.dirs[dir];
    delete workspace.expanded[dir];
    if (dir === workspace.treeRoot && workspace.project && dir !== workspace.project) showFolder(workspace.project);
    if (!(err instanceof ApiError && err.status === 404)) toast(message(err));
  }
}

export function toggleDir(dir: string): void {
  if (workspace.expanded[dir]) delete workspace.expanded[dir];
  else {
    workspace.expanded[dir] = true;
    void loadDir(dir); // always fresh; the old listing shows meanwhile
  }
}

/** Makes `dir` the top of the tree (the breadcrumb leads back up). */
export function showFolder(dir: string): void {
  workspace.treeRoot = dir;
  if (!workspace.dirs[dir]) void loadDir(dir);
}

export function setShowHidden(show: boolean): void {
  workspace.showHidden = show;
  workspace.files = null;
}

/** Every file in the project for quick-open, relative to the project. */
export async function loadFileList(): Promise<string[]> {
  const all = workspace.showHidden ? '&all=1' : '';
  const { files } = await getJson<{ files: string[] }>(`/api/fs/files?path=${q(workspace.project!)}${all}`);
  return (workspace.files = files);
}

export async function createEntry(dir: string, kind: 'file' | 'folder'): Promise<void> {
  const name = prompt(kind === 'file' ? 'New file name' : 'New folder name')?.trim();
  if (!name) return;
  const path = `${dir}/${name}`;
  try {
    if (kind === 'folder') await sendJson('/api/fs/mkdir', { path });
    else await api(`/api/fs/file?path=${q(path)}`, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: '' });
  } catch (err) {
    return toast(message(err));
  }
  workspace.expanded[dir] = true;
  await loadDir(dir);
  if (kind === 'file' && (await openFile(path))) ui.tab = 'editor';
}

export async function renameEntry(path: string): Promise<void> {
  const old = basename(path);
  const name = prompt(`Rename "${old}" to`, old)?.trim();
  if (!name || name === old) return;
  const to = `${parentOf(path)}/${name}`;
  try {
    await sendJson('/api/fs/rename', { from: path, to });
  } catch (err) {
    return toast(message(err));
  }
  renamePaths(path, to);
  forgetTree(path);
  await loadDir(parentOf(path));
}

export async function deleteEntry(path: string, isDir: boolean): Promise<void> {
  if (!confirm(`Move the ${isDir ? 'folder' : 'file'} "${basename(path)}" to the Recycle Bin?`)) return;
  try {
    await sendJson('/api/fs/delete', { path });
  } catch (err) {
    return toast(message(err));
  }
  forgetPaths(path);
  forgetTree(path);
  await loadDir(parentOf(path));
  toast(`Moved "${basename(path)}" to the Recycle Bin`);
}

/** Drops cached listings at or under `path` after it was renamed or deleted. */
function forgetTree(path: string): void {
  const under = (p: string) => p === path || p.startsWith(path + '/');
  for (const dir of Object.keys(workspace.dirs)) if (under(dir)) delete workspace.dirs[dir];
  for (const dir of Object.keys(workspace.expanded)) if (under(dir)) delete workspace.expanded[dir];
  if (under(workspace.treeRoot) && workspace.project) showFolder(workspace.project);
}

const isVisible = (dir: string): boolean =>
  dir === workspace.treeRoot || (dir.startsWith(workspace.treeRoot + '/') && !!workspace.expanded[dir] && isVisible(parentOf(dir)));

/** Catches up with changes on disk: `paths` from the watcher, or null for "anything may have changed". */
function refresh(paths: string[] | null): void {
  workspace.files = null;
  const touches = (target: string) =>
    !paths || paths.some((p) => p === target || parentOf(p) === target || target.startsWith(p + '/'));
  for (const dir of Object.keys(workspace.dirs)) {
    if (!touches(dir)) continue;
    if (isVisible(dir)) void loadDir(dir);
    else delete workspace.dirs[dir]; // reloaded when it's next expanded
  }
  for (const doc of editor.docs) {
    if (!paths || paths.some((p) => doc.path === p || doc.path.startsWith(p + '/'))) void checkFile(doc.path);
  }
}

onEvent((event) => {
  if (!workspace.project) return;
  if (event.type === 'connected') {
    // A fresh socket (first connect, or back from the background): watch again and catch up.
    send({ type: 'watch', project: workspace.project });
    refresh(null);
  } else if (event.type === 'fs' && event.project === workspace.project) refresh(event.paths);
});
