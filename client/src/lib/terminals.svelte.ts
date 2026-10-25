import { getJson, message, sendJson } from './api.ts';
import { onEvent } from './events.svelte.ts';
import type { TermView } from './termView.ts';
import { toast, ui } from './ui.svelte.ts';

export interface TermInfo {
  id: string;
  title: string;
  shell: string;
  cwd: string | null;
  running: boolean;
  exitCode: number | null;
}

const FONT_KEY = 'pocketide.terminal.fontSize';

export const terms = $state({
  list: [] as TermInfo[],
  shells: [] as { id: string; label: string }[],
  max: 8,
  active: null as string | null,
  /** Terminals with output the user hasn't looked at yet. */
  unseen: {} as Record<string, boolean>,
  /** Ctrl/Alt latched on the key row for the next key. */
  ctrl: false,
  alt: false,
  atBottom: true,
  fontSize: loadFontSize(),
});

let view: TermView | undefined;

function loadFontSize(): number {
  try {
    const px = Number(localStorage.getItem(FONT_KEY));
    return px >= 8 && px <= 28 ? px : 13;
  } catch {
    return 13;
  }
}

/**
 * Creates the xterm.js view in `host`; resolves to the cleanup for when the Terminal tab unmounts.
 * xterm.js is its own chunk, loaded the first time a terminal is shown, so the app itself starts fast.
 */
export async function mountTerminal(host: HTMLElement): Promise<() => void> {
  const { TermView } = await import('./termView.ts');
  view = new TermView(host, terms.fontSize, {
    sticky: {
      get: () => ({ ctrl: terms.ctrl, alt: terms.alt }),
      clear: () => {
        terms.ctrl = false;
        terms.alt = false;
      },
    },
    onGone: () => void loadTerminals(),
    onScrolled: (atBottom) => (terms.atBottom = atBottom),
  });
  view.attach(terms.active);
  return () => {
    view?.dispose();
    view = undefined;
  };
}

export const getView = () => view;

export async function loadTerminals(): Promise<void> {
  try {
    const data = await getJson<{ terminals: TermInfo[]; shells: { id: string; label: string }[]; max: number }>('/api/terminals');
    Object.assign(terms, { list: data.terminals, shells: data.shells, max: data.max });
    for (const id of Object.keys(terms.unseen)) if (!data.terminals.some((t) => t.id === id)) delete terms.unseen[id];
    if (!data.terminals.some((t) => t.id === terms.active)) setActive(data.terminals[0]?.id ?? null);
  } catch (err) {
    toast(message(err));
  }
}

export function setActive(id: string | null): void {
  terms.active = id;
  if (id) delete terms.unseen[id];
  terms.atBottom = true;
  view?.attach(id);
}

/** Starts a terminal in `cwd` (root-relative; the projects folder if omitted) and shows it. */
export async function newTerminal(cwd?: string | null, shell?: string): Promise<void> {
  const { cols, rows } = view?.term ?? { cols: 80, rows: 24 };
  try {
    const info = await sendJson<TermInfo>('/api/terminals', { cwd: cwd ?? '', shell, cols, rows });
    terms.list.push(info);
    setActive(info.id);
    ui.tab = 'terminal';
  } catch (err) {
    toast(message(err));
  }
}

export async function renameTerminal(id: string): Promise<void> {
  const term = terms.list.find((t) => t.id === id);
  const title = prompt('Terminal name (empty for automatic)', term?.title ?? '');
  if (title === null) return;
  try {
    await sendJson('/api/terminals/rename', { id, title: title.trim().slice(0, 60) });
    await loadTerminals();
  } catch (err) {
    toast(message(err));
  }
}

export async function closeTerminal(id: string): Promise<void> {
  const term = terms.list.find((t) => t.id === id);
  if (term?.running && !confirm(`"${term.title}" is still running. Close it and end everything running in it?`)) return;
  try {
    await sendJson('/api/terminals/close', { id });
  } catch (err) {
    toast(message(err));
  }
  await loadTerminals();
}

export function setFontSize(px: number): void {
  terms.fontSize = Math.min(28, Math.max(8, px));
  try {
    localStorage.setItem(FONT_KEY, String(terms.fontSize));
  } catch {
    // private mode: lasts until the app closes
  }
  view?.setFontSize(terms.fontSize);
}

/** Pastes from the clipboard; false if iOS refused access (the caller then offers a text field). */
export async function pasteFromClipboard(): Promise<boolean> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) view?.term.paste(text);
    return true;
  } catch {
    return false;
  }
}

export const unseenCount = () => Object.keys(terms.unseen).length;

onEvent((event) => {
  if (event.type === 'connected') {
    // Back online (or back from the background): the list may have changed and the terminal socket is gone.
    void loadTerminals();
    view?.reconnect();
  } else if (event.type === 'terminals') void loadTerminals();
  else if (event.type === 'activity') {
    const watching = event.id === terms.active && ui.tab === 'terminal' && document.visibilityState === 'visible';
    if (!watching) terms.unseen[event.id] = true;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') view?.reconnect();
});
