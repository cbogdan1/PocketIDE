import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveInside } from './paths.ts';

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
  ];
  for (const rel of escapes) assert.equal(resolveInside(root, rel), null, rel);
});
