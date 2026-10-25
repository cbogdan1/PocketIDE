<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Sheet, { type Action } from './Sheet.svelte';
  import { message } from './lib/api.ts';
  import {
    listeningPorts,
    openPreview,
    preview,
    previewOrigin,
    safariLink,
    setPath,
    showConfig,
    shownConfig,
    showPort,
  } from './lib/preview.svelte.ts';
  import { isActive, runSelected, runs, selectConfig, statusText, view } from './lib/runs.svelte.ts';
  import { toast, ui } from './lib/ui.svelte.ts';
  import { workspace } from './lib/workspace.svelte.ts';

  let frame = $state<HTMLIFrameElement>();
  let menu = $state<{ title: string; actions: Action[] } | null>(null);
  let address = $state('/');
  let typing = false;
  let safari: string | null = null;

  const config = $derived(preview.port === null ? shownConfig() : undefined);
  const port = $derived(preview.port ?? config?.port ?? null);
  const run = $derived(config ? runs.list.find((r) => r.kind === 'config' && r.name === config.name) : undefined);
  /** What's on screen: the page once its dev server is ready, otherwise why it isn't there. */
  const shown = $derived.by(() => {
    if (!workspace.project) return 'no-project';
    if (port === null) return 'no-target';
    if (preview.port !== null) return 'page';
    if (run?.status === 'ready') return 'page';
    if (isActive(run)) return 'starting';
    return run?.status === 'crashed' ? 'crashed' : 'stopped';
  });

  // Showing the page: ask the agent for its preview (again on every visit, cheap), and load it when it's new.
  $effect(() => {
    if (shown !== 'page' || ui.tab !== 'preview' || port === null) return;
    void openPreview(port).then((changed) => {
      if (changed || !frame?.getAttribute('src')) load(preview.path);
    });
  });

  // Full screen hides the app's header and tab bar while the Preview tab is open.
  $effect(() => {
    document.documentElement.classList.toggle('preview-full', preview.fullscreen && ui.tab === 'preview');
  });

  onMount(() => {
    // The page's script reports where it is (pushState, links, Back), for the address bar.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== previewOrigin() || e.data?.pocketide !== 'location' || typeof e.data.path !== 'string') return;
      preview.connected = true;
      setPath(e.data.path);
      if (!typing) address = e.data.path;
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  });

  function load(path: string) {
    const origin = previewOrigin();
    if (!origin || !frame) return;
    preview.connected = false;
    address = path;
    frame.src = origin + path;
  }

  function go(e: SubmitEvent) {
    e.preventDefault();
    typing = false;
    const raw = address.trim() || '/';
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    setPath(path);
    load(path);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  /** Back/Forward/Reload inside the page (through its script); without it the browser's own history does. */
  function command(name: 'back' | 'forward' | 'reload') {
    const origin = previewOrigin();
    if (preview.connected && origin && frame?.contentWindow) return frame.contentWindow.postMessage({ pocketide: name }, origin);
    if (name === 'reload') load(preview.path);
    else if (name === 'back') history.back();
    else history.forward();
  }

  function hardReload() {
    const origin = previewOrigin();
    if (!origin || !frame) return;
    preview.connected = false;
    frame.src = `${origin}/__pocketide/hard-reload?path=${encodeURIComponent(preview.path)}`;
  }

  async function pickTarget() {
    let ports: { port: number; process: string }[] = [];
    try {
      ports = await listeningPorts();
    } catch (err) {
      toast(message(err));
    }
    const actions: Action[] = runs.configs
      .filter((c) => c.type === 'web')
      .map((c) => ({ label: `${c.name} · port ${c.port}`, run: () => (selectConfig(c.name), showConfig(c.name)) }));
    for (const p of ports) actions.push({ label: `Port ${p.port} · ${p.process}`, run: () => showPort(p.port) });
    actions.push({
      label: 'Type a port…',
      run: () => {
        const typed = Number(prompt('Port on the PC (e.g. 3000)')?.trim());
        if (Number.isInteger(typed) && typed > 0 && typed < 65536) showPort(typed);
      },
    });
    menu = { title: ports.length ? 'Preview a web configuration, or a port that is listening on the PC' : 'Preview', actions };
  }

  function openMenu() {
    safari = null;
    // Fetched now: iOS only opens a new window straight from the tap.
    void safariLink().then((link) => (safari = link));
    const consoleRun = runs.list.find((r) => r.kind === 'console' && r.port === preview.opened?.port);
    menu = {
      title: previewOrigin() ?? 'Preview',
      actions: [
        { label: 'Preview another port…', run: () => void pickTarget() },
        { label: 'Hard reload (empty the cache)', run: hardReload },
        { label: 'Open in Safari', run: () => window.open(safari ?? `${previewOrigin()}${preview.path}`, '_blank', 'noopener') },
        ...(consoleRun ? [{ label: 'Open the Preview console', run: () => (void view(consoleRun.id), (ui.tab = 'logs')) }] : []),
      ],
    };
  }

  function openLogs() {
    if (!run) return;
    void view(run.id);
    ui.tab = 'logs';
  }

  function start() {
    if (!config) return;
    selectConfig(config.name);
    void runSelected(false);
  }
</script>

<div class="preview">
  {#if !preview.fullscreen}
    <div class="target">
      <button class="pick" onclick={pickTarget} aria-label="Change what is previewed">
        <span class="dot {preview.port !== null ? 'ready' : (run?.status ?? 'idle')}"></span>
        <span class="name">{preview.port !== null ? `Port ${preview.port}` : config ? `${config.name} · port ${config.port}` : 'Choose what to preview'}</span>
        <Icon name="chevronDown" size={16} />
      </button>
    </div>
    {#if shown === 'page'}
      <form class="bar" onsubmit={go}>
        <button type="button" class="icon" aria-label="Back" onclick={() => command('back')}><Icon name="back" /></button>
        <button type="button" class="icon" aria-label="Forward" onclick={() => command('forward')}><Icon name="chevron" /></button>
        <button type="button" class="icon" aria-label="Reload" onclick={() => command('reload')}><Icon name="restart" /></button>
        <input
          bind:value={address}
          onfocus={(e) => ((typing = true), e.currentTarget.select())}
          onblur={() => (typing = false)}
          aria-label="Path in the app"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="go"
        />
        <button type="button" class="icon" aria-label="Full screen" onclick={() => (preview.fullscreen = true)}><Icon name="expand" /></button>
        <button type="button" class="icon" aria-label="More preview actions" onclick={openMenu}><Icon name="more" /></button>
      </form>
    {/if}
  {/if}

  {#if preview.error && shown === 'page'}
    <p class="message error" role="alert">{preview.error}</p>
  {/if}

  <!-- Always in the page, so the app keeps its state (and HMR connection) across tab switches. -->
  <iframe bind:this={frame} title="Preview" hidden={shown !== 'page' || !!preview.error} allow="fullscreen; clipboard-read; clipboard-write"></iframe>

  {#if shown === 'no-project'}
    <p class="message">Open a project to preview it.</p>
  {:else if shown === 'no-target'}
    <div class="message">
      <p>This project has no web configuration yet.</p>
      <button class="primary" onclick={pickTarget}>Preview a port</button>
    </div>
  {:else if shown === 'starting' && run}
    <div class="message">
      <p class="spinner" aria-hidden="true"></p>
      <p>{statusText(run)}…</p>
      <button class="secondary" onclick={openLogs}>Show its log</button>
    </div>
  {:else if shown === 'crashed' && run}
    <div class="message">
      <p class="error">{config?.name} {statusText(run).toLowerCase()}.</p>
      <div class="row">
        <button class="secondary" onclick={openLogs}>Open the log</button>
        <button class="primary" disabled={runs.busy} onclick={start}>Run again</button>
      </div>
    </div>
  {:else if shown === 'stopped' && config}
    <div class="message">
      <p>{config.name} isn't running.</p>
      <div class="row">
        <button class="primary" disabled={runs.busy || !!runs.errors.length} onclick={start}>Run {config.name}</button>
        <button class="secondary" onclick={() => showPort(config.port!)}>Preview port {config.port} anyway</button>
      </div>
    </div>
  {/if}

  {#if preview.fullscreen}
    <button class="exit" aria-label="Exit full screen" onclick={() => (preview.fullscreen = false)}><Icon name="shrink" /></button>
  {/if}
</div>

{#if menu}<Sheet title={menu.title} actions={menu.actions} onclose={() => (menu = null)} />{/if}

<style>
  .preview {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .target {
    display: flex;
    padding: 0 4px 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 40px;
    border: 0;
    background: none;
    font-size: 14px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    display: flex;
    align-items: center;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  .bar input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 44px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  iframe {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    background: #fff;
  }
  iframe[hidden] {
    display: none;
  }
  .message {
    margin: 22vh 24px 0;
    text-align: center;
    color: var(--muted);
  }
  .message.error,
  .error {
    color: var(--danger);
  }
  p.message.error {
    margin: 12px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
  .secondary {
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
  }
  .spinner {
    width: 28px;
    height: 28px;
    margin: 0 auto 12px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }
  .exit {
    position: absolute;
    top: calc(env(safe-area-inset-top) + 6px);
    right: 6px;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: #161b22cc;
    color: var(--text);
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.starting,
  .dot.stopping {
    background: #d29922;
  }
  .dot.running,
  .dot.ready {
    background: var(--accent);
  }
  .dot.crashed {
    background: var(--danger);
  }
</style>
