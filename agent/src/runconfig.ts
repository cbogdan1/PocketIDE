import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { onPath } from './shells.ts';

export type RunType = 'web' | 'desktop' | 'task';
export type RunShell = 'cmd' | 'powershell' | 'pwsh' | 'bash';

export interface RunConfig {
  name: string;
  type: RunType;
  command: string;
  /** web: the port the server listens on; it's "ready" once something accepts connections there. */
  port?: number;
  /** desktop: the window to capture (milestone 6). */
  windowTitle?: string;
  /** Folder to run in, relative to the project (default: the project). */
  cwd?: string;
  env?: Record<string, string>;
  /** Default: cmd. */
  shell?: RunShell;
}

export interface ProjectConfig {
  configs: RunConfig[];
  default?: string;
}

export const CONFIG_FILE = 'pocketide.json';
const TYPES = ['web', 'desktop', 'task'];
const SHELLS = ['cmd', 'powershell', 'pwsh', 'bash'];
const KEYS = ['name', 'type', 'command', 'port', 'windowTitle', 'cwd', 'env', 'shell'];

/** Parses pocketide.json; `errors` explains every problem in words the user can act on. */
export function parseProjectConfig(text: string): { config?: ProjectConfig; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  const errors = validateProjectConfig(data);
  return errors.length ? { errors } : { config: data as ProjectConfig, errors };
}

export function validateProjectConfig(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ['The file must contain an object like { "configs": [...] }'];
  for (const key of Object.keys(data)) if (key !== 'configs' && key !== 'default') errors.push(`Unknown setting "${key}" (expected "configs" and "default")`);
  if (!Array.isArray(data.configs) || !data.configs.length) return [...errors, '"configs" must be a list with at least one configuration'];
  const names = new Set<string>();
  data.configs.forEach((c: unknown, i: number) => {
    const at = `Configuration ${i + 1}`;
    if (!isObject(c)) return errors.push(`${at} must be an object`);
    const label = typeof c.name === 'string' && c.name.trim() ? `"${c.name}"` : at;
    for (const key of Object.keys(c)) if (!KEYS.includes(key)) errors.push(`${label}: unknown field "${key}" (fields: ${KEYS.join(', ')})`);
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 60) errors.push(`${at}: "name" must be a short text`);
    else if (names.has(c.name)) errors.push(`${label}: the name is used twice`);
    else names.add(c.name);
    if (!TYPES.includes(c.type as string)) errors.push(`${label}: "type" must be "web", "desktop" or "task"`);
    if (typeof c.command !== 'string' || !c.command.trim()) errors.push(`${label}: "command" is missing`);
    if (c.type === 'web' && c.port === undefined) errors.push(`${label}: a web configuration needs a "port"`);
    if (c.port !== undefined && !(Number.isInteger(c.port) && (c.port as number) >= 1 && (c.port as number) <= 65535)) {
      errors.push(`${label}: "port" must be a number from 1 to 65535`);
    }
    if (c.windowTitle !== undefined && typeof c.windowTitle !== 'string') errors.push(`${label}: "windowTitle" must be text`);
    if (c.cwd !== undefined && (typeof c.cwd !== 'string' || isAbsolute(c.cwd) || c.cwd.includes(':') || c.cwd.split(/[\\/]/).includes('..'))) {
      errors.push(`${label}: "cwd" must be a folder inside the project, like "client"`);
    }
    if (c.env !== undefined && !(isObject(c.env) && Object.values(c.env).every((v) => typeof v === 'string'))) {
      errors.push(`${label}: "env" must be an object of texts, like { "PORT": "3000" }`);
    }
    if (c.shell !== undefined && !SHELLS.includes(c.shell as string)) errors.push(`${label}: "shell" must be one of ${SHELLS.join(', ')}`);
  });
  if (data.default !== undefined && !(typeof data.default === 'string' && names.has(data.default))) {
    errors.push(`"default" must be the name of one of the configurations`);
  }
  return errors;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface Tools {
  c?: string;
  cpp?: string;
  rustc?: string;
  python?: string;
  make?: string;
  dotnet?: string;
  cargo?: string;
}

/** Finds compilers and runtimes on PATH (by file, not by running them, except a 5s probe of a Store alias). */
export async function findTools(): Promise<Tools> {
  const first = (...exes: string[]) => exes.map((e) => onPath(e) && basename(e, '.exe')).find(Boolean) || undefined;
  return {
    c: first('gcc.exe', 'clang.exe'),
    cpp: first('g++.exe', 'clang++.exe'),
    rustc: first('rustc.exe'),
    python: first('py.exe') ?? (await realPython()),
    make: first('make.exe', 'mingw32-make.exe'),
    dotnet: first('dotnet.exe'),
    cargo: first('cargo.exe'),
  };
}

/** python.exe, unless it's only the Microsoft Store alias that offers to install Python. */
async function realPython(): Promise<string | undefined> {
  const file = onPath('python.exe');
  if (!file) return;
  if (!/\\WindowsApps\\/i.test(file)) return 'python';
  const ok = await new Promise<boolean>((resolve) =>
    execFile(file, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(!err && stdout.startsWith('Python'))),
  );
  return ok ? 'python' : undefined;
}

