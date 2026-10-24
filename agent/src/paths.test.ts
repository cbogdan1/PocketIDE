import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isValidName, resolveInside, resolveReal } from './paths.ts';

const root = resolve('/projects');

test('resolveInside keeps paths inside root', () => {
  assert.equal(resolveInside(root, 'app/src/main.ts'), join(root, 'app', 'src', 'main.ts'));
  assert.equal(resolveInside(root, '/assets/x.js'), join(root, 'assets', 'x.js'));
  assert.equal(resolveInside(root, 'a/../b'), join(root, 'b'));
  assert.equal(resolveInside(root, ''), root);
  assert.equal(resolveInside('C:\\', 'x'), 'C:\\x');
});

test('resolveInside rejects anything that escapes root', () => {
  const escapes = [
    '..',
    '/..',
    '../x',
    'a/../../x',
    '..\\x',
    'a\\..\\..\\x',
    '../projects-evil/x', // shares the root's name as a prefix
    'C:\\Windows\\win.ini',
    'C:/Windows',
    'D:x', // drive-relative
    'a\0b',
    'notes.txt:hidden', // NTFS alternate data stream
  ];
  for (const rel of escapes) assert.equal(resolveInside(root, rel), null, rel);
});

// Junctions need no admin rights on Windows, so they always run; file symlinks need Developer Mode.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pocketide-')));
const projects = join(tmp, 'projects');
const outside = join(tmp, 'outside');
mkdirSync(join(projects, 'app', 'src'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(projects, 'app', 'src', 'main.ts'), '');
writeFileSync(join(outside, 'secret.txt'), 'secret');
symlinkSync(outside, join(projects, 'app', 'escape'), 'junction');
symlinkSync(join(projects, 'app', 'src'), join(projects, 'app', 'src-link'), 'junction');
symlinkSync(join(outside, 'not-yet'), join(projects, 'app', 'dangling'), 'junction');

test('resolveReal follows links that stay inside the root', async () => {
  assert.equal(await resolveReal(projects, 'app/src/main.ts'), join(projects, 'app', 'src', 'main.ts'));
  assert.equal(await resolveReal(projects, 'app/src/new.ts'), join(projects, 'app', 'src', 'new.ts'), 'missing files can be created');
  assert.equal(await resolveReal(projects, 'app/src-link/main.ts'), join(projects, 'app', 'src', 'main.ts'));
  assert.equal(await resolveReal(projects, 'app/src-link'), join(projects, 'app', 'src-link'), 'the link itself, not its target');
  assert.equal(await resolveReal(projects, ''), projects);
});

test('resolveReal rejects junction and symlink escapes', async (t) => {
  for (const rel of ['app/escape', 'app/escape/secret.txt', 'app/escape/new.txt', 'app/dangling', 'app/dangling/x', '../outside/secret.txt']) {
    // Throwing (missing folder) is as safe as null: either way the caller never gets a path to act on.
    assert.equal(await resolveReal(projects, rel).catch(() => null), null, rel);
  }
  try {
    symlinkSync(join(outside, 'secret.txt'), join(projects, 'app', 'secret-link.txt'), 'file');
  } catch {
    return t.skip('file symlinks need Developer Mode or admin rights');
  }
  assert.equal(await resolveReal(projects, 'app/secret-link.txt'), null);
});

test('resolveReal works when the root itself is a junction', async () => {
  const linkedRoot = join(tmp, 'linked-root');
  symlinkSync(projects, linkedRoot, 'junction');
  assert.equal(await resolveReal(linkedRoot, 'app/src/main.ts'), join(projects, 'app', 'src', 'main.ts'));
  assert.equal(await resolveReal(linkedRoot, 'app/escape/secret.txt'), null);
});

test('isValidName rejects names Windows cannot store', () => {
  for (const ok of ['main.ts', '.gitignore', 'a b', 'connect.ts', 'nul-handler.js']) assert.equal(isValidName(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'x*', 'trailing.', 'trailing ', 'CON', 'nul.txt', 'COM1.log', 'a\nb']) {
    assert.equal(isValidName(bad), false, bad);
  }
});
