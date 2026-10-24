import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentMore, indentWithTab, redo, undo } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { diff, unifiedMergeView } from '@codemirror/merge';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type StateEffect, type Text } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { api, ApiError, basename, message, q } from './api.ts';
import { loadLanguage } from './languages.ts';
import { detectIndent, fromDisk, toDisk, type DiskText } from './text.ts';
import { toast } from './ui.svelte.ts';

export interface Doc {
  /** Root-relative, e.g. "my-app/src/main.ts". */
  path: string;
  name: string;
  dirty: boolean;
  saving: boolean;
  /** ETag of the disk version the edits are based on; null means "create the file on save". */
  etag: string | null;
  /** The file changed (or vanished) on disk while this tab had unsaved edits. */
  conflict: { etag: string; disk: DiskText } | 'deleted' | null;
  showDiff: boolean;
}

interface Settings {
  wrap: boolean;
  lineNumbers: boolean;
  fontSize: number;
}

const SETTINGS_KEY = 'pocketide.editor';

export const editor = $state({ docs: [] as Doc[], active: null as string | null, settings: loadSettings() });

/** Per-tab CodeMirror state. Kept out of Svelte's $state: CodeMirror objects must not be proxied. */
interface Buffer {
  state: EditorState;
  /** The document as last loaded or saved; "dirty" means the editor differs from it. */
  saved: Text;
  bom: boolean;
  eol: string;
  scroll?: StateEffect<unknown>;
  /** A disk check arrived during a save; run it once the save is done. */
  recheck?: boolean;
}

const buffers = new Map<string, Buffer>();
const opening = new Map<string, Promise<boolean>>();
let view: EditorView | undefined;
/** Bumped by closeAll, so files still loading for a previous project are dropped. */
let epoch = 0;

const gutters = new Compartment();
const wrapping = new Compartment();
const fontSize = new Compartment();
const diffView = new Compartment();
const gutterExtensions = [lineNumbers(), foldGutter()];
const fontThemes = new Map<number, Extension>();

const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#2f4a6d' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: '#6e7681', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#ffffff0a' },
    '.cm-activeLineGutter': { color: 'var(--text)' },
    '.cm-selectionMatch': { backgroundColor: '#3fb95030' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: '#3fb95040', outline: 'none' },
    '.cm-searchMatch': { backgroundColor: '#e2c08d40', outline: '1px solid #e2c08d80' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#e2c08d90' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' },
    '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    // Touch-sized search/replace controls; 16px text keeps iOS from zooming in.
    '.cm-panel.cm-search': { padding: '6px 44px 6px 8px', fontSize: '14px' },
    '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '36px', fontSize: '14px' },
    '.cm-panel.cm-search [name=close]': { width: '40px', height: '40px', top: '4px', right: '4px', fontSize: '24px' },
    '.cm-textfield': {
      fontSize: '16px',
      padding: '6px 8px',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      backgroundColor: 'var(--bg)',
      color: 'var(--text)',
    },
    // On a phone the per-change buttons get their own row instead of covering the code.
    '.cm-deletedChunk .cm-chunkButtons': { position: 'static', display: 'flex', gap: '8px', padding: '6px 0' },
    '.cm-button, .cm-chunkButtons button': {
      minHeight: '36px',
      padding: '0 12px',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      backgroundImage: 'none',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      fontSize: '14px',
    },
  },
  { dark: true },
);

/** The same for every file; the compartments get their content from the settings when a file is shown. */
const baseExtensions: Extension = [
  gutters.of([]),
  wrapping.of([]),
  fontSize.of([]),
  diffView.of([]),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  indentOnInput(),
  syntaxHighlighting(oneDarkHighlightStyle),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search(),
  keymap.of([
    { key: 'Mod-s', preventDefault: true, run: () => (editor.active !== null && void save(editor.active), true) },
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    indentWithTab,
  ]),
  // In the diff view, "accept" keeps your version of a chunk and "reject" takes the disk's.
  EditorState.phrases.of({ Accept: 'Keep mine', Reject: 'Use disk' }),
  EditorView.updateListener.of(onUpdate),
  theme,
];

function createState(text: string, language: Extension): EditorState {
  return EditorState.create({ doc: text, extensions: [baseExtensions, indentUnit.of(detectIndent(text)), language] });
}

