# PocketIDE

A self-hosted, mobile-first remote dev environment: it runs on your Windows PC and you use it from your
iPhone as an installable web app. You get your project's files, a terminal, Run/Stop, logs and a preview
of the app you're building, not the whole desktop. It is reachable only inside your Tailscale network.

**Status: milestone 4 of 7.** Login, an installable app shell, a file browser, a code editor that stays in
sync with changes made on the PC, terminals that keep running while your phone is away (good enough to
drive Claude Code from the phone), and Run/Stop/Restart with live logs. The Preview tab is a placeholder for now.

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

**Terminal tab**

- Windows PowerShell (or PowerShell 7 when installed), Command Prompt and Git Bash, in the current project's
  folder; *Open terminal here* on any folder in the Files tab. UTF-8 output, `TERM=xterm-256color`, true color.
- Terminals run on the PC, not in the app: they keep going when the phone locks, loses signal or closes the app.
  When you come back, the screen is restored exactly (colors, cursor, full-screen programs like Claude Code)
  along with 5,000 lines of scrollback. **Terminals do not survive restarting the agent** (or the PC).
- Tabs: *+* for a new terminal, long-press a tab to rename or close it. Closing a running terminal asks first and
  ends everything started in it, child processes included. Up to 8 terminals; a finished one shows its exit code
  and disappears after an hour. Programs can name their tab (Claude Code does).
- A dot marks tabs with new output, and the Terminal icon shows how many have some.
- Extra key row: `Esc Tab ⇧Tab Ctrl Alt ← ↑ ↓ → ⏎ ^C | ~ / \ -` and *Paste*. Ctrl and Alt latch for the next key
  (tap Ctrl, then type `c`); arrows repeat while held. Esc, ⇧Tab, the arrows and ⏎ drive Claude Code's menus
  and modes.
- Typing works with the iOS keyboard's predictive text, autocorrect and dictation without doubled or lost
  characters; smart quotes and dashes arrive as plain `"` `'` `-`.
- Drag to scroll back; a button jumps back to the bottom. *⋯ → Select text to copy* shows everything as plain
  text you can select with the iOS handles. *Paste* reads the clipboard (or offers a field to paste into if iOS
  refuses). Tapping a link opens it in Safari. Text size is in the *⋯* menu and is remembered per device.
- `clear` / `cls` also clear the history, as in VS Code; so does *⋯ → Clear terminal* (in PowerShell and Git
  Bash it sends Ctrl+L, so it works inside programs like Claude Code too).
- Several devices can watch the same terminal; the one used last decides its size, and every device shows the
  same screen at that size. Rotating, the keyboard and switching tabs don't duplicate or lose lines.
- While the keyboard is up, the app's header is hidden to give the terminal more rows.

**Run, Stop, Restart (header) and the Logs tab**

- The header shows the project's selected run configuration with a status dot (grey idle or finished, amber
  starting or stopping, green running, glowing green when a web server is ready, red failed, plus the exit
  code) and ▶ Run, or ↻ Restart and ■ Stop while it runs. Tap the name to pick another configuration. Several
  configurations can run at the same time.
