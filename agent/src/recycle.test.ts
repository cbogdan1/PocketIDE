import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { moveToRecycleBin } from './recycle.ts';
import { findInRecycleBin, purgeFromRecycleBin } from './testing.ts';

test('moves files and folders to the Recycle Bin instead of deleting them', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pocketide-')));
  const file = join(dir, "it's a $file & ünïcode.txt"); // the path must survive the trip to PowerShell
  const folder = join(dir, 'folder');
  writeFileSync(file, 'keep me');
  mkdirSync(join(folder, 'sub'), { recursive: true });
  writeFileSync(join(folder, 'sub', 'a.ts'), 'export {}');
  t.after(() => purgeFromRecycleBin([...findInRecycleBin(file), ...findInRecycleBin(folder)]));

  await moveToRecycleBin(file);
  await moveToRecycleBin(folder);

  assert.equal(existsSync(file), false);
  assert.equal(existsSync(folder), false);
  const [binnedFile] = findInRecycleBin(file);
  assert.ok(binnedFile, 'the file is in the Recycle Bin');
  assert.equal(readFileSync(binnedFile.data, 'utf8'), 'keep me');
  const [binnedFolder] = findInRecycleBin(folder);
  assert.ok(binnedFolder, 'the folder is in the Recycle Bin');
  assert.equal(readFileSync(join(binnedFolder.data, 'sub', 'a.ts'), 'utf8'), 'export {}');
});
