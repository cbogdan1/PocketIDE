<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { parentOf } from './lib/api.ts';
  import {
    activate,
    closeFile,
    editor,
    goToLine,
    keepMine,
    loadDisk,
    mountEditor,
    runCommand,
    save,
    saveAll,
    setSetting,
    toggleDiff,
    typeKey,
    type Doc,
  } from './lib/editor.svelte.ts';
  import { openQuickOpen, ui } from './lib/ui.svelte.ts';

  const KEYS = ['Tab', '{', '}', '[', ']', '(', ')', '<', '>', ';', ':', '"', "'", '=', '/'];

  let host: HTMLDivElement;
  let tabStrip = $state<HTMLDivElement>();
  let showSettings = $state(false);

  const active = $derived(editor.docs.find((d) => d.path === editor.active));
  const unsaved = $derived(editor.docs.filter((d) => d.dirty).length);

  onMount(() => mountEditor(host));

  // Keep the active tab in view in the strip.
  $effect(() => {
    if (!editor.active) return;
    tabStrip?.querySelector(`[data-path="${CSS.escape(editor.active)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  /** The file name, plus its folder when another open tab has the same name. */
  function label(doc: Doc) {
    const twin = editor.docs.some((d) => d !== doc && d.name === doc.name);
    return twin ? `${doc.name} · ${parentOf(doc.path).split('/').pop()}` : doc.name;
  }

  /** Toolbar and key-row buttons must not take focus from the editor, or the iOS keyboard would close. */
  const keepFocus = (e: PointerEvent) => e.preventDefault();
</script>

<div class="editor">
  {#if editor.docs.length}
    <div class="tabs" role="tablist" aria-label="Open files" bind:this={tabStrip}>
      {#each editor.docs as doc (doc.path)}
        <div class="tab" class:active={doc.path === editor.active} data-path={doc.path}>
          <button role="tab" aria-selected={doc.path === editor.active} title={doc.path} onclick={() => activate(doc.path)}>
            {label(doc)}
            {#if doc.dirty}<span class="dot" role="img" aria-label="unsaved"></span>{/if}
          </button>
          <button class="close" aria-label="Close {doc.name}" onclick={() => closeFile(doc.path)}><Icon name="close" size={16} /></button>
        </div>
      {/each}
    </div>

    <div class="toolbar">
      <button class="icon" aria-label="Undo" onpointerdown={keepFocus} onclick={() => runCommand('undo')}><Icon name="undo" /></button>
      <button class="icon" aria-label="Redo" onpointerdown={keepFocus} onclick={() => runCommand('redo')}><Icon name="redo" /></button>
      <button class="icon" aria-label="Search and replace" onclick={() => runCommand('search')}><Icon name="search" /></button>
      <button class="icon" aria-label="Editor options" aria-expanded={showSettings} onclick={() => (showSettings = !showSettings)}>
        <Icon name="settings" />
      </button>
      <span class="spacer"></span>
      {#if unsaved > 1}
        <button class="secondary" onpointerdown={keepFocus} onclick={saveAll}>Save all ({unsaved})</button>
      {/if}
      <button
        class="primary"
        disabled={!active?.dirty || active.saving || !!active.conflict}
        onpointerdown={keepFocus}
        onclick={() => active && save(active.path)}
      >
        {active?.saving ? 'Saving…' : 'Save'}
      </button>
    </div>

    {#if showSettings}
      <div class="options">
        <button aria-pressed={editor.settings.wrap} onclick={() => setSetting('wrap', !editor.settings.wrap)}>Wrap</button>
        <button aria-pressed={editor.settings.lineNumbers} onclick={() => setSetting('lineNumbers', !editor.settings.lineNumbers)}>Line numbers</button>
        <span class="size">
          <button aria-label="Smaller text" onclick={() => setSetting('fontSize', Math.max(10, editor.settings.fontSize - 1))}>A−</button>
          <span aria-live="polite">{editor.settings.fontSize}px</span>
          <button aria-label="Larger text" onclick={() => setSetting('fontSize', Math.min(24, editor.settings.fontSize + 1))}>A+</button>
        </span>
        <button onclick={goToLine}>Go to line</button>
        <button onclick={openQuickOpen}>Find file</button>
      </div>
    {/if}

    {#if active?.conflict === 'deleted'}
      <div class="banner" role="alert">
        <p><strong>{active.name}</strong> was deleted on disk.</p>
        <div>
          <button onclick={() => keepMine(active.path)}>Keep my version</button>
          <button onclick={() => closeFile(active.path, { force: true })}>Close tab</button>
        </div>
      </div>
    {:else if active?.conflict}
      <div class="banner" role="alert">
        <p><strong>{active.name}</strong> changed on disk while you were editing.</p>
        <div>
          <button onclick={() => keepMine(active.path)}>Keep my version</button>
          <button onclick={() => loadDisk(active.path)}>Load disk version</button>
          <button aria-pressed={active.showDiff} onclick={() => toggleDiff(active.path)}>{active.showDiff ? 'Hide diff' : 'View diff'}</button>
        </div>
        {#if active.showDiff}
          <p class="hint">Red lines are the disk's, green ones are yours. Pick Keep mine or Use disk on each change, then tap Keep my version and Save.</p>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="empty">
      <p>No open files.</p>
      <button class="primary" onclick={() => (ui.tab = 'files')}>Browse files</button>
    </div>
  {/if}

  <div class="host" bind:this={host} hidden={!editor.docs.length}></div>

  {#if editor.docs.length}
    <!-- Shown only while the keyboard is open (html.kb, from lib/viewport.ts). -->
    <div class="keys" role="toolbar" aria-label="Coding keys">
      {#each KEYS as key (key)}
        <button tabindex="-1" onpointerdown={keepFocus} onclick={() => typeKey(key)}>{key}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .tabs {
    flex: none;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .tab {
    flex: none;
    display: flex;
    align-items: center;
    max-width: 60vw;
    border-right: 1px solid var(--border);
    color: var(--muted);
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
    overflow: hidden;
    white-space: nowrap;
    font-size: 14px;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text);
  }
  .close {
    display: grid;
    place-items: center;
    width: 36px;
  }
  .toolbar,
  .options {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    border-bottom: 1px solid var(--border);
  }
  .options {
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .icon[aria-expanded='true'] {
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .toolbar .primary {
    padding: 8px 16px;
  }
  .secondary,
  .options button,
  .banner button {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: none;
    font-size: 14px;
  }
  .secondary {
    margin-right: 6px;
  }
  .options button[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--accent);
  }
  .size {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .banner {
    flex: none;
    padding: 8px 12px;
    background: #3d2e00;
    border-bottom: 1px solid #9e6a03;
  }
  .banner p {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .banner div {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .banner button[aria-pressed='true'] {
    border-color: var(--text);
  }
  .banner .hint {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .host {
    flex: 1;
    min-height: 0;
  }
  .empty {
    margin: auto;
    text-align: center;
    color: var(--muted);
  }
  .keys {
    flex: none;
    display: none;
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  :global(html.kb) .keys {
    display: flex;
  }
  .keys button {
    flex: 1 0 auto;
    min-width: 40px;
    height: 44px;
    border: 0;
    border-right: 1px solid var(--border);
    background: none;
    font: 17px ui-monospace, Menlo, monospace;
  }
  .keys button:first-child {
    font: 14px -apple-system, system-ui, sans-serif;
    min-width: 52px;
  }
  .keys button:active {
    background: var(--border);
  }
</style>