function settingsEffects() {
  const { wrap, lineNumbers, fontSize: px } = editor.settings;
  if (!fontThemes.has(px)) fontThemes.set(px, EditorView.theme({ '&': { fontSize: `${px}px` } }));
  return [
    gutters.reconfigure(lineNumbers ? gutterExtensions : []),
    wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
    fontSize.reconfigure(fontThemes.get(px)!),
  ];
}

function loadSettings(): Settings {
  const defaults: Settings = { wrap: true, lineNumbers: true, fontSize: 14 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  editor.settings[key] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(editor.settings));
  } catch {
    // storage unavailable (private mode): the setting lasts until the app closes
  }
  view?.dispatch({ effects: settingsEffects() });
}

/** The view only ever shows the active tab, so every update belongs to it. */
function onUpdate(update: ViewUpdate): void {
  const buf = editor.active === null ? undefined : buffers.get(editor.active);
  if (!buf) return;
  buf.state = update.state;
  const doc = update.docChanged ? find(editor.active!) : undefined;
  if (doc) doc.dirty = !update.state.doc.eq(buf.saved);
}

const find = (path: string) => editor.docs.find((d) => d.path === path);

/** Creates the editor in `parent`; returns the cleanup for when the Editor tab unmounts. */
export function mountEditor(parent: HTMLElement): () => void {
  view = new EditorView({ parent });
  show();
  return () => {
    const buf = editor.active === null ? undefined : buffers.get(editor.active);
    if (buf && view) buf.scroll = view.scrollSnapshot();
    view?.destroy();
    view = undefined;
  };
}

/** Puts the active tab into the view, with the current settings and its old scroll position. */
function show(): void {
  if (!view) return;
  const buf = editor.active === null ? undefined : buffers.get(editor.active);
  if (!buf) return view.setState(EditorState.create());
  view.setState(buf.state.update({ effects: settingsEffects() }).state);
  if (buf.scroll) view.dispatch({ effects: buf.scroll });
}

export function activate(path: string): void {
  if (path === editor.active) return;
  const current = editor.active === null ? undefined : buffers.get(editor.active);
  if (current && view) current.scroll = view.scrollSnapshot();
  editor.active = path;
  show();
}

/**
 * Opens a file in a tab, or switches to it if it's open. Resolves false if it can't be opened (binary,
 * too large, gone), after telling the user why unless `quiet`. `focus: false` opens it in the background.
 */
export function openFile(path: string, { focus = true, quiet = false } = {}): Promise<boolean> {
  if (buffers.has(path)) {
    if (focus) activate(path);
    return Promise.resolve(true);
  }
  let pending = opening.get(path);
  if (!pending) {
    pending = load(path, quiet).finally(() => opening.delete(path));
    opening.set(path, pending);
  }
  return pending.then((ok) => {
    if (ok && (focus || editor.active === null)) activate(path);
    return ok;
  });
}

async function load(path: string, quiet: boolean): Promise<boolean> {
  const started = epoch;
  try {
    const [res, language] = await Promise.all([api(`/api/fs/file?path=${q(path)}`), loadLanguage(basename(path))]);
    const disk = fromDisk(await readText(res));
    if (started !== epoch) return false;
    const state = createState(disk.text, language);
    buffers.set(path, { state, saved: state.doc, bom: disk.bom, eol: disk.eol });
    editor.docs.push({ path, name: basename(path), dirty: false, saving: false, etag: res.headers.get('ETag'), conflict: null, showDiff: false });
    return true;
  } catch (err) {
    if (!quiet) toast(message(err));
    return false;
  }
}

/** Decodes as UTF-8 but keeps a BOM, unlike Response.text(), so saving can write it back. */
async function readText(res: Response): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
}

export function closeFile(path: string, { force = false } = {}): void {
  const index = editor.docs.findIndex((d) => d.path === path);
  if (index < 0) return;
  const doc = editor.docs[index];
  if (doc.dirty && !force && !confirm(`Discard your unsaved changes to ${doc.name}?`)) return;
  editor.docs.splice(index, 1);
  buffers.delete(path);
  if (editor.active === path) {
    editor.active = (editor.docs[index] ?? editor.docs[index - 1])?.path ?? null;
    show();
  }
}

