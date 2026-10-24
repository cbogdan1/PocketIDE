# PocketIDE

A self-hosted, mobile-first remote dev environment: it runs on your Windows PC and you use it from your
iPhone as an installable web app. You get your project's files, a terminal, Run/Stop, logs and a preview
of the app you're building, not the whole desktop. It is reachable only inside your Tailscale network.

**Status: milestone 1 of 7.** Agent, login, and an installable app shell with a live connection indicator.
The Files/Editor/Terminal/Preview/Logs tabs are placeholders for now.

## Setup on the PC (Windows 10/11)

Prerequisite: Node.js 22.18 or newer (24 LTS recommended). The agent runs its TypeScript directly, with no
build step.

```powershell
cd C:\Workspace\remote_dev
npm install
npm run build      # builds the web client into client/dist
npm start          # first run asks you to choose a password
```

The agent listens on `http://127.0.0.1:7420` (loopback only; change it with the `PORT` env var).
Your password hash and sessions are stored in `%LOCALAPPDATA%\PocketIDE\auth.json`.

- Change the password: `npm run set-password` (this also logs out every device; it works while the agent is running).
- Keep the PC awake: set *Settings → System → Power & sleep → Sleep* to *Never* while plugged in.

## Tailscale (HTTPS, private to your tailnet)

1. Install Tailscale on the PC (`winget install --id Tailscale.Tailscale -e`, or from tailscale.com/download) and sign in.
2. In the [admin console → DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**.
3. Publish the agent to your tailnet:

   ```powershell
   tailscale serve --bg http://127.0.0.1:7420
   tailscale serve status          # prints your URL: https://<pc-name>.<tailnet>.ts.net
   ```

   The `--bg` setting persists across reboots. To remove it, run `tailscale serve reset`.

Never use `tailscale funnel` for PocketIDE: that exposes it to the public internet.

## iPhone

1. Install the Tailscale app, sign in with the same account and switch it on.
2. In Safari, open `https://<pc-name>.<tailnet>.ts.net` and sign in.
3. Tap Share → **Add to Home Screen**, then open PocketIDE from the home screen. It runs full-screen.
   Home-screen apps keep their own cookies, so you sign in once more there. After that it stays signed in
   for 30 days.

## Security model

- The agent binds to `127.0.0.1` only. The phone reaches it through `tailscale serve`, which terminates HTTPS
  with your `*.ts.net` certificate. Nothing listens on your LAN or the internet.
- The password is hashed with scrypt (OWASP parameters) and set on first run. Sessions are random 256-bit
  tokens; only their SHA-256 is stored. The cookie is `__Host-`, `HttpOnly`, `Secure` and `SameSite=Strict`.
- Logins are limited to 5 failures per 15 minutes per client, and the limit is checked before the password hash.
- Every API call and WebSocket upgrade needs a valid session. Writes and WebSocket upgrades from a foreign
  `Origin` are rejected, and requests are refused unless their `Host` is `localhost` or `*.ts.net`, which
  blocks DNS-rebinding attacks.

## Development

```powershell
npm test           # node:test: path sandboxing, auth, HTTP/WebSocket security checks
npm run check      # tsc (agent) + svelte-check (client)
```

Layout: `agent/` is the Node.js server (plain `node:http` + `ws`). `client/` is the PWA (Svelte 5 + Vite).

## Decisions

- **Svelte 5** for the client: a small bundle (about 17 KB gzipped today) and simple wiring for the imperative
  widgets ahead (CodeMirror, xterm.js, the capture canvas).
- **Rust** for the desktop-capture helper (milestone 6): it's already installed here, builds to a single `.exe`
  with no runtime, the official `windows` crate covers Windows.Graphics.Capture, D3D11 and `SendInput`, and
  without a garbage collector the frame timing stays steady. Media Foundation gives a path to H.264 later.
- Dark theme only. No service worker yet; it comes with offline handling and notifications in milestone 7.

## Roadmap

1. ✅ Skeleton: agent, auth, installable PWA over `tailscale serve`
2. File browser + editor
3. Terminal (persistent sessions, extra key row)
4. Process manager, logs, Run/Stop/Restart, `pocketide.json`
5. Web preview via reverse proxy (with HMR)
6. Desktop window capture + window-scoped input (plus the Windows Defender exclusion notes)
7. Polish: reconnection, performance, landscape split view, notifications, autostart via Task Scheduler
