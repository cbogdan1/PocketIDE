import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface Shell {
  id: 'pwsh' | 'powershell' | 'cmd' | 'bash';
  label: string;
  file: string;
  args: string[];
  /** Whether Ctrl+L clears the screen (in cmd it just types ^L). */
  ctrlLClears: boolean;
}

const onPath = (exe: string) =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, exe)).find((file) => existsSync(file));

// UTF-8 console output, so programs that print UTF-8 bytes (git, Python) don't show up garbled.
const POWERSHELL_ARGS = ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)'];

/** Shells found on this PC, default first: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash. */
export function detectShells(): Shell[] {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const programs = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pwsh = onPath('pwsh.exe') ?? [join(programs, 'PowerShell', '7', 'pwsh.exe')].find(existsSync);
  const git = onPath('git.exe');
  // Not the bash.exe on PATH: in System32 that one starts WSL.
  const bash = [git && join(dirname(git), '..', 'bin', 'bash.exe'), join(programs, 'Git', 'bin', 'bash.exe')].find(
    (file): file is string => !!file && existsSync(file),
  );
  const shells: (Shell | undefined)[] = [
    pwsh ? { id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: POWERSHELL_ARGS, ctrlLClears: true } : undefined,
    {
      id: 'powershell',
      label: 'Windows PowerShell',
      file: join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: POWERSHELL_ARGS,
      ctrlLClears: true,
    },
    {
      id: 'cmd',
      label: 'Command Prompt',
      file: process.env.ComSpec ?? join(system, 'System32', 'cmd.exe'),
      args: ['/k', 'chcp 65001 >nul'],
      ctrlLClears: false,
    },
    bash ? { id: 'bash', label: 'Git Bash', file: bash, args: ['--login', '-i'], ctrlLClears: true } : undefined,
  ];
  return shells.filter((shell): shell is Shell => !!shell);
}
