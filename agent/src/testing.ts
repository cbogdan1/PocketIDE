import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import WebSocket from 'ws';
import { createAuth } from './auth.ts';
import { createConfig } from './config.ts';
import { createApp } from './server.ts';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Starts an agent on a free port with the password 'correct horse', keeping its data in a fresh temp folder. */
export async function startAgent() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pocketide-')));
  mkdirSync(join(dir, 'static'));
  writeFileSync(join(dir, 'static', 'index.html'), '<h1>PocketIDE</h1>');
  const auth = createAuth(join(dir, 'auth.json')); // sits next to static/, so traversal would expose it
  await auth.setPassword('correct horse');
  const server = createApp(auth, createConfig(join(dir, 'config.json')), join(dir, 'static'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  function call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
      // Options form sends `path` verbatim (a URL string would normalize away the `..`).
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  const login = (password: string, headers: Record<string, string> = {}) =>
    call('/api/login', 'POST', { 'Content-Type': 'application/json', Origin: origin, ...headers }, JSON.stringify({ password }));

  return {
    dir,
    origin,
    server,
    call,
    login,
    /** Logs in and returns the `Cookie` header value. */
    async cookie() {
      return (await login('correct horse')).headers['set-cookie']![0].split(';')[0];
    },
    socket: (headers: Record<string, string>) => new WebSocket(`${origin.replace('http', 'ws')}/ws/events`, { headers }),
  };
}

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