- Configurations come from `pocketide.json` in the project folder:

  ```json
  {
    "configs": [
      { "name": "Dev server", "type": "web", "command": "npm run dev", "port": 5173 },
      { "name": "Desktop app", "type": "desktop", "command": "dotnet run", "windowTitle": "MyApp" },
      { "name": "Tests", "type": "task", "command": "npm test", "cwd": "client", "env": { "CI": "1" } }
    ],
    "default": "Dev server"
  }
  ```

  `web` is a server with a port (it's *ready* once something listens there), `desktop` a program with a window
  (it opens on the PC's screen), `task` something that runs and finishes. Optional: `cwd` (a folder inside the
  project), `env`, `shell` (`cmd` by default, or `powershell`, `pwsh`, `bash`). Mistakes are explained in the
  header's menu and when you save the file.
- Without `pocketide.json`, configurations are guessed from `package.json` scripts (dev, start, build, test),
  `*.csproj`/`*.sln`, `Cargo.toml`, `main.py`/`app.py` and a `Makefile`; *Save these as pocketide.json* keeps
  them. *Edit configurations* is a form; *Edit pocketide.json* opens the file in the editor.
- **Run current file** (▶ in the editor) for single-file programs: C and C++ (gcc/g++ or clang), Rust (rustc),
  Python, JavaScript/TypeScript (node) and PowerShell. Compiled programs go to a temporary folder. Unsaved
  changes are saved first. A missing compiler is named, with where to get it.
- Logs keep the last 10,000 lines of each run on the PC, so reopening the app shows them; the last 3 finished
  runs of each configuration stay too. Colors are kept, errors (stderr) have a red edge, timestamps can be
  turned on, and a filter shows only matching lines. *Copy all* and *Clear* are in the `⋯` menu.
- A program that asks for input (`scanf`, `input()`) gets it from the field under the log.
- `file:line` in compiler and runtime output (gcc/clang, rustc/cargo, tsc, dotnet, Python and Node.js
  tracebacks) is a link that opens the file at that line.
- Run switches to the Logs tab (turn that off in its `⋯` menu). A run that finishes while you're elsewhere
  puts a badge on the Logs tab, red if it failed.
- Stop asks first, like pressing Ctrl+C, then Ctrl+Break; whatever still runs after a few seconds is ended,
  including programs it started. A desktop app's windows are asked to close.
- Runs keep going while the phone is away. **They are stopped when the agent stops** (Ctrl+C in its window,
  closing the window, or restarting the PC).

## Setup on the PC (Windows 10/11)

Prerequisite: Node.js 22.18 or newer (24 LTS recommended). The agent runs its TypeScript directly, with no
build step.

```powershell
cd C:\Workspace\remote_dev
npm install
npm run build      # builds the web client into client/dist
npm start          # first run asks you to choose a password
```

`npm install` warns that `node-pty` has install scripts that were not run. That's expected: it ships prebuilt
Windows binaries, so neither Python nor Visual Studio Build Tools are needed.

The agent listens on `http://127.0.0.1:7420` (loopback only; change it with the `PORT` env var).
Your password hash and sessions are stored in `%LOCALAPPDATA%\PocketIDE\auth.json`.

Restarting the agent (Ctrl+C, a reboot, or `npm start` again) ends every terminal and every run, and whatever
runs in them.

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

The bar with ˄ ˅ ✓ above the iOS keyboard can't be removed: iOS gives web apps (home-screen apps included) no
way to hide it, only apps wrapped in a native shell can.

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
- Limits: 2 MB per file read or saved, 64 KB for JSON requests and WebSocket messages (the app splits larger
  pastes into several messages).
- Terminal connections pass the same session, `Origin` and `Host` checks. After a logout or password change,
  an open terminal connection is dropped the next time it's used (checked at most every 10 seconds). A terminal
  is a full shell on your PC with your user's rights, and it can leave the projects folder like any shell.
- Runs only start commands from the project's `pocketide.json`, the agent's own detection, or "Run current file"
  for a file inside the projects folder: the app never sends a command line. Whoever can edit `pocketide.json`
  (you, from the editor) can put any command there, just as in a terminal.
- Settings (projects folder, last project, open tabs) are stored in `%LOCALAPPDATA%\PocketIDE\config.json`.
  `"terminalScrollback": 5000` there sets how many lines each terminal keeps.

## Development

```powershell
npm test           # node:test: sandboxing, save conflicts, Recycle Bin, terminals, runs (config validation,
                   # detection, tree stop, statuses, log buffer, port readiness, stdin, C and Python), log links, auth
npm run check      # tsc (agent) + svelte-check (client)
```

Two tests use the real Recycle Bin and remove their items from it afterwards, so test files run one at a time.

Layout: `agent/` is the Node.js server (plain `node:http` + `ws`). `client/` is the PWA (Svelte 5 + Vite).

## Decisions

- **Svelte 5** for the client: a small runtime and simple wiring for imperative widgets (CodeMirror, xterm.js,
  and later the capture canvas). The app is about 160 KB gzipped, mostly CodeMirror; each language, and
  xterm.js (about 95 KB), is a separate chunk loaded on first use.
- **Terminals: `node-pty` 1.1.0 with a headless xterm.js mirror per terminal.** The mirror sees every byte the
  shell prints; when the app attaches, the agent sends the mirror's serialized state (screen, scrollback,
  cursor, modes) instead of replaying raw output, which garbles full-screen programs. Closing a terminal uses
  `taskkill /T`, which also catches detached child processes.
- **The ConPTY that ships inside `node-pty`** (`conpty.dll` + `OpenConsole.exe`, `useConptyDll`), not the one
  built into Windows: Windows 10's can't re-wrap lines when the width changes (rotating duplicated lines) and
  never passes `clear` on, so the history stayed. The bundled one does both, and waits for the terminal to
  answer its startup queries, which the mirror does (the app's xterm.js stays quiet so answers don't arrive
  twice). `node-pty` is pinned: when a shell exits, the agent closes node-pty's leftover pipes and reader
  thread, which relies on its internals.
- **The agent decides the size.** Devices only propose what fits their screen; the size change goes into the
  output stream at an exact point, for the shell, the mirror and every device alike, so all of them lay out the
  same bytes at the same size. Devices never resize on their own: that is what used to leave ghost lines.
- **xterm.js adjustments, identical in the mirror and the app** (`termProtocol.ts`): the `windowsPty` option
  (when the screen grows, ConPTY adds empty rows instead of pulling history back, and so must xterm.js); "scroll
  up" (CSI S, which ConPTY sends for Enter on the last row) moves lines into the history like xterm and
  Windows Terminal instead of dropping them; and snapshots drop the serialize addon's zero-length cursor moves,
  which terminals read as one column and which left stray characters after a restore.
