<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Sheet, { type Action } from './Sheet.svelte';
  import { longpress } from './lib/longpress.ts';
  import {
    closeTerminal,
    getView,
    loadTerminals,
    mountTerminal,
    newTerminal,
    pasteFromClipboard,
    renameTerminal,
    setActive,
    setFontSize,
    terms,
  } from './lib/terminals.svelte.ts';
  import type { Mods } from './lib/termio.ts';
  import { ui } from './lib/ui.svelte.ts';
  import { workspace } from './lib/workspace.svelte.ts';

  interface Key {
    label: string;
    aria?: string;
    key?: string;
    mods?: Mods;
    sticky?: 'ctrl' | 'alt';
    repeat?: boolean;
    paste?: boolean;
  }

  // Esc, Shift+Tab, arrows and Enter drive Claude Code's menus and modes, so they come first.
  const KEYS: Key[] = [
    { label: 'Esc', key: 'Escape' },
    { label: 'Tab', key: 'Tab' },
    { label: '⇧Tab', aria: 'Shift Tab', key: 'Tab', mods: { shift: true } },
    { label: 'Ctrl', sticky: 'ctrl' },
    { label: 'Alt', sticky: 'alt' },
    { label: '←', aria: 'Left', key: 'ArrowLeft', repeat: true },
    { label: '↑', aria: 'Up', key: 'ArrowUp', repeat: true },
    { label: '↓', aria: 'Down', key: 'ArrowDown', repeat: true },
    { label: '→', aria: 'Right', key: 'ArrowRight', repeat: true },
    { label: '⏎', aria: 'Enter', key: 'Enter' },
    { label: '^C', aria: 'Control C', key: 'c', mods: { ctrl: true } },
    ...['|', '~', '/', '\\', '-'].map((ch) => ({ label: ch, key: ch })),
    { label: 'Paste', paste: true },
  ];

  let host: HTMLDivElement;
  let mounted = false;
  let unmount: (() => void) | undefined;
  let menu = $state<{ title: string; actions: Action[] } | null>(null);
  let selecting = $state(false);
  let selectText = $state('');
  let selectBox = $state<HTMLPreElement>();
  let pasteDialog = $state<HTMLDialogElement>();
  let pasteText = $state('');
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;
  let repeated = false;

  const active = $derived(terms.list.find((t) => t.id === terms.active));
  const defaultShell = $derived(terms.shells[0]);

  onMount(() => void loadTerminals());
  onDestroy(() => unmount?.());

  // xterm.js measures its font when it opens, so it's created the first time a terminal is on screen.
  $effect(() => {
    if (mounted || ui.tab !== 'terminal' || !terms.active) return;
    mounted = true;
    void mountTerminal(host).then((cleanup) => (unmount = cleanup));
  });

  // Looking at a terminal clears its activity dot.
  $effect(() => {
    if (ui.tab === 'terminal' && terms.active) delete terms.unseen[terms.active];
  });

  function press(k: Key) {
    if (k.sticky) {
      terms[k.sticky] = !terms[k.sticky];
      return;
    }
    if (k.paste) return void paste();
    getView()?.input.press(k.key!, k.mods);
  }

  function holdStart(k: Key) {
    repeated = false;
    if (!k.repeat) return;
    holdTimer = setTimeout(() => {
      repeated = true;
      press(k);
      repeatTimer = setInterval(() => press(k), 70);
    }, 350);
  }

  function holdEnd() {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
  }

  async function paste() {
    if (await pasteFromClipboard()) return;
    // iOS refused clipboard access: offer a field to paste into by hand.
    pasteText = '';
    await tick();
    pasteDialog?.showModal();
  }

  function sendPaste() {
    if (pasteText) getView()?.term.paste(pasteText);
    pasteDialog?.close();
    getView()?.term.focus(); // back to typing, e.g. Enter to run what was pasted
  }

  async function startSelect() {
    selectText = getView()?.plainText() ?? '';
    selecting = true;
    await tick();
    if (selectBox) selectBox.scrollTop = selectBox.scrollHeight;
  }

  function tabMenu(id: string) {
    const term = terms.list.find((t) => t.id === id);
    menu = {
      title: term?.title ?? 'Terminal',
      actions: [
        { label: 'Rename', run: () => renameTerminal(id) },
        { label: 'Close terminal', danger: true, run: () => closeTerminal(id) },
      ],
    };
  }

  function moreMenu() {
    const actions: Action[] = [];
    if (active) {
      actions.push(
        { label: 'Select text to copy', run: startSelect },
        { label: 'Paste', run: paste },
        { label: `Larger text (${terms.fontSize + 1}px)`, run: () => setFontSize(terms.fontSize + 1) },
        { label: `Smaller text (${terms.fontSize - 1}px)`, run: () => setFontSize(terms.fontSize - 1) },
      );
    }
    for (const shell of terms.shells) actions.push({ label: `New ${shell.label}`, run: () => newTerminal(workspace.project, shell.id) });
    if (active) actions.push({ label: 'Rename', run: () => renameTerminal(active.id) }, { label: 'Close terminal', danger: true, run: () => closeTerminal(active.id) });
    menu = { title: active?.title ?? 'Terminal', actions };
  }

  /** Key-row buttons must not take focus from the terminal, or the iOS keyboard would close. */
  const keepFocus = (e: PointerEvent) => e.preventDefault();
</script>

