<script lang="ts">
  import { onMount } from 'svelte';
  import { basename, message, parentOf } from './lib/api.ts';
  import { openFile } from './lib/editor.svelte.ts';
  import { fileBadge } from './lib/fileTypes.ts';
  import { fuzzyFilter } from './lib/fuzzy.ts';
  import { toast, ui } from './lib/ui.svelte.ts';
  import { loadFileList, workspace } from './lib/workspace.svelte.ts';

  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let query = $state('');
  let files = $state(workspace.files);
  const results = $derived(files ? fuzzyFilter(query, files, 50) : []);

  onMount(() => {
    dialog.showModal();
    input.focus(); // still inside the tap that opened us (see openQuickOpen), so iOS shows the keyboard
    if (!files) {
      loadFileList()
        .then((list) => (files = list))
        .catch((err) => {
          toast(message(err));
          dialog.close();
        });
    }
  });

  async function pick(rel: string) {
    dialog.close();
    if (await openFile(`${workspace.project}/${rel}`)) ui.tab = 'editor';
  }
</script>

<dialog bind:this={dialog} aria-label="Find a file" onclose={() => (ui.quickOpen = false)}>
  <div class="top">
    <input
      bind:this={input}
      bind:value={query}
      type="search"
      placeholder="Find a file in {workspace.project}"
      aria-label="File name"
      enterkeyhint="go"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      onkeydown={(e) => e.key === 'Enter' && results[0] && pick(results[0])}
    />
    <button onclick={() => dialog.close()}>Cancel</button>
  </div>
  <ul>
    {#each results as rel (rel)}
      {@const badge = fileBadge(rel)}
      <li>
        <button onclick={() => pick(rel)}>
          <span class="badge" style:color={badge.color}>{badge.label}</span>
          <span class="name">{basename(rel)}</span>
          <span class="dir">{parentOf(rel)}</span>
        </button>
      </li>
    {/each}
  </ul>
  {#if !files}
    <p>Loading…</p>
  {:else if !results.length}
    <p>No matching files.</p>
  {/if}
</dialog>

<style>
  /* Sized to the visual viewport (lib/viewport.ts), so the results end above the keyboard. */
  dialog {
    top: var(--vv-top, 0px);
    bottom: auto;
    width: 100%;
    max-width: 640px;
    height: var(--vv-height, 100%);
    max-height: none;
    margin: 0 auto;
    padding: env(safe-area-inset-top) 0 0;
    box-sizing: border-box;
    border: 0;
    background: var(--bg);
    color: var(--text);
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .top {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
  }
  .top button {
    border: 0;
    background: none;
    color: var(--accent);
  }
  ul {
    flex: 1;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  li button {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-height: 48px;
    padding: 12px 16px;
    box-sizing: border-box;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    text-align: left;
  }
  .badge {
    flex: none;
    width: 24px;
    font: 700 9px/1 ui-monospace, Menlo, monospace;
  }
  .name {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 13px;
  }
  p {
    color: var(--muted);
    text-align: center;
  }
</style>