- **Clear terminal** sends Ctrl+L, so the program redraws itself (PowerShell scrolls the old screen into the
  history), then clears the history once the program's output pauses.
- **Terminal output flow control:** output is batched every 16 ms into binary WebSocket frames, and the app
  acknowledges what it has drawn. A device more than 1 MB behind gets no more output until it catches up, then
  a fresh snapshot instead of the backlog. If the mirror itself falls behind, the shell is paused.
- The phone stays attached only to the terminal on screen; others send small activity events. Switching tabs
  re-attaches and restores.
- **Own keyboard handling for xterm.js:** it reads the hidden text field's changes and sends backspaces plus the
  new text, because xterm.js's own handling duplicates or drops characters when iOS predictive text or dictation
  rewrites a word. xterm.js has no touch scrolling, so the app adds it.
- **CodeMirror 6** with `@codemirror/language-data` for languages, `@replit/codemirror-lang-svelte` for Svelte
  (the official set has no Svelte grammar) and `@codemirror/merge` for the conflict diff.
- **Conflict detection with ETags**: the agent hashes the file on every read and save; a save must name the hash
  it started from (`If-Match`), and creating a file uses `If-None-Match: *`.
- **Recycle Bin through `IFileOperation`** (a small C# snippet run by Windows PowerShell): Node has no API for
  it. Unlike the usual `SHFileOperation` flags, a progress sink cancels any item that Windows would delete
  permanently instead of recycling.
- Rename, new file and delete use the system `prompt`/`confirm` dialogs: they're accessible and bring up the iOS
  keyboard reliably.
- **Runs use pipes, not a terminal**, so output is clean lines with stdout and stderr apart (stderr gets its red
  edge, timestamps are per line, filtering is simple). Programs then know they aren't in a terminal, so the agent
  asks for colors anyway (`FORCE_COLOR`, `CARGO_TERM_COLOR`, `-fdiagnostics-color`...) and for unbuffered output
  (`PYTHONUNBUFFERED`, `py -u`). C would still hold a prompt back until exit, so "Run current file" links a tiny
  `unbuffered.c` into C/C++ programs. Spinners and full-screen programs belong in the Terminal tab.
- **Each run gets a hidden console of its own** (`windowsHide`): its windows still show on the PC, and Stop can
  send that console Ctrl+C and Ctrl+Break like a keyboard would. Node can't, so `ctrl.ps1` attaches to the
  console for a moment (the same Add-Type approach as the Recycle Bin). Ctrl+Break follows because a program
  can inherit "ignore Ctrl+C", and cmd's "Terminate batch job (Y/N)?" after `npm run` is answered. As runs don't
  share the agent's console, the agent stops them itself when it exits.
- **Readiness** of a web configuration means something accepts connections on its port (IPv4 or IPv6 localhost:
  dev servers use either), checked every half second. If the port is already taken at the start, the log says so.
- **Logs stream over the events socket**, only for the run on screen, batched every 50 ms; an unfinished line
  (a prompt) is sent at once and updated as it grows. The log is a normal scrolling list (iOS's own momentum
  scrolling, so the terminal's touch code isn't needed), drawn in chunks that are skipped while off screen.
- **Rust** for the desktop-capture helper (milestone 6): it's already installed here, builds to a single `.exe`
  with no runtime, the official `windows` crate covers Windows.Graphics.Capture, D3D11 and `SendInput`, and
  without a garbage collector the frame timing stays steady. Media Foundation gives a path to H.264 later.
- Dark theme only. No service worker yet; it comes with offline handling and notifications in milestone 7.

## Roadmap

1. ✅ Skeleton: agent, auth, installable PWA over `tailscale serve`
2. ✅ File browser + editor (live sync with changes on disk)
3. ✅ Terminal (persistent sessions with exact screen restore, extra key row, works with Claude Code)
4. ✅ Process manager, logs, Run/Stop/Restart, `pocketide.json`
5. Web preview via reverse proxy (with HMR)
6. Desktop window capture + window-scoped input (plus the Windows Defender exclusion notes)
7. Polish: reconnection, performance, landscape split view, notifications, autostart via Task Scheduler

Future ideas:

- Restore deleted files (undo toast + Recently deleted list)
- Files tab UX: a *New project* button in the projects list that creates a folder directly in the projects
  root, and a *+* button in the project header to create a new file or folder in the current folder (no need to
  go up a level and long-press)
- Shared terminals with VS Code: a `pocketide` CLI (`pocketide new`, `attach`, `ls`) and a "PocketIDE" terminal
  profile in VS Code, so the same terminal session is visible in VS Code on the PC and on the phone
