import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Resolves `rel` (leading slashes ignored) against `root`; null if the result would escape `root`. */
export function resolveInside(root: string, rel: string): string | null {
  // ':' only appears in drive letters and NTFS alternate data streams (file.txt:hidden).
  if (rel.includes('\0') || rel.includes(':')) return null;
  const base = resolve(root);
  const full = resolve(base, rel.replace(/^[/\\]+/, ''));
  const prefix = base.endsWith(sep) ? base : base + sep;
  return full === base || full.startsWith(prefix) ? full : null;
}

/**
 * Like resolveInside, but also follows symlinks and junctions: null unless the real location of the
 * entry (or, if it doesn't exist yet, of its folder) is inside the real `root`. Returns the entry under
 * its real folder, so a rename or delete acts on a link itself rather than on its target.
 */
export async function resolveReal(root: string, rel: string): Promise<string | null> {
  const full = resolveInside(root, rel);
  if (full === null) return null;
  const realRoot = await realpath(root);
  if (full === resolve(root)) return realRoot;
  const parent = await realpath(dirname(full));
  if (!contains(realRoot, parent)) return null;
  const entry = join(parent, basename(full));
  const real = await realpath(entry).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    // Missing is fine (it may be about to be created), but not a dangling link: writing would follow it.
    return (await lstat(entry).catch(() => null)) ? null : entry;
  });
  return real !== null && contains(realRoot, real) ? entry : null;
}

function contains(root: string, path: string): boolean {
  // Windows paths are case-insensitive.
  const [r, p] = process.platform === 'win32' ? [root.toLowerCase(), path.toLowerCase()] : [root, path];
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

/** True if `name` works as a single file or folder name on Windows. */
export function isValidName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) && // Windows silently strips these
    !RESERVED.test(name)
  );
}
