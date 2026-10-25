<script lang="ts">
  import Icon from './Icon.svelte';
  import RunConfigs from './RunConfigs.svelte';
  import Sheet, { type Action } from './Sheet.svelte';
  import {
    CONFIG_FILE,
    editConfigFile,
    isActive,
    restartRun,
    runSelected,
    runs,
    saveConfigs,
    selectConfig,
    selectedRun,
    statusText,
    stopRun,
  } from './lib/runs.svelte.ts';
  import { toast } from './lib/ui.svelte.ts';

  let menu = $state<{ title: string; actions: Action[] } | null>(null);
  let editing = $state(false);
  const current = $derived(selectedRun());
  const active = $derived(isActive(current));

  function openMenu() {
    const actions: Action[] = runs.configs.map((c) => ({
      label: `${c.name === runs.selected ? '✓ ' : ''}${c.name}${c.type === 'web' ? ` · port ${c.port}` : c.type === 'desktop' ? ' · desktop app' : ''}`,
      run: () => selectConfig(c.name),
    }));
    if (runs.source === 'detected' && runs.configs.length) {
      actions.push({
        label: `Save these as ${CONFIG_FILE}`,
        run: async () => {
          const error = await saveConfigs(runs.configs, null);
          toast(error ?? `Saved ${CONFIG_FILE}`);
        },
      });
    }
    actions.push({ label: 'Edit configurations', run: () => (editing = true) });
    actions.push({ label: `Edit ${CONFIG_FILE}`, run: () => void editConfigFile() });
    const title = runs.errors.length
      ? `${CONFIG_FILE} has errors: ${runs.errors[0]}`
      : runs.source === 'detected'
        ? runs.configs.length
          ? `Detected from the project files (no ${CONFIG_FILE} yet)`
          : `Nothing to run detected: add a configuration`
        : 'Run configuration';
    menu = { title, actions };
  }
</script>

{#if runs.project}
  <div class="runbar">
    <button class="pick" onclick={openMenu} aria-label="Run configuration: {runs.selected ?? 'none'}, {statusText(current)}">
      <span class="dot {current?.status ?? 'idle'}" class:failed={current?.status === 'crashed'} title={statusText(current)}></span>
      <span class="name">{runs.errors.length ? `${CONFIG_FILE} has errors` : (runs.selected ?? 'Add a configuration')}</span>
      {#if current && !active && current.exitCode}<span class="code">exit {current.exitCode}</span>{/if}
      <Icon name="chevronDown" size={16} />
    </button>
    {#if current && active}
      <button class="icon" aria-label="Restart" disabled={runs.busy || current.status === 'stopping'} onclick={() => restartRun(current)}>
        <Icon name="restart" />
      </button>
      <button class="icon stop" aria-label="Stop" disabled={current.status === 'stopping'} onclick={() => stopRun(current.id)}>
        <Icon name="stop" />
      </button>
    {:else}
      <button class="icon run" aria-label="Run" disabled={!runs.selected || runs.busy || !!runs.errors.length} onclick={() => runSelected()}>
        <Icon name="play" />
      </button>
    {/if}
  </div>
{/if}

{#if menu}<Sheet title={menu.title} actions={menu.actions} onclose={() => (menu = null)} />{/if}
{#if editing}<RunConfigs onclose={() => (editing = false)} />{/if}

<style>
  .runbar {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 1;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 44px;
    padding: 0 6px 0 0;
    border: 0;
    background: none;
    font-weight: 600;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .code {
    flex: none;
    color: var(--danger);
    font-size: 12px;
    font-weight: 400;
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border: 0;
    background: none;
    color: var(--text);
  }
  .run {
    color: var(--accent);
  }
  .stop {
    color: var(--danger);
  }
  .run :global(svg),
  .stop :global(svg) {
    fill: currentColor;
  }
  /* Status: grey idle/finished, amber starting/stopping, green running, glowing green ready, red failed. */
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.starting,
  .dot.stopping {
    background: #d29922;
    animation: pulse 1s infinite alternate;
  }
  .dot.running,
  .dot.ready {
    background: var(--accent);
  }
  .dot.ready {
    box-shadow: 0 0 0 3px #4ade8040;
  }
  .dot.failed {
    background: var(--danger);
  }
  @keyframes pulse {
    to {
      opacity: 0.4;
    }
  }
</style>