/** Closes every tab without asking; callers check confirmDiscard() first. */
export function closeAll(): void {
  epoch++;
  editor.docs = [];
  editor.active = null;
  buffers.clear();
  show();
}

export const unsavedCount = () => editor.docs.filter((d) => d.dirty).length;

/** True if nothing is unsaved, or the user agrees to lose it. */
export function confirmDiscard(action: string): boolean {
  const n = unsavedCount();
  return !n || confirm(`${n === 1 ? '1 file has' : `${n} files have`} unsaved changes. ${action} anyway and discard them?`);
}

// Browsers warn before a reload; the iOS home-screen app is suspended instead, keeping edits in memory.
addEventListener('beforeunload', (e) => {
  if (unsavedCount()) e.preventDefault();
});

export async function save(path: string): Promise<void> {
  const doc = find(path);
  const buf = buffers.get(path);
  if (!doc || !buf || doc.saving) return;
  if (doc.conflict) return toast(`${doc.name} changed on disk: choose Keep my version or Load disk version first`);
  const snapshot = buf.state.doc;
  doc.saving = true;
  try {
    const res = await api(`/api/fs/file?path=${q(path)}`, {
      method: 'PUT',
      // The agent refuses the write if the file no longer matches this ETag.
      headers: doc.etag ? { 'If-Match': doc.etag } : { 'If-None-Match': '*' },
      body: toDisk(snapshot.toString(), buf.bom, buf.eol),
    });
    doc.etag = (await res.json()).etag;
    buf.saved = snapshot;
    doc.dirty = !buf.state.doc.eq(snapshot); // typing may have continued during the save
  } catch (err) {
    if (err instanceof ApiError && (err.status === 412 || err.status === 409)) buf.recheck = true;
    toast(`${doc.name} was not saved: ${message(err)}`);
  } finally {
    doc.saving = false;
  }
  if (buf.recheck) {
    buf.recheck = false;
    await checkFile(path);
  }
}

export async function saveAll(): Promise<void> {
  await Promise.all(editor.docs.filter((d) => d.dirty).map((d) => save(d.path)));
}

/** Compares an open file with the disk: reloads it if it has no edits, otherwise flags a conflict. */
export async function checkFile(path: string): Promise<void> {
  const doc = find(path);
  const buf = buffers.get(path);
  if (!doc || !buf) return;
  if (doc.saving) {
    buf.recheck = true; // probably our own save; look again once its new ETag is known
    return;
  }
  let res: Response;
  try {
    res = await api(`/api/fs/file?path=${q(path)}`, { headers: doc.etag ? { 'If-None-Match': doc.etag } : {} });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && doc.etag) doc.conflict = 'deleted';
    return;
  }
  if (res.status === 304) {
    if (doc.conflict === 'deleted') doc.conflict = null; // it came back unchanged
    return;
  }
  const raw = await readText(res);
  const etag = res.headers.get('ETag');
  if (!etag || !find(path)) return;
  if (toDisk(buf.state.doc.toString(), buf.bom, buf.eol) === raw) {
    // The disk already has exactly what the editor shows (saved elsewhere, or a no-op write).
    Object.assign(doc, { etag, conflict: null, dirty: false });
    buf.saved = buf.state.doc;
    return;
  }
  const disk = fromDisk(raw);
  if (!doc.dirty) {
    replaceText(path, disk);
    Object.assign(doc, { etag, conflict: null });
  } else {
    doc.conflict = { etag, disk };
    if (doc.showDiff) applyDiff(doc);
  }
}

/** Swaps in the disk text as a minimal edit, so the cursor stays put (and undo can bring the old text back). */
function replaceText(path: string, disk: DiskText): void {
  const buf = buffers.get(path)!;
  const next = disk.text.replace(/\r\n?/g, '\n');
  const changes = diff(buf.state.doc.toString(), next, { scanLimit: 10_000, timeout: 200 }).map((c) => ({
    from: c.fromA,
    to: c.toA,
    insert: next.slice(c.fromB, c.toB),
  }));
  if (view && editor.active === path) view.dispatch({ changes }); // onUpdate refreshes buf.state
  else buf.state = buf.state.update({ changes }).state;
  Object.assign(buf, { saved: buf.state.doc, bom: disk.bom, eol: disk.eol });
  const doc = find(path);
  if (doc) doc.dirty = false;
}

