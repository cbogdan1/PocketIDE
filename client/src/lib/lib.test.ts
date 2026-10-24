import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyFilter, fuzzyScore } from './fuzzy.ts';
import { detectIndent, fromDisk, toDisk } from './text.ts';

test('fuzzy matching prefers file names, word starts and short paths', () => {
  const paths = ['src/domain/maintenance.ts', 'src/main.ts', 'agent/src/main.ts', 'README.md', 'src/lib/viewport.ts'];
  assert.deepEqual(fuzzyFilter('main', paths).slice(0, 2), ['src/main.ts', 'agent/src/main.ts']);
  assert.equal(fuzzyFilter('vpt', paths)[0], 'src/lib/viewport.ts');
  assert.equal(fuzzyFilter('srcmain', paths)[0], 'src/main.ts', 'matches across folders too');
  assert.equal(fuzzyScore('xyz', 'src/main.ts'), -1);
  assert.deepEqual(fuzzyFilter('', paths), paths, 'an empty query keeps everything');
});

test('fromDisk/toDisk keep BOMs and CRLF line endings', () => {
  for (const raw of ['plain\nfile\n', '﻿bom\r\nand crlf\r\n', '', 'no newline']) {
    const { text, bom, eol } = fromDisk(raw);
    // CodeMirror joins lines with \n, whatever the file used.
    assert.equal(toDisk(text.replace(/\r\n/g, '\n'), bom, eol), raw);
  }
  assert.deepEqual(fromDisk('﻿a\r\nb'), { text: 'a\r\nb', bom: true, eol: '\r\n' });
});

test('detectIndent finds tabs, 2 or 4 spaces, and ignores doc-comment alignment', () => {
  assert.equal(detectIndent('a\n\tb\n\t\tc\n'), '\t');
  assert.equal(detectIndent('a {\n  b\n    c\n}\n'), '  ');
  assert.equal(detectIndent('/**\n * doc\n */\nclass A {\n    m() {\n        x\n    }\n}\n'), '    ');
  assert.equal(detectIndent('no indentation'), '  ');
});
