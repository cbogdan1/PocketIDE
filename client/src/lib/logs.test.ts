import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnsi, stripAnsi } from './ansi.ts';
import { findFileRefs, resolveRef } from './fileLinks.ts';

test('ANSI colors become styled segments; other escapes are dropped', () => {
  assert.deepEqual(parseAnsi('plain'), [{ text: 'plain', style: '' }]);
  assert.deepEqual(parseAnsi('a \x1b[1;31merror\x1b[0m b'), [
    { text: 'a ', style: '' },
    { text: 'error', style: 'color:#ff7b72;font-weight:bold' },
    { text: ' b', style: '' },
  ]);
  assert.deepEqual(parseAnsi('\x1b[38;5;196mx\x1b[38;2;1;2;3my\x1b[39mz'), [
    { text: 'x', style: 'color:rgb(255,0,0)' },
    { text: 'y', style: 'color:rgb(1,2,3)' },
    { text: 'z', style: '' },
  ]);
  assert.equal(stripAnsi('\x1b]0;title\x07\x1b[2K\x1b[1G\x1b[32m✓\x1b[39m done'), '✓ done');
});

test('file:line references from compilers and runtimes', () => {
  const refs = (text: string) => findFileRefs(text).map((r) => [text.slice(r.start, r.end), r.path, r.line, r.col]);
  assert.deepEqual(refs("main.c:5:12: error: expected ';' before 'return'"), [['main.c:5:12', 'main.c', 5, 12]]);
  assert.deepEqual(refs('  --> src/main.rs:2:5'), [['src/main.rs:2:5', 'src/main.rs', 2, 5]]);
  assert.deepEqual(refs('src/app.ts(3,7): error TS2322: Type'), [['src/app.ts(3,7)', 'src/app.ts', 3, 7]]);
  assert.deepEqual(refs('src/app.ts:3:7 - error TS2322'), [['src/app.ts:3:7', 'src/app.ts', 3, 7]]);
  assert.deepEqual(refs('C:\\Work\\App\\Program.cs(10,5): error CS1002: ; expected [C:\\Work\\App\\App.csproj]'), [
    ['C:\\Work\\App\\Program.cs(10,5)', 'C:\\Work\\App\\Program.cs', 10, 5],
  ]);
  assert.deepEqual(refs('  File "C:\\Work\\py\\main.py", line 3, in <module>'), [
    ['File "C:\\Work\\py\\main.py", line 3', 'C:\\Work\\py\\main.py', 3, undefined],
  ]);
  assert.deepEqual(refs('    at run (file:///C:/Work/app/index.js:10:5)'), [['file:///C:/Work/app/index.js:10:5', 'C:/Work/app/index.js', 10, 5]]);
  assert.deepEqual(refs('Local: http://localhost:5173/ and https://example.com:8080/x'), [], 'URLs are not files');
  assert.deepEqual(refs('at node:internal/modules/cjs/loader:1228:14'), [], 'no extension, not a file');
});

test('references resolve inside the projects folder only', () => {
  const root = 'C:\\Work';
  assert.equal(resolveRef('main.c', 'app/src', root), 'app/src/main.c');
  assert.equal(resolveRef('..\\lib\\x.ts', 'app/src', root), 'app/lib/x.ts');
  assert.equal(resolveRef('C:\\work\\app\\Program.cs', 'app', root), 'app/Program.cs');
  assert.equal(resolveRef('C:/Work/app/index.js', 'app', root), 'app/index.js');
  assert.equal(resolveRef('C:\\Windows\\x.c', 'app', root), null);
  assert.equal(resolveRef('../../x.c', 'app', root), null);
});
