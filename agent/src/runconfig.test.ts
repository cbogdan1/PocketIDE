import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectConfigs, fileCommand, guessPort, parseProjectConfig, runnableFile, type Tools } from './runconfig.ts';

test('pocketide.json: a valid file parses', () => {
  const { config, errors } = parseProjectConfig(
    JSON.stringify({
      configs: [
        { name: 'Dev server', type: 'web', command: 'npm run dev', port: 5173 },
        { name: 'Desktop app', type: 'desktop', command: 'dotnet run', windowTitle: 'MyApp', cwd: 'app', shell: 'powershell' },
        { name: 'Tests', type: 'task', command: 'npm test', env: { CI: '1' } },
      ],
      default: 'Dev server',
    }),
  );
  assert.deepEqual(errors, []);
  assert.equal(config!.configs.length, 3);
  assert.equal(config!.default, 'Dev server');
});

test('pocketide.json: every problem is explained', () => {
  const errors = (text: string) => parseProjectConfig(text).errors;
  assert.match(errors('{ "configs": [ }')[0], /^Not valid JSON/);
  assert.match(errors('[]')[0], /must contain an object/);
  assert.match(errors('{}')[0], /at least one configuration/);
  const many = errors(
    JSON.stringify({
      configs: [
        { name: 'Web', type: 'web', command: 'x' },
        { name: 'Web', type: 'server', comand: 'y' },
        { name: 'T', type: 'task', command: 'z', port: 70000, cwd: '../other', env: { A: 1 }, shell: 'zsh' },
      ],
      default: 'Nope',
      extra: true,
    }),
  );
  for (const expected of [
    /Unknown setting "extra"/,
    /"Web": a web configuration needs a "port"/,
    /"Web": the name is used twice/,
    /"Web": unknown field "comand"/,
    /"type" must be "web", "desktop" or "task"/,
    /"command" is missing/,
    /"T": "port" must be a number from 1 to 65535/,
    /"T": "cwd" must be a folder inside the project/,
    /"T": "env" must be an object of texts/,
    /"T": "shell" must be one of/,
    /"default" must be the name of one of the configurations/,
  ]) {
    assert.ok(many.some((e) => expected.test(e)), `expected an error like ${expected}, got:\n${many.join('\n')}`);
  }
  assert.match(errors(JSON.stringify({ configs: [{ name: 'A', type: 'task', command: 'x', cwd: 'C:\\x' }] }))[0], /"cwd"/);
});

test('configurations are detected from the project files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketide-detect-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', test: 'node --test', lint: 'x' } }));
  writeFileSync(join(dir, 'App.csproj'), '<Project><PropertyGroup><OutputType>WinExe</OutputType><UseWPF>true</UseWPF></PropertyGroup></Project>');
  writeFileSync(join(dir, 'Cargo.toml'), '[package]');
  writeFileSync(join(dir, 'main.py'), 'print(1)');
  writeFileSync(join(dir, 'Makefile'), 'all:');
  const configs = await detectConfigs(dir, { python: 'py', make: 'mingw32-make' });
  assert.deepEqual(
    configs.map((c) => [c.name, c.type, c.command, c.port]),
    [
      ['dev', 'web', 'npm run dev', 5173],
      ['build', 'task', 'npm run build', undefined],
      ['test', 'task', 'npm test', undefined],
      ['dotnet run', 'desktop', 'dotnet run', undefined],
      ['dotnet build', 'task', 'dotnet build', undefined],
      ['cargo run', 'task', 'cargo run', undefined],
      ['cargo build', 'task', 'cargo build', undefined],
      ['cargo test', 'task', 'cargo test', undefined],
      ['main.py', 'task', 'py -u main.py', undefined],
      ['make', 'task', 'mingw32-make', undefined],
    ],
  );
  const empty = mkdtempSync(join(tmpdir(), 'pocketide-detect-'));
  mkdirSync(join(empty, 'src'));
  assert.deepEqual(await detectConfigs(empty, {}), []);
});

test('dev server ports are guessed from the script', () => {
  assert.equal(guessPort('vite --port 4000'), 4000);
  assert.equal(guessPort('next dev -p 3001'), 3001);
  assert.equal(guessPort('cross-env PORT=8080 node server.js'), 8080);
  assert.equal(guessPort('vite'), 5173);
  assert.equal(guessPort('astro dev'), 4321);
  assert.equal(guessPort('ng serve'), 4200);
  assert.equal(guessPort('node server.js'), 3000);
});

test('"Run current file" commands, and a clear message when a compiler is missing', () => {
  const tools: Tools = { c: 'gcc', cpp: 'g++', rustc: 'rustc', python: 'py' };
  const cmd = (name: string, t = tools) => fileCommand(name, t, 'C:\\out', 'C:\\agent\\unbuffered.c');
  assert.equal(cmd('main.c'), 'gcc -g -fdiagnostics-color=always "main.c" "C:\\agent\\unbuffered.c" -o "C:\\out\\main.exe" && "C:\\out\\main.exe"');
  assert.match(cmd('a b.cpp'), /^g\+\+ .*"a b\.cpp".* -o "C:\\out\\a b\.exe" && "C:\\out\\a b\.exe"$/);
  assert.equal(cmd('x.rs'), 'rustc --color=always "x.rs" -o "C:\\out\\x.exe" && "C:\\out\\x.exe"');
  assert.equal(cmd('app.py'), 'py -u "app.py"');
  assert.equal(cmd('tool.mjs'), 'node "tool.mjs"');
  assert.equal(cmd('tool.ts'), 'node "tool.ts"');
  assert.match(cmd('s.ps1'), /^powershell -NoProfile -ExecutionPolicy Bypass -File "s\.ps1"$/);
  assert.throws(() => cmd('main.c', {}), /No C compiler found \(gcc or clang\)/);
  assert.throws(() => cmd('x.py', {}), /Python is not installed/);
  assert.throws(() => cmd('notes.txt'), /Can't run \.txt files/);
  assert.ok(runnableFile('Main.CPP') && runnableFile('a.cts') && !runnableFile('README.md'));
});
