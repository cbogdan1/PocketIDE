import { execFile } from 'node:child_process';
import { spawn, type IPty, type IWindowsPtyForkOptions } from 'node-pty';

/**
 * node-pty 1.1.0 forgets a terminal as soon as its shell exits without closing the pseudoconsole, so every
 * exited terminal would leave a conhost.exe running (and a reader thread in this process). We note which
 * conhost.exe each terminal started and end it, plus the reader, once the shell has exited. This reaches
 * into node-pty internals, so the version is pinned in package.json.
 */
export interface Pty {
  proc: IPty;
  /** Ends the shell and everything it started (the whole process tree). */
  killTree(): void;
}

// Conhosts are matched to terminals as "the new one", so a spawn waits until the previous match is done.
let previousMatch: Promise<unknown> = Promise.resolve();
const owned = new Set<number>();

export async function spawnPty(file: string, args: string[], options: IWindowsPtyForkOptions): Promise<Pty> {
  await previousMatch;
  const proc = spawn(file, args, options);
  const conhosts = headlessConhosts().then((pids) => {
    const mine = pids.filter((pid) => !owned.has(pid));
    for (const pid of mine) owned.add(pid);
    return mine;
  });
  previousMatch = conhosts;
  proc.onExit(async () => {
    for (const pid of await conhosts) {
      owned.delete(pid);
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    (proc as unknown as { _agent?: { _conoutSocketWorker?: { dispose(): void } } })._agent?._conoutSocketWorker?.dispose();
  });
  return {
    proc,
    // taskkill /T follows parent links, so it also ends detached children that a console-only kill misses.
    killTree: () => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {}),
  };
}

/** PIDs of the pseudoconsole hosts (conhost.exe --headless) this process has started. */
function headlessConhosts(): Promise<number[]> {
  const filter = `ParentProcessId=${process.pid} and Name='conhost.exe' and CommandLine like '%--headless%'`;
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "${filter}").ProcessId`],
      { windowsHide: true },
      (err, stdout) => resolve(err ? [] : stdout.split(/\s+/).filter(Boolean).map(Number)),
    ),
  );
}
