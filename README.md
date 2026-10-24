# PocketIDE

A self-hosted, mobile-first remote dev environment: it runs on your Windows PC and you use it from your
iPhone as an installable web app. You get your project's files, a terminal, Run/Stop, logs and a preview
of the app you're building, not the whole desktop. It is reachable only inside your Tailscale network.

**Status: milestone 2 of 7.** Login, an installable app shell, a file browser and a code editor that stays in
sync with changes made on the PC. The Terminal/Preview/Logs tabs are placeholders for now.

## Features

**Files tab**

- Pick a projects folder once (for example `C:\Workspace`); every folder inside it is a project. PocketIDE
  remembers the last project and its open files.
- Lazy-loaded folder tree, folders first, natural sort (`file2` before `file10`). `node_modules`, `.git`,
  `dist`, `build` and similar generated folders are hidden until you choose *Show hidden folders*.
- Breadcrumb at the top. *Show only this folder* zooms the tree into a subfolder; tap the breadcrumb to go back up.
- Long-press a row (or tap its `⋯`) for *New file*, *New folder*, *Rename* and *Move to Recycle Bin*. Deleting
  asks first and always goes to the Windows Recycle Bin; if Windows can't recycle an item (bin turned off, item
  too large, network drive), nothing is deleted.
- Quick-open (magnifier icon): fuzzy search over every file name in the project.

**Editor tab**

- CodeMirror 6 with highlighting for JS/TS/JSX/TSX, JSON, HTML, CSS, Svelte, Python, C#, Rust, Markdown, YAML,
  PowerShell and many more. Each language downloads the first time you open such a file.
- Open files as tabs (scroll the strip sideways); a dot marks unsaved changes, also on the Editor tab itself.
- *Save* and *Save all* buttons, undo/redo, search and replace, and an options row with word wrap, line numbers,
  text size, go to line and quick-open.
- A row of coding keys above the iOS keyboard: `Tab { } [ ] ( ) < > ; : " ' = /`.
- Line endings (CRLF/LF), a UTF-8 BOM and the file's indentation (tabs, 2 or 4 spaces) are kept as they are.
- Binary files, text that isn't UTF-8, and files over 2 MB are refused with a message, so they can't be corrupted.
- Closing an unsaved tab, switching project or logging out asks first.

**Working alongside Claude Code (or any other tool) on the PC**

- The open project is watched. When a file changes on disk, the tree updates; an open file without local edits
  reloads by itself (undo brings your previous text back).
- If the file has unsaved edits, a banner offers *Keep my version*, *Load disk version* or *View diff*. The diff
  shows the disk's lines in red and yours in green, with *Keep mine* / *Use disk* on each change.
- Saving sends the version (a SHA-256 ETag) the editor started from. If the file changed on disk in the meantime,
  the agent refuses the write and the banner appears: someone else's changes are never overwritten silently.
- When the app comes back from the background (iOS suspends it), it catches up on everything it missed.

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
4. Recommended for coding: *Settings → General → Keyboard → Smart Punctuation* off, so the iOS keyboard types
   straight quotes. (The coding-key row always inserts straight `"` and `'`.)

Unsaved edits live in the app's memory: they survive switching apps and short trips to the background, but not
iOS closing the app. Save before you leave it for long.

## Security model

- The agent binds to `127.0.0.1` only. The phone reaches it through `tailscale serve`, which terminates HTTPS
  with your `*.ts.net` certificate. Nothing listens on your LAN or the internet.
- The password is hashed with scrypt (OWASP parameters) and set on first run. Sessions are random 256-bit
  tokens; only their SHA-256 is stored. The cookie is `__Host-`, `HttpOnly`, `Secure` and `SameSite=Strict`.
- Logins are limited to 5 failures per 15 minutes per client, and the limit is checked before the password hash.
- Every API call and WebSocket upgrade needs a valid session. Writes and WebSocket upgrades from a foreign
  `Origin` are rejected, and requests are refused unless their `Host` is `localhost` or `*.ts.net`, which
  blocks DNS-rebinding attacks.
- File access is limited to the projects folder. Paths with `..`, drive letters, `:` (NTFS alternate data
  streams) or NUL are rejected, and every path is resolved with `realpath`, so a symlink or junction inside the
  projects folder can't lead outside it (a dangling one can't be written through either). Choose the projects
  folder with that in mind: everything under it is reachable from your phone.
- Limits: 2 MB per file read or saved, 64 KB for JSON requests and WebSocket messages.
- Settings (projects folder, last project, open tabs) are stored in `%LOCALAPPDATA%\PocketIDE\config.json`.

## Development

```powershell
npm test           # node:test: sandboxing (incl. symlink/junction escapes), save conflicts, Recycle Bin, auth, security
npm run check      # tsc (agent) + svelte-check (client)
```

Two tests use the real Recycle Bin and remove their items from it afterwards, so test files run one at a time.

Layout: `agent/` is the Node.js server (plain `node:http` + `ws`). `client/` is the PWA (Svelte 5 + Vite).

## Decisions

- **Svelte 5** for the client: a small runtime and simple wiring for imperative widgets (CodeMirror, and later
  xterm.js and the capture canvas). The app is about 160 KB gzipped, mostly CodeMirror; each language is a
  separate chunk loaded on first use.
- **CodeMirror 6** with `@codemirror/language-data` for languages, `@replit/codemirror-lang-svelte` for Svelte
  (the official set has no Svelte grammar) and `@codemirror/merge` for the conflict diff.
- **Conflict detection with ETags**: the agent hashes the file on every read and save; a save must name the hash
  it started from (`If-Match`), and creating a file uses `If-None-Match: *`.
- **Recycle Bin through `IFileOperation`** (a small C# snippet run by Windows PowerShell): Node has no API for
  it. Unlike the usual `SHFileOperation` flags, a progress sink cancels any item that Windows would delete
  permanently instead of recycling.
- Rename, new file and delete use the system `prompt`/`confirm` dialogs: they're accessible and bring up the iOS
  keyboard reliably.
- **Rust** for the desktop-capture helper (milestone 6): it's already installed here, builds to a single `.exe`
  with no runtime, the official `windows` crate covers Windows.Graphics.Capture, D3D11 and `SendInput`, and
  without a garbage collector the frame timing stays steady. Media Foundation gives a path to H.264 later.
- Dark theme only. No service worker yet; it comes with offline handling and notifications in milestone 7.

## Roadmap

1. ✅ Skeleton: agent, auth, installable PWA over `tailscale serve`
2. ✅ File browser + editor (live sync with changes on disk)
3. Terminal (persistent sessions, extra key row)
4. Process manager, logs, Run/Stop/Restart, `pocketide.json`
5. Web preview via reverse proxy (with HMR)
6. Desktop window capture + window-scoped input (plus the Windows Defender exclusion notes)
7. Polish: reconnection, performance, landscape split view, notifications, autostart via Task Scheduler
