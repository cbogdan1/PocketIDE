<script lang="ts">
  import Icon from './Icon.svelte';
  import Sheet, { type Action } from './Sheet.svelte';
  import { parentOf } from './lib/api.ts';
  import { openFile } from './lib/editor.svelte.ts';
  import { fileBadge } from './lib/fileTypes.ts';
  import { longpress } from './lib/longpress.ts';
  import { newTerminal } from './lib/terminals.svelte.ts';
  import { openQuickOpen, ui } from './lib/ui.svelte.ts';
  import {
    createEntry,
    deleteEntry,
    loadDir,
    loadProjects,
    openProject,
    renameEntry,
    setProjectsRoot,
    setShowHidden,
    showFolder,
    toggleDir,
    workspace,
    type Entry,
  } from './lib/workspace.svelte.ts';

  interface Row {
    path: string;
    entry: Entry;
    depth: number;
  }

  let editingRoot = $state(false);
  let rootInput = $state('');
  let rootError = $state('');
  let saving = $state(false);
  let menu = $state<{ title: string; actions: Action[] } | null>(null);

  const hidden = $derived(new Set(workspace.config?.hidden));

  /** The expanded tree, flattened into rows. */
  const rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of workspace.dirs[dir] ?? []) {
        if (entry.dir && !workspace.showHidden && hidden.has(entry.name)) continue;
        const path = `${dir}/${entry.name}`;
        out.push({ path, entry, depth });
        if (entry.dir && workspace.expanded[path]) walk(path, depth + 1);
      }
    };
    walk(workspace.treeRoot, 0);
    return out;
  });

  /** "my-app › src › lib", each step leading back up the tree. */
  const crumbs = $derived(workspace.treeRoot.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })));

  function editRoot() {
    rootInput = workspace.config?.projectsRoot ?? workspace.config?.suggestedRoot ?? '';
    rootError = '';
    editingRoot = true;
  }

  async function saveRoot(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    rootError = (await setProjectsRoot(rootInput)) ?? '';
    saving = false;
    if (!rootError) editingRoot = false;
  }

  async function tap(row: Row) {
    if (row.entry.dir) toggleDir(row.path);
    else if (await openFile(row.path)) ui.tab = 'editor';
  }

  function rowMenu(row: Row) {
    const dir = row.entry.dir ? row.path : parentOf(row.path);
    const inside = row.entry.dir ? ' in this folder' : ' here';
    menu = {
      title: row.path,
      actions: [
        { label: `New file${inside}`, run: () => createEntry(dir, 'file') },
        { label: `New folder${inside}`, run: () => createEntry(dir, 'folder') },
        ...(row.entry.dir
          ? [
              { label: 'Open terminal here', run: () => newTerminal(row.path) },
              { label: 'Show only this folder', run: () => showFolder(row.path) },
            ]
          : []),
        { label: 'Rename', run: () => renameEntry(row.path) },
        { label: 'Move to Recycle Bin', danger: true, run: () => deleteEntry(row.path, row.entry.dir) },
      ],
    };
  }

  function folderMenu() {
    const dir = workspace.treeRoot;
    menu = {
      title: dir,
      actions: [
        { label: 'New file', run: () => createEntry(dir, 'file') },
        { label: 'New folder', run: () => createEntry(dir, 'folder') },
        { label: workspace.showHidden ? 'Hide node_modules, .git, dist…' : 'Show hidden folders', run: () => setShowHidden(!workspace.showHidden) },
        { label: 'Open terminal here', run: () => newTerminal(dir) },
        { label: 'Refresh', run: () => loadDir(dir) },
      ],
    };
  }

  function pickProject() {
    workspace.picking = true;
    void loadProjects();
  }
</script>

