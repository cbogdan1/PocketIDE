import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuth, createLimiter, SESSION_TTL_MS } from './auth.ts';

test('passwords verify, sessions expire, and a new password logs everyone out', async (t) => {
  const auth = createAuth(join(mkdtempSync(join(tmpdir(), 'pocketide-')), 'auth.json'));
  assert.equal(auth.hasPassword(), false);
  await auth.setPassword('first password');
  assert.equal(await auth.checkPassword('first password'), true);
  assert.equal(await auth.checkPassword('first passwor'), false);

  const token = auth.createSession();
  assert.equal(auth.isValidSession(token), true);
  assert.equal(auth.isValidSession(token + 'x'), false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + SESSION_TTL_MS + 1 });
  assert.equal(auth.isValidSession(token), false);
  t.mock.timers.reset();

  const other = auth.createSession();
  await auth.setPassword('second password');
  assert.equal(auth.isValidSession(other), false);
  assert.equal(await auth.checkPassword('first password'), false);
});

test('limiter blocks after max attempts until the window ends', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const limiter = createLimiter(2, 1000);
  assert.equal(limiter.hit('a'), 0);
  assert.equal(limiter.hit('a'), 0);
  assert.equal(limiter.hit('a'), 1000);
  assert.equal(limiter.hit('b'), 0, 'other clients are unaffected');
  t.mock.timers.tick(1000);
  assert.equal(limiter.hit('a'), 0);
});