/** Resolves a conflict in favor of the editor: the next save deliberately replaces (or recreates) the disk file. */
export function keepMine(path: string): void {
  const doc = find(path);
  if (!doc?.conflict) return;
  doc.etag = doc.conflict === 'deleted' ? null : doc.conflict.etag;
  doc.conflict = null;
  hideDiff(doc);
}

export function loadDisk(path: string): void {
  const doc = find(path);
  if (!doc?.conflict || doc.conflict === 'deleted') return;
  const { etag, disk } = doc.conflict;
  hideDiff(doc);
  replaceText(path, disk);
  Object.assign(doc, { etag, conflict: null });
}

export function toggleDiff(path: string): void {
  const doc = find(path);
  if (!doc?.conflict || doc.conflict === 'deleted') return;
  doc.showDiff = !doc.showDiff;
  applyDiff(doc);
}

function hideDiff(doc: Doc): void {
  if (!doc.showDiff) return;
  doc.showDiff = false;
  applyDiff(doc);
}

/** Shows (or removes) the disk version inline: deleted lines are the disk's, highlighted ones are yours. */
function applyDiff(doc: Doc): void {
  const disk = doc.showDiff && doc.conflict && doc.conflict !== 'deleted' ? doc.conflict.disk.text : null;
  const effects = diffView.reconfigure(disk === null ? [] : unifiedMergeView({ original: disk.replace(/\r\n?/g, '\n') }));
  if (view && editor.active === doc.path) view.dispatch({ effects });
  else {
    const buf = buffers.get(doc.path);
    if (buf) buf.state = buf.state.update({ effects }).state;
  }
}

/** Keeps tabs pointing at the right files after a rename in the file browser. */
export function renamePaths(from: string, to: string): void {
  for (const doc of editor.docs) {
    if (doc.path !== from && !doc.path.startsWith(from + '/')) continue;
    const next = to + doc.path.slice(from.length);
    buffers.set(next, buffers.get(doc.path)!);
    buffers.delete(doc.path);
    if (editor.active === doc.path) editor.active = next;
    Object.assign(doc, { path: next, name: basename(next) });
  }
}

/** After a delete in the file browser: closes untouched tabs under `path` and flags edited ones. */
export function forgetPaths(path: string): void {
  for (const doc of [...editor.docs]) {
    if (doc.path !== path && !doc.path.startsWith(path + '/')) continue;
    if (doc.dirty) doc.conflict = 'deleted';
    else closeFile(doc.path, { force: true });
  }
}

/** Inserts a key from the extra key row, as if typed (so auto-closing brackets work). */
export function typeKey(key: string): void {
  const field = document.activeElement;
  // The search and replace fields get the character instead of the document.
  if (field instanceof HTMLInputElement && field.closest('.cm-panel')) {
    field.setRangeText(key === 'Tab' ? '\t' : key, field.selectionStart ?? 0, field.selectionEnd ?? 0, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const v = view;
  if (!v) return;
  if (key === 'Tab') {
    if (!v.state.selection.main.empty) indentMore(v);
    else v.dispatch(v.state.replaceSelection(v.state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' });
    return;
  }
  const { from, to } = v.state.selection.main;
  const insert = () => v.state.update(v.state.replaceSelection(key), { scrollIntoView: true, userEvent: 'input.type' });
  if (!v.state.facet(EditorView.inputHandler).some((handler) => handler(v, from, to, key, insert))) v.dispatch(insert());
}

export function runCommand(name: 'undo' | 'redo' | 'search'): void {
  if (view) ({ undo, redo, search: openSearchPanel })[name](view);
}

/** A native prompt rather than CodeMirror's panel: iOS reliably shows the keyboard for it. */
export function goToLine(): void {
  if (!view) return;
  const { doc } = view.state;
  const input = prompt(`Go to line (1-${doc.lines})`)?.trim();
  if (!input || !/^\d+$/.test(input)) return;
  const line = doc.line(Math.min(Math.max(Number(input), 1), doc.lines));
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  view.focus();
}
