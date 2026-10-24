import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkInput, diffInput, keySequence, straighten, withModifiers } from './termio.ts';

test('pastes are split under the message limit without breaking characters', () => {
  const text = 'a'.repeat(15_999) + '😀' + 'b'.repeat(40_000);
  const chunks = chunkInput(text);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 16_000);
    assert.ok(new TextEncoder().encode(chunk).length <= 64 * 1024);
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(chunk)));
    assert.ok(!/[\ud800-\udbff]$/.test(chunk), 'no chunk ends in half an emoji');
  }
  assert.deepEqual(chunkInput(''), []);
});

test('field changes become backspaces plus new text', () => {
  assert.deepEqual(diffInput('', 'l'), { deleted: 0, inserted: 'l' });
  assert.deepEqual(diffInput('git sta', 'git status '), { deleted: 0, inserted: 'tus ' }, 'predictive completion');
  assert.deepEqual(diffInput('teh ', 'the '), { deleted: 3, inserted: 'he ' }, 'replaced word');
  assert.deepEqual(diffInput('ls -la', 'ls -l'), { deleted: 1, inserted: '' });
  assert.deepEqual(diffInput('hi 😀', 'hi 😃'), { deleted: 1, inserted: '😃' }, 'emoji count as one character');
});

test('smart punctuation comes back as ASCII', () => {
  assert.equal(straighten('echo “hi” ‘there’ — a – b…'), `echo "hi" 'there' -- a - b...`);
});

test('keys and modifiers encode like xterm', () => {
  assert.equal(keySequence('Tab', { shift: true }), '\x1b[Z', 'Shift+Tab');
  assert.equal(keySequence('Escape', {}), '\x1b');
  assert.equal(keySequence('Enter', {}), '\r');
  assert.equal(keySequence('ArrowUp', {}), '\x1b[A');
  assert.equal(keySequence('ArrowUp', {}, true), '\x1bOA', 'application cursor mode');
  assert.equal(keySequence('ArrowLeft', { ctrl: true }), '\x1b[1;5D');
  assert.equal(keySequence('Delete', {}), '\x1b[3~');
  assert.equal(keySequence('a', {}), undefined, 'text keys arrive as input');
  assert.equal(withModifiers('c', { ctrl: true }), '\x03');
  assert.equal(withModifiers('C', { ctrl: true }), '\x03');
  assert.equal(withModifiers('\\', { ctrl: true }), '\x1c');
  assert.equal(withModifiers('b', { alt: true }), '\x1bb');
  assert.equal(withModifiers('/', {}), '/');
});
