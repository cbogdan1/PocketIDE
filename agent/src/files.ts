import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, ConfigStore, OpenFiles } from './config.ts';
import { HttpError, json, jsonBody, readBody } from './http.ts';
import { isValidName, resolveInside, resolveReal } from './paths.ts';
import { moveToRecycleBin } from './recycle.ts';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Folders the browser hides and quick-open skips unless asked: generated, heavy or tool-internal. */
export const HIDDEN = ['node_modules', '.git', 'dist', 'build', 'out', 'target', 'obj', '.next', '.svelte-kit', '__pycache__', '.venv'];
const MAX_LISTED_FILES = 20_000;
/** The folder this repo sits in (e.g. C:\Workspace): a good first guess for the projects root. */
const SUGGESTED_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type Handler = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams) => Promise<void>;

/** Routes for the projects root, the folder tree and file contents, keyed by "METHOD /path". */
export function createFileRoutes(config: ConfigStore, onRootChange: () => void): Record<string, Handler> {
  const root = () => {
    const dir = config.read().projectsRoot;
    if (!dir) throw new HttpError(409, 'Choose a projects folder first');
    return dir;
  };

  /** The real path for a root-relative path sent by the app; 403 if it would leave the projects root. */
  const target = async (rel: unknown, allowRoot = false) => {
    if (typeof rel !== 'string') throw new HttpError(400, 'Missing path');
    if (!allowRoot && resolveInside(root(), rel) === resolve(root())) throw new HttpError(400, 'Not allowed on the projects folder itself');
    const full = await resolveReal(root(), rel);
    if (full === null) throw new HttpError(403, 'That path is outside the projects folder');
    return full;
  };

  const view = (c: Config) => ({
    projectsRoot: c.projectsRoot ?? null,
    suggestedRoot: SUGGESTED_ROOT,
    hidden: HIDDEN,
    lastProject: c.lastProject ?? null,
    openFiles: c.openFiles ?? {},
  });

  return {
    'GET /api/config': async (_req, res) => json(res, 200, view(config.read())),

    'PATCH /api/config': async (req, res) => {
      const patch = await jsonBody(req);
      const next = config.read();
      if (patch.projectsRoot !== undefined) {
        const dir = patch.projectsRoot;
        if (typeof dir !== 'string' || !isAbsolute(dir) || !(await stat(dir).catch(() => null))?.isDirectory()) {
          throw new HttpError(400, 'Use the full path of an existing folder, like C:\\Workspace');
        }
        // Project names and tabs belong to the old root.
        Object.assign(next, { projectsRoot: resolve(dir), lastProject: null, openFiles: {} });
        onRootChange();
      }
      if (patch.lastProject !== undefined) {
        if (patch.lastProject !== null && !(typeof patch.lastProject === 'string' && isValidName(patch.lastProject))) {
          throw new HttpError(400, 'Invalid project');
        }
        next.lastProject = patch.lastProject;
      }
      if (patch.openFiles !== undefined) {
        if (!isOpenFiles(patch.openFiles)) throw new HttpError(400, 'Invalid open files');
        next.openFiles = { ...next.openFiles, ...patch.openFiles };
      }
      config.write(next);
      json(res, 200, view(next));
    },

    'GET /api/projects': async (_req, res) => {
      const entries = await readdir(root(), { withFileTypes: true });
      const projects = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
      json(res, 200, { projects: projects.sort(collator.compare) });
    },

    'GET /api/fs/list': async (_req, res, query) => {
      const dir = await target(query.get('path'), true);
      const entries = await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map(async (e) => ({
          name: e.name,
          // A link or junction shows as a folder if its target is one; opening it is still sandboxed.
          dir: e.isDirectory() || (e.isSymbolicLink() && !!(await stat(join(dir, e.name)).catch(() => null))?.isDirectory()),
        })),
      );
      entries.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));
      json(res, 200, { entries });
    },

    /** Every file under a folder, for quick-open. Paths are relative to that folder. */
    'GET /api/fs/files': async (_req, res, query) => {
      const base = await target(query.get('path'), true);
      const skip = query.get('all') === '1' ? [] : HIDDEN;
      const files: string[] = [];
      const dirs = [''];
      for (let i = 0; i < dirs.length && files.length < MAX_LISTED_FILES; i++) {
        for (const e of await readdir(join(base, dirs[i]), { withFileTypes: true }).catch(() => [])) {
          const rel = dirs[i] ? `${dirs[i]}/${e.name}` : e.name;
          // Dirent types don't follow links, so linked folders are never walked into.
          if (e.isDirectory()) {
            if (!skip.includes(e.name)) dirs.push(rel);
          } else if (e.isFile()) files.push(rel);
        }
      }
      json(res, 200, { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length >= MAX_LISTED_FILES });
    },

    'GET /api/fs/file': async (req, res, query) => {
      const file = await target(query.get('path'));
      const info = await stat(file);
      if (!info.isFile()) throw new HttpError(400, 'Not a file');
      if (info.size > MAX_FILE_BYTES) throw tooLarge(info.size);
      const data = await readFile(file);
      if (data.length > MAX_FILE_BYTES) throw tooLarge(data.length);
      if (data.includes(0) || !isUtf8(data)) {
        throw new HttpError(415, "This is a binary file (or text that isn't UTF-8), so it can't be opened in the editor");
      }
      const etag = etagOf(data);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
        return void res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ETag: etag, 'Cache-Control': 'no-store' });
      res.end(data);
    },

    /** Saves with If-Match: <etag from the last read or save>, or creates with If-None-Match: *. */
    'PUT /api/fs/file': async (req, res, query) => {
      const file = await target(query.get('path'));
      const body = await readBody(req, MAX_FILE_BYTES);
      if (!body) throw new HttpError(413, 'Too large to save from here (the limit is 2 MB)');
      const ifMatch = req.headers['if-match'];
      if (req.headers['if-none-match'] === '*') {
        if (!isValidName(basename(file))) throw invalidName();
        await writeFile(file, body, { flag: 'wx' });
      } else if (ifMatch) {
        // Compare with what is on disk right now, so a save never overwrites someone else's changes.
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return json(res, 412, { error: 'The file was deleted on disk' });
        const current = info.size <= MAX_FILE_BYTES ? await readFile(file) : null;
        if (!current || etagOf(current) !== ifMatch) return json(res, 412, { error: 'The file changed on disk' });
        await writeFile(file, body);
      } else {
        throw new HttpError(428, 'Saving needs If-Match, or If-None-Match: * to create a file');
      }
      json(res, 200, { etag: etagOf(body) });
    },

    'POST /api/fs/mkdir': async (req, res) => {
      const dir = await target((await jsonBody(req)).path);
      if (!isValidName(basename(dir))) throw invalidName();
      await mkdir(dir);
      json(res, 200, {});
    },

    'POST /api/fs/rename': async (req, res) => {
      const { from, to } = await jsonBody(req);
      const src = await target(from);
      const dst = await target(to);
      if (!isValidName(basename(dst))) throw invalidName();
      await lstat(src);
      // fs.rename silently replaces an existing file on Windows. A case-only rename is the same entry.
      if (src.toLowerCase() !== dst.toLowerCase() && (await lstat(dst).catch(() => null))) {
        throw new HttpError(409, 'Something with that name already exists');
      }
      await rename(src, dst);
      json(res, 200, {});
    },

    'POST /api/fs/delete': async (req, res) => {
      const full = await target((await jsonBody(req)).path);
      await lstat(full);
      await moveToRecycleBin(full);
      json(res, 200, {});
    },
  };
}

const etagOf = (data: Buffer) => `"${createHash('sha256').update(data).digest('base64url')}"`;

const tooLarge = (bytes: number) =>
  new HttpError(413, `Too large for the editor (${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB)`);

const invalidName = () => new HttpError(400, 'Names can\'t contain \\ / : * ? " < > | or end with a dot or space');

function isOpenFiles(value: unknown): value is Record<string, OpenFiles> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([project, tabs]) =>
      isValidName(project) &&
      Array.isArray(tabs?.paths) &&
      tabs.paths.length <= 100 &&
      tabs.paths.every((p: unknown) => typeof p === 'string') &&
      (tabs.active === null || typeof tabs.active === 'string'),
  );
}
