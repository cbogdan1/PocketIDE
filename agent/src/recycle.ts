import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http.ts';

const SCRIPT = fileURLToPath(new URL('recycle.ps1', import.meta.url));

/** Moves a file or folder to the Windows Recycle Bin. Never deletes permanently: refuses instead. */
export async function moveToRecycleBin(path: string): Promise<void> {
  if (process.platform !== 'win32') throw new HttpError(501, 'Deleting needs the Windows Recycle Bin');
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      // The path goes through the environment, so no quoting rules apply to it.
      { env: { ...process.env, POCKETIDE_RECYCLE_PATH: path }, timeout: 60_000, windowsHide: true },
      (err, _stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stderr }),
    );
  });
  // Trust the disk over the exit code (a timeout can land after the move already happened).
  if (!(await lstat(path).catch(() => null))) return;
  if (code === 2) {
    throw new HttpError(409, "Windows can't put this in the Recycle Bin (too large, bin turned off, or not a local drive), so nothing was deleted");
  }
  throw new HttpError(500, `Couldn't move it to the Recycle Bin${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
}