/** Sensible configurations for a project without pocketide.json. */
export async function detectConfigs(dir: string, tools: Tools): Promise<RunConfig[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const has = (name: string) => names.some((n) => n.toLowerCase() === name.toLowerCase());
  const configs: RunConfig[] = [];

  if (has('package.json')) {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}')) as { scripts?: Record<string, string> };
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
    for (const script of ['dev', 'start', 'build', 'test']) {
      if (typeof scripts[script] !== 'string') continue;
      const command = runner === 'npm' && script !== 'start' && script !== 'test' ? `npm run ${script}` : `${runner} ${script}`;
      const web = script === 'dev' || script === 'start';
      configs.push(web ? { name: script, type: 'web', command, port: guessPort(scripts[script]) } : { name: script, type: 'task', command });
    }
  }
  const project = names.find((n) => /\.csproj$/i.test(n)) ?? names.find((n) => /\.sln$/i.test(n));
  if (project) {
    const text = /\.csproj$/i.test(project) ? await readFile(join(dir, project), 'utf8').catch(() => '') : '';
    const gui = /<OutputType>\s*WinExe|<UseWPF>\s*true|<UseWindowsForms>\s*true/i.test(text);
    configs.push(
      { name: 'dotnet run', type: gui ? 'desktop' : 'task', command: 'dotnet run' },
      { name: 'dotnet build', type: 'task', command: 'dotnet build' },
    );
  }
  if (has('Cargo.toml')) {
    configs.push(
      { name: 'cargo run', type: 'task', command: 'cargo run' },
      { name: 'cargo build', type: 'task', command: 'cargo build' },
      { name: 'cargo test', type: 'task', command: 'cargo test' },
    );
  }
  for (const file of ['main.py', 'app.py']) {
    if (has(file)) configs.push({ name: file, type: 'task', command: `${tools.python ?? 'py'} -u ${file}` });
  }
  if (has('Makefile')) configs.push({ name: 'make', type: 'task', command: tools.make ?? 'make' });
  return configs;
}

/** The port a dev-server script will use: an explicit --port/-p/PORT=, else the tool's default. */
export function guessPort(script: string): number {
  const explicit = /(?:--port[= ]|-p |PORT=)(\d{2,5})\b/.exec(script);
  if (explicit) return Number(explicit[1]);
  if (/\bastro\b/.test(script)) return 4321;
  if (/\b(vite|svelte-kit)\b/.test(script)) return 5173;
  if (/\bng serve\b/.test(script)) return 4200;
  return 3000; // next, react-scripts, express apps and most others
}

/** What "Run current file" needs for each kind of file, and how to tell the user it's missing. */
const RUNNERS: Record<string, { tool?: keyof Tools; missing?: string }> = {
  '.c': { tool: 'c', missing: 'No C compiler found (gcc or clang). Install MinGW-w64 or LLVM and add its bin folder to PATH.' },
  '.cpp': { tool: 'cpp', missing: 'No C++ compiler found (g++ or clang++). Install MinGW-w64 or LLVM and add its bin folder to PATH.' },
  '.rs': { tool: 'rustc', missing: 'Rust (rustc) is not installed. Install it from rustup.rs.' },
  '.py': { tool: 'python', missing: 'Python is not installed (the "python" in WindowsApps only opens the Microsoft Store). Install it from python.org.' },
  '.js': {},
  '.ts': {},
  '.ps1': {},
};
const ALIASES: Record<string, string> = { '.cc': '.cpp', '.cxx': '.cpp', '.mjs': '.js', '.cjs': '.js', '.mts': '.ts', '.cts': '.ts' };

export const runnableFile = (name: string) => !!RUNNERS[ALIASES[extname(name).toLowerCase()] ?? extname(name).toLowerCase()];

/**
 * The cmd.exe command that compiles (into `outDir`) and runs `name`, from the file's own folder, so compiler
 * errors name it as `name:line`. `unbuffered` is a C file that turns off stdout buffering: through a pipe C
 * buffers everything until exit, so a prompt before scanf would never show. Throws the missing-tool message.
 */
export function fileCommand(name: string, tools: Tools, outDir: string, unbuffered: string): string {
  const ext = ALIASES[extname(name).toLowerCase()] ?? extname(name).toLowerCase();
  const runner = RUNNERS[ext];
  if (!runner) throw new Error(`Can't run ${ext || 'these'} files. Supported: C, C++, Rust, Python, JavaScript, TypeScript, PowerShell.`);
  const tool = runner.tool && tools[runner.tool];
  if (runner.tool && !tool) throw new Error(runner.missing);
  const exe = `"${join(outDir, basename(name, extname(name)))}.exe"`;
  const src = `"${name}"`;
  switch (ext) {
    case '.c':
    case '.cpp':
      return `${tool} -g -fdiagnostics-color=always ${src} "${unbuffered}" -o ${exe} && ${exe}`;
    case '.rs':
      return `rustc --color=always ${src} -o ${exe} && ${exe}`;
    case '.py':
      return `${tool} -u ${src}`;
    case '.ps1':
      return `powershell -NoProfile -ExecutionPolicy Bypass -File ${src}`;
    default:
      return `node ${src}`;
  }
}
