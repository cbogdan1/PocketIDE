import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './store.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;

interface AuthFile {
  password?: { salt: string; hash: string };
  /** sha256(session token) -> expiry, ms since epoch. Raw tokens are never stored. */
  sessions: Record<string, number>;
}

export type Auth = ReturnType<typeof createAuth>;

/** Password + sessions in one JSON file, re-read on every call so `npm run set-password` applies to a running agent. */
export function createAuth(file: string) {
  const read = (): AuthFile => readJsonFile(file, { sessions: {} });
  const write = (data: AuthFile) => writeJsonFile(file, data);
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');

  return {
    hasPassword: () => read().password !== undefined,

    /** Also logs out every device. */
    async setPassword(password: string) {
      const salt = randomBytes(16);
      const hash = await derive(password, salt);
      write({ password: { salt: salt.toString('base64'), hash: hash.toString('base64') }, sessions: {} });
    },

    async checkPassword(password: string) {
      const stored = read().password;
      if (!stored) return false;
      const hash = await derive(password, Buffer.from(stored.salt, 'base64'));
      return timingSafeEqual(hash, Buffer.from(stored.hash, 'base64'));
    },

    createSession(): string {
      const token = randomBytes(32).toString('base64url');
      const data = read();
      const now = Date.now();
      for (const [key, expires] of Object.entries(data.sessions)) if (expires <= now) delete data.sessions[key];
      data.sessions[digest(token)] = now + SESSION_TTL_MS;
      write(data);
      return token;
    },

    isValidSession: (token: string | undefined) =>
      token !== undefined && (read().sessions[digest(token)] ?? 0) > Date.now(),

    deleteSession(token: string) {
      const data = read();
      delete data.sessions[digest(token)];
      write(data);
    },
  };
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  // N=2^14, r=8, p=5 is one of OWASP's recommended scrypt settings.
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, 32, { N: 2 ** 14, r: 8, p: 5 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Counts login attempts per client in fixed windows. */
export function createLimiter(max: number, windowMs: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Records an attempt. Returns ms to wait if `key` is over the limit, else 0. */
    hit(key: string): number {
      const now = Date.now();
      for (const [k, a] of attempts) if (a.resetAt <= now) attempts.delete(k);
      const a = attempts.get(key) ?? { count: 0, resetAt: now + windowMs };
      attempts.set(key, a);
      return ++a.count > max ? a.resetAt - now : 0;
    },
    reset: (key: string) => void attempts.delete(key),
  };
}
