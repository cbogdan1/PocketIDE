import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, parse } from 'node:path';

/** A Recycle Bin item: `info` holds its original path, `data` is the file or folder itself. */
export interface BinItem {
  info: string;
  data: string;
}

/** Recycle Bin items (on the path's drive) that were deleted from `original`. Test helper. */
export function findInRecycleBin(original: string): BinItem[] {
  const bin = join(parse(original).root, '$Recycle.Bin');
  const found: BinItem[] = [];
  for (const sid of readdirSync(bin)) {
    let names: string[];
    try {
      names = readdirSync(join(bin, sid));
    } catch {
      continue; // other users' bins
    }
    for (const name of names.filter((n) => n.startsWith('$I'))) {
      const info = join(bin, sid, name);
      if (originalPath(readFileSync(info)).toLowerCase() === original.toLowerCase()) {
        found.push({ info, data: join(bin, sid, '$R' + name.slice(2)) });
      }
    }
  }
  return found;
}

/** Permanently removes test leftovers from the Recycle Bin. */
export function purgeFromRecycleBin(items: BinItem[]): void {
  for (const item of items) {
    rmSync(item.data, { recursive: true, force: true });
    rmSync(item.info, { force: true });
  }
}

/** The original path stored in a $I file: format 2 since Windows 10, format 1 before. */
function originalPath(info: Buffer): string {
  if (info.readBigInt64LE(0) === 2n) return info.toString('utf16le', 28, 28 + (info.readInt32LE(24) - 1) * 2);
  return info.toString('utf16le', 24, 544).replace(/\0.*$/s, '');
}
