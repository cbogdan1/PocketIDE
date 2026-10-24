import { resolve, sep } from 'node:path';

/** Resolves `rel` (leading slashes ignored) against `root`; null if the result would escape `root`. */
export function resolveInside(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const base = resolve(root);
  const full = resolve(base, rel.replace(/^[/\\]+/, ''));
  const prefix = base.endsWith(sep) ? base : base + sep;
  return full === base || full.startsWith(prefix) ? full : null;
}