{#if !workspace.config}
  <p class="note">Loading…</p>
{:else if !workspace.config.projectsRoot || editingRoot}
  <form class="setup" onsubmit={saveRoot}>
    <h2>Projects folder</h2>
    <p>The folder on your PC that holds your projects. Each folder inside it is a project.</p>
    <input
      bind:value={rootInput}
      aria-label="Projects folder"
      placeholder={workspace.config.suggestedRoot}
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      required
      onfocus={() => !rootInput && (rootInput = workspace.config?.suggestedRoot ?? '')}
    />
    <div class="buttons">
      {#if workspace.config.projectsRoot}<button type="button" onclick={() => (editingRoot = false)}>Cancel</button>{/if}
      <button class="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
    {#if rootError}<p class="error" role="alert">{rootError}</p>{/if}
  </form>
{:else if !workspace.project || workspace.picking}
  <div class="bar">
    {#if workspace.project}
      <button class="icon" aria-label="Back to {workspace.project}" onclick={() => (workspace.picking = false)}><Icon name="back" /></button>
    {/if}
    <div class="title">
      <strong>Projects</strong>
      <span class="sub">{workspace.config.projectsRoot}</span>
    </div>
    <button class="text" onclick={editRoot}>Change</button>
  </div>
  <ul class="list">
    {#each workspace.projects as name (name)}
      <li>
        <button class="row project" class:current={name === workspace.project} onclick={() => openProject(name)}>
          <span class="folder"><Icon name="folder" /></span>
          <span class="name">{name}</span>
        </button>
      </li>
    {:else}
      <li class="note">No folders in {workspace.config.projectsRoot}.</li>
    {/each}
  </ul>
{:else}
  <div class="bar">
    <button class="icon" aria-label="All projects" onclick={pickProject}><Icon name="back" /></button>
    <nav class="crumbs" aria-label="Folder path">
      {#each crumbs as crumb, i (crumb.path)}
        {#if i}<span class="sep" aria-hidden="true">›</span>{/if}
        <button aria-current={i === crumbs.length - 1 ? 'location' : undefined} onclick={() => showFolder(crumb.path)}>{crumb.name}</button>
      {/each}
    </nav>
    <button class="icon" aria-label="Find a file" onclick={openQuickOpen}><Icon name="search" /></button>
    <button class="icon" aria-label="Folder actions" onclick={folderMenu}><Icon name="more" /></button>
  </div>
  <ul class="list">
    {#each rows as row (row.path)}
      <li class="row" style:--depth={row.depth} use:longpress={() => rowMenu(row)}>
        <button class="main" aria-expanded={row.entry.dir ? !!workspace.expanded[row.path] : undefined} onclick={() => tap(row)}>
          {#if row.entry.dir}
            <span class="chevron" class:open={workspace.expanded[row.path]}><Icon name="chevron" size={16} /></span>
            <span class="folder"><Icon name="folder" /></span>
          {:else}
            {@const badge = fileBadge(row.entry.name)}
            <span class="badge" style:color={badge.color}>{badge.label}</span>
          {/if}
          <span class="name" class:dim={row.entry.dir && hidden.has(row.entry.name)}>{row.entry.name}</span>
        </button>
        <button class="more" aria-label="Actions for {row.entry.name}" onclick={() => rowMenu(row)}><Icon name="more" /></button>
      </li>
    {:else}
      <li class="note">{workspace.dirs[workspace.treeRoot] ? 'This folder is empty.' : 'Loading…'}</li>
    {/each}
  </ul>
{/if}

{#if menu}
  <Sheet title={menu.title} actions={menu.actions} onclose={() => (menu = null)} />
{/if}

<style>
  .note {
    margin: 24px 16px;
    color: var(--muted);
    text-align: center;
    list-style: none;
  }
  .setup {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 480px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  .setup h2 {
    margin: 0;
    font-size: 20px;
  }
  .setup p {
    margin: 0;
    color: var(--muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .buttons button:not(.primary) {
    padding: 12px 20px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
  }
  .error {
    color: var(--danger);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    min-height: 48px;
    padding: 0 4px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 4px 8px;
  }
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
  }
  .icon,
  .text,
  .more {
    flex: none;
    display: grid;
    place-items: center;
    min-width: 44px;
    height: 44px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .text {
    padding: 0 12px;
    color: var(--accent);
  }
  .crumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
  }
  .crumbs button {
    min-height: 44px;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .crumbs button[aria-current] {
    color: var(--text);
    font-weight: 600;
  }
  .sep {
    color: var(--border);
  }
  .list {
    margin: 0;
    padding: 0 0 24px;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    /* A long press opens the actions menu instead of selecting text or showing the iOS callout. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .main,
  .project {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 0 0 calc(12px + var(--depth, 0) * 16px);
    border: 0;
    background: none;
    text-align: left;
  }
  .project {
    width: 100%;
    min-height: 52px;
    padding-left: 16px;
    border-bottom: 1px solid var(--border);
  }
  .project.current .name {
    color: var(--accent);
  }
  .main:active,
  .project:active {
    background: var(--surface);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--muted);
  }
  .chevron {
    display: grid;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .folder {
    display: grid;
    color: #e3b341;
  }
  /* Same column as a folder's icon: past the chevron (16px) and its gap (8px). */
  .badge {
    flex: none;
    width: 20px;
    margin-left: 24px;
    font: 700 9px/1 ui-monospace, Menlo, monospace;
    text-align: center;
  }
  .more {
    color: #6e7681;
  }
</style>
