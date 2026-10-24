<script lang="ts">
  import { onMount } from 'svelte';
  import Editor from './Editor.svelte';
  import Files from './Files.svelte';
  import QuickOpen from './QuickOpen.svelte';
  import { confirmDiscard, unsavedCount } from './lib/editor.svelte.ts';
  import { connect, disconnect, link } from './lib/events.svelte.ts';
  import { logout, session } from './lib/session.svelte.ts';
  import { ui, type Tab } from './lib/ui.svelte.ts';
  import { loadConfig, reset } from './lib/workspace.svelte.ts';

  const tabs: { id: Tab; label: string; milestone: number; icon: string }[] = [
    { id: 'files', label: 'Files', milestone: 2, icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    { id: 'editor', label: 'Editor', milestone: 2, icon: 'm9 18-6-6 6-6M15 6l6 6-6 6' },
    { id: 'terminal', label: 'Terminal', milestone: 3, icon: 'm4 17 6-5-6-5M12 19h8' },
    { id: 'preview', label: 'Preview', milestone: 5, icon: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 21h8M12 17v4' },
    { id: 'logs', label: 'Logs', milestone: 4, icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  ];

  onMount(() => {
    connect();
    void loadConfig();
    return disconnect;
  });

  function logOut() {
    if (!confirmDiscard('Log out')) return;
    reset();
    void logout();
  }
</script>

<header>
  <strong>PocketIDE</strong>
  <span class="link" class:up={link.connected}>{link.connected ? session.host : 'Reconnecting…'}</span>
  <button class="icon" onclick={logOut} aria-label="Log out">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
  </button>
</header>

<main>
  <!-- Every panel stays mounted so terminals and editors keep their state across tab switches. -->
  {#each tabs as tab (tab.id)}
    <div class="panel" role="tabpanel" id="panel-{tab.id}" aria-labelledby="tab-{tab.id}" hidden={ui.tab !== tab.id}>
      {#if tab.id === 'files'}
        <Files />
      {:else if tab.id === 'editor'}
        <Editor />
      {:else}
        <p class="placeholder">{tab.label} arrives in milestone {tab.milestone}.</p>
      {/if}
    </div>
  {/each}
  {#if ui.toast}<p class="toast" role="status">{ui.toast}</p>{/if}
</main>

<div class="tabbar" role="tablist" aria-label="Views">
  {#each tabs as tab (tab.id)}
    <button
      role="tab"
      id="tab-{tab.id}"
      aria-controls="panel-{tab.id}"
      aria-selected={ui.tab === tab.id}
      onclick={() => (ui.tab = tab.id)}
    >
      <span class="tab-icon" class:unsaved={tab.id === 'editor' && unsavedCount() > 0}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={tab.icon} /></svg>
      </span>
      {tab.label}
    </button>
  {/each}
</div>

{#if ui.quickOpen}<QuickOpen />{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: calc(44px + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
    box-sizing: border-box;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .link {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .link::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger);
  }
  .link.up::before {
    background: var(--accent);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-right: -10px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  main {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .panel {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 0 env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  .placeholder {
    margin: 30vh 24px 0;
    text-align: center;
    color: var(--muted);
  }
  .toast {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    margin: 0;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #21262d;
    box-shadow: 0 4px 16px #0008;
    font-size: 14px;
    pointer-events: none;
  }
  .tabbar {
    display: flex;
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  /* While the keyboard is up, the editor's key row takes the tab bar's place (and the toast moves out of its way). */
  :global(html.kb) .tabbar {
    display: none;
  }
  :global(html.kb) .toast {
    top: 8px;
    bottom: auto;
  }
  .tab-icon {
    position: relative;
    display: grid;
  }
  .tab-icon.unsaved::after {
    content: '';
    position: absolute;
    top: -1px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text);
    border: 2px solid var(--surface);
  }
  .tabbar button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 52px;
    padding: 6px 0 4px;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: 11px;
  }
  .tabbar button[aria-selected='true'] {
    color: var(--accent);
  }
  svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
