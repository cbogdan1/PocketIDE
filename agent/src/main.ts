import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.ts';
import { createConfig } from './config.ts';
import { createApp } from './server.ts';

const PORT = Number(process.env.PORT ?? 7420);
const dataDir = join(process.env.LOCALAPPDATA ?? homedir(), 'PocketIDE');
const staticDir = fileURLToPath(new URL('../../client/dist', import.meta.url));

const auth = createAuth(join(dataDir, 'auth.json'));
const setPasswordOnly = process.argv.includes('--set-password');

if (setPasswordOnly || !auth.hasPassword()) {
  if (!process.stdin.isTTY) {
    console.error('No password set. Run `npm run set-password` in a terminal first.');
    process.exit(1);
  }
  await auth.setPassword(await askNewPassword());
  console.log(`Password saved in ${dataDir} (all devices are logged out).`);
  if (setPasswordOnly) process.exit(0);
}

if (!existsSync(join(staticDir, 'index.html'))) console.warn('client/dist is missing: run `npm run build` first.');

// Loopback only: the phone reaches it through `tailscale serve`, never directly.
const app = createApp(auth, createConfig(join(dataDir, 'config.json')), staticDir);
// Runs have hidden consoles of their own, so Ctrl+C here doesn't reach them: they're stopped on the way out,
// and previews leave the tailnet.
process.on('exit', app.shutdown);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => process.exit(130));
app.listen(PORT, '127.0.0.1', () => {
  console.log(`PocketIDE agent on http://127.0.0.1:${PORT}`);
});

async function askNewPassword(): Promise<string> {
  for (;;) {
    const password = await askHidden('New PocketIDE password (8+ characters): ');
    if (password.length < 8) console.log('Too short.');
    else if ((await askHidden('Repeat it: ')) !== password) console.log('Passwords do not match.');
    else return password;
  }
}

function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130); // raw mode swallows Ctrl+C
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(input);
        }
        input = ch === '\b' || ch === '\u007f' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.on('data', onData);
  });
}
