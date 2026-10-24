<script lang="ts" module>
  export interface Action {
    label: string;
    run: () => void;
    danger?: boolean;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  let { title, actions, onclose }: { title: string; actions: Action[]; onclose: () => void } = $props();
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());

  function pick(action: Action) {
    dialog.close();
    action.run();
  }
</script>

<!-- A bottom sheet of actions. Tapping the backdrop (the dialog element itself) cancels. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} aria-label={title} {onclose} onclick={(e) => e.target === dialog && dialog.close()}>
  <p>{title}</p>
  {#each actions as action (action.label)}
    <button class:danger={action.danger} onclick={() => pick(action)}>{action.label}</button>
  {/each}
  <button class="cancel" onclick={() => dialog.close()}>Cancel</button>
</dialog>

<style>
  dialog {
    width: 100%;
    max-width: 480px;
    margin: auto auto 0;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    box-sizing: border-box;
    border: 0;
    border-radius: 14px 14px 0 0;
    background: var(--surface);
    color: var(--text);
  }
  dialog::backdrop {
    background: #0009;
  }
  p {
    margin: 4px 12px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }
  button {
    display: block;
    width: 100%;
    min-height: 50px;
    border: 0;
    border-top: 1px solid var(--border);
    background: none;
    font-size: 17px;
  }
  .danger {
    color: var(--danger);
  }
  .cancel {
    margin-top: 8px;
    border-radius: 12px;
    border: 0;
    background: var(--bg);
    font-weight: 600;
  }
</style>