<div class="terminal">
  <div class="bar">
    <div class="tabs" role="tablist" aria-label="Terminals">
      {#each terms.list as t (t.id)}
        <div class="tab" class:active={t.id === terms.active} use:longpress={() => tabMenu(t.id)}>
          <button role="tab" aria-selected={t.id === terms.active} onclick={() => setActive(t.id)}>
            <span class="title">{t.title}</span>
            {#if !t.running}<span class="exit">exit {t.exitCode}</span>{/if}
            {#if terms.unseen[t.id]}<span class="dot" role="img" aria-label="new output"></span>{/if}
          </button>
          <button class="close" aria-label="Close {t.title}" onclick={() => closeTerminal(t.id)}><Icon name="close" size={16} /></button>
        </div>
      {/each}
    </div>
    <button
      class="icon"
      aria-label="New terminal"
      disabled={terms.list.length >= terms.max && terms.list.every((t) => t.running)}
      onclick={() => newTerminal(workspace.project)}
    >
      <Icon name="plus" />
    </button>
    <button class="icon" aria-label="Terminal actions" onclick={moreMenu}><Icon name="more" /></button>
  </div>

  <div class="screen">
    <div class="host" bind:this={host} class:hidden={!terms.active}></div>
    {#if !terms.list.length}
      <div class="empty">
        <p>No terminals running.</p>
        {#each terms.shells as shell (shell.id)}
          <button class:primary={shell === defaultShell} onclick={() => newTerminal(workspace.project, shell.id)}>
            {shell.label}{workspace.project ? ` in ${workspace.project}` : ''}
          </button>
        {/each}
      </div>
    {/if}
    {#if terms.active && !terms.atBottom && !selecting}
      <button class="bottom" aria-label="Jump to the bottom" onclick={() => getView()?.term.scrollToBottom()}>
        <Icon name="down" />
      </button>
    {/if}
    {#if selecting}
      <div class="select">
        <div class="bar">
          <span>Touch and hold to select, then Copy.</span>
          <button class="primary" onclick={() => (selecting = false)}>Done</button>
        </div>
        <pre bind:this={selectBox}>{selectText}</pre>
      </div>
    {/if}
  </div>

  {#if terms.active}
    <div class="keys" role="toolbar" aria-label="Terminal keys">
      {#each KEYS as k (k.label)}
        <button
          tabindex="-1"
          aria-label={k.aria}
          aria-pressed={k.sticky ? terms[k.sticky] : undefined}
          class:wide={k.label.length > 2}
          onpointerdown={(e) => {
            keepFocus(e);
            holdStart(k);
          }}
          onpointerup={holdEnd}
          onpointercancel={holdEnd}
          onpointerleave={holdEnd}
          onclick={() => !(k.repeat && repeated) && press(k)}
        >
          {k.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if menu}
  <Sheet title={menu.title} actions={menu.actions} onclose={() => (menu = null)} />
{/if}

<dialog bind:this={pasteDialog} class="paste" aria-label="Paste into the terminal">
  <p>PocketIDE can't read the clipboard. Touch and hold below, choose Paste, then send it.</p>
  <!-- svelte-ignore a11y_autofocus -->
  <textarea bind:value={pasteText} rows="6" autofocus autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
  <div class="buttons">
    <button onclick={() => pasteDialog?.close()}>Cancel</button>
    <button class="primary" disabled={!pasteText} onclick={sendPaste}>Send to terminal</button>
  </div>
</dialog>

<style>
  .terminal {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: clip;
  }
  /* The tabs scroll sideways; "+" and "⋯" stay put at the right. */
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .tabs {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    flex: none;
    display: flex;
    align-items: center;
    max-width: 55vw;
    border-right: 1px solid var(--border);
    color: var(--muted);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .tab.active {
    background: var(--bg);
    color: var(--text);
    box-shadow: inset 0 -2px var(--accent);
  }
  .tab button {
    min-height: 44px;
    border: 0;
    background: none;
    color: inherit;
  }
  .tab button[role='tab'] {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 4px 0 12px;
    font-size: 14px;
    white-space: nowrap;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .exit {
    color: var(--muted);
    font-size: 12px;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .close {
    display: grid;
    place-items: center;
    width: 36px;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .bar > .icon:last-child {
    margin-left: auto;
  }
  .screen {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  /*
   * clip, not hidden: iOS scrolls "hidden" boxes to reveal the focused input, which would shift the terminal.
   * The terminal can be larger than this box while another device sets its size; then its top shows.
   */
  .host {
    position: absolute;
    inset: 4px 0 0 6px;
    overflow: clip;
  }
  .host.hidden {
    visibility: hidden;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--muted);
  }
  .empty button:not(.primary) {
    padding: 10px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
  }
  .bottom {
    position: absolute;
    right: 16px;
    bottom: 12px;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 2px 10px #0008;
  }
  .select {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .select .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
  }
  .select .bar .primary {
    padding: 8px 16px;
  }
  .select pre {
    flex: 1;
    margin: 0;
    padding: 8px;
    overflow: auto;
    font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-all;
    -webkit-user-select: text;
    user-select: text;
  }
  .keys {
    flex: none;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    touch-action: pan-x;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .keys button {
    flex: 1 0 auto;
    min-width: 40px;
    height: 44px;
    border: 0;
    border-right: 1px solid var(--border);
    background: none;
    font: 16px ui-monospace, Menlo, monospace;
    -webkit-user-select: none;
    user-select: none;
  }
  .keys button.wide {
    min-width: 50px;
    font: 14px -apple-system, system-ui, sans-serif;
  }
  .keys button[aria-pressed='true'] {
    background: var(--accent);
    color: #052e16;
  }
  .keys button:active {
    background: var(--border);
  }
  .paste {
    width: min(480px, calc(100% - 32px));
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
  }
  .paste::backdrop {
    background: #0009;
  }
  .paste p {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 14px;
  }
  .paste textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    font: 16px ui-monospace, Menlo, monospace;
  }
  .paste .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .paste .buttons button:not(.primary) {
    padding: 10px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
  }
</style>
