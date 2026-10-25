import { execFile } from 'node:child_process';
import { spawn, type IPty, type IWindowsPtyForkOptions } from 'node-pty';

export interface Pty {
  proc: IPty;
  /** Ends the shell and everything it started (the whole process tree). */
  killTree(): void;
}

/**
 * Starts a shell on the ConPTY that ships with node-pty (OpenConsole, as used by Windows Terminal and VS Code)
 * rather than Windows 10's built-in one, which can't re-wrap lines when the width changes (rotating the phone
 * left lines duplicated) and never passes "clear scrollback" on. It asks the terminal what it is at startup,
 * so somebody must answer: the agent's mirror does (terminals.ts).
 */
export function spawnPty(file: string, args: string[], options: IWindowsPtyForkOptions): Pty {
  const proc = spawn(file, args, { ...options, useConptyDll: true });
  // node-pty 1.1.0 keeps its reader thread and pipes after the shell has exited; release them. This reaches
  // into node-pty internals, so the version is pinned in package.json.
  proc.onExit(() => {
    const agent = (proc as unknown as { _agent?: Record<string, { dispose?(): void; destroy?(): void } | undefined> })._agent;
    agent?._conoutSocketWorker?.dispose?.();
    agent?._inSocket?.destroy?.();
    agent?._outSocket?.destroy?.();
  });
  return {
    proc,
    // taskkill /T follows parent links, so it also ends detached children that a console-only kill misses.
    killTree: () => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {}),
  };
}
