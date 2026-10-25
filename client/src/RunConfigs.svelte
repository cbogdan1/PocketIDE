<script lang="ts">
  import { onMount } from 'svelte';
  import { CONFIG_FILE, runs, saveConfigs, type RunConfig, type RunShell, type RunType } from './lib/runs.svelte.ts';
  import { toast } from './lib/ui.svelte.ts';

  let { onclose }: { onclose: () => void } = $props();

  interface Item {
    name: string;
    type: RunType;
    command: string;
    port: string;
    windowTitle: string;
    cwd: string;
    shell: RunShell | '';
    env: string;
  }

  const toItem = (c: RunConfig): Item => ({
    name: c.name,
    type: c.type,
    command: c.command,
    port: c.port ? String(c.port) : '',
    windowTitle: c.windowTitle ?? '',
    cwd: c.cwd ?? '',
    shell: c.shell ?? '',
    env: Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  });

  let dialog: HTMLDialogElement;
  let items = $state(runs.configs.map(toItem));
  let preferred = $state(runs.default ?? '');
  let error = $state('');
  let saving = $state(false);

  onMount(() => {
    if (!items.length) add();
    dialog.showModal();
  });

  function add() {
    items.push({ name: items.length ? `Configuration ${items.length + 1}` : 'Run', type: 'task', command: '', port: '', windowTitle: '', cwd: '', shell: '', env: '' });
  }

  /** The form's text fields as a configuration; the agent validates the rest and says what's wrong. */
  function toConfig(item: Item): RunConfig {
    const config: RunConfig = { name: item.name.trim(), type: item.type, command: item.command.trim() };
    if (item.port.trim()) config.port = Number(item.port);
    if (item.type === 'desktop' && item.windowTitle.trim()) config.windowTitle = item.windowTitle.trim();
    if (item.cwd.trim()) config.cwd = item.cwd.trim();
    if (item.shell) config.shell = item.shell;
    const env = item.env.split('\n').map((l) => l.trim()).filter(Boolean);
    if (env.length) {
      config.env = {};
      for (const line of env) {
        const eq = line.indexOf('=');
        if (eq < 1) throw new Error(`"${config.name}": environment lines look like NAME=value ("${line}" doesn't)`);
        config.env[line.slice(0, eq).trim()] = line.slice(eq + 1);
      }
    }
    return config;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    let configs: RunConfig[];
    try {
      configs = items.map(toConfig);
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    saving = true;
    const failed = await saveConfigs(configs, configs.some((c) => c.name === preferred) ? preferred : null);
    saving = false;
    if (failed) error = failed;
    else {
      toast(`Saved ${CONFIG_FILE}`);
      dialog.close();
    }
  }
</script>

<dialog bind:this={dialog} aria-label="Run configurations" {onclose}>
  <form onsubmit={submit}>
    <header>
      <button type="button" class="link" onclick={() => dialog.close()}>Cancel</button>
      <strong>Run configurations</strong>
      <button type="submit" class="link save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </header>
    <div class="body">
      <p class="hint">Saved as <code>{CONFIG_FILE}</code> in the project. Commands run in its folder with cmd unless you pick a shell.</p>
      {#each items as item, i (i)}
        <fieldset>
          <label>Name <input bind:value={item.name} required maxlength="60" /></label>
          <label>
            Type
            <select bind:value={item.type}>
              <option value="web">Web server (has a port)</option>
              <option value="desktop">Desktop app (opens a window)</option>
              <option value="task">Task (runs and finishes)</option>
            </select>
          </label>
          <label>Command <input bind:value={item.command} required autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="npm run dev" /></label>
          {#if item.type === 'web'}
            <label>Port <input bind:value={item.port} inputmode="numeric" required placeholder="5173" /></label>
          {:else if item.type === 'desktop'}
            <label>Window title <input bind:value={item.windowTitle} placeholder="For capturing it later (optional)" /></label>
          {/if}
          <label>Folder <input bind:value={item.cwd} autocapitalize="off" spellcheck="false" placeholder="The project folder (or e.g. client)" /></label>
          <label>
            Shell
            <select bind:value={item.shell}>
              <option value="">Command Prompt (default)</option>
              <option value="powershell">Windows PowerShell</option>
              <option value="pwsh">PowerShell 7</option>
              <option value="bash">Git Bash</option>
            </select>
          </label>
          <label>
            Environment variables
            <textarea bind:value={item.env} rows="2" autocapitalize="off" spellcheck="false" placeholder="NAME=value, one per line"></textarea>
          </label>
          <button type="button" class="remove" onclick={() => items.splice(i, 1)} disabled={items.length === 1}>Remove “{item.name}”</button>
        </fieldset>
      {/each}
      <button type="button" class="add" onclick={add}>Add configuration</button>
      <label>
        Default
        <select bind:value={preferred}>
          <option value="">The first one</option>
          {#each items as item, i (i)}<option value={item.name}>{item.name}</option>{/each}
        </select>
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: 100%;
    max-width: 560px;
    height: 100%;
    max-height: 100%;
    margin: 0 auto;
    padding: 0;
    border: 0;
    background: var(--bg);
    color: var(--text);
  }
  form {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: env(safe-area-inset-top) 4px 0;
    min-height: 48px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .link {
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    background: none;
    color: var(--accent);
  }
  .save {
    font-weight: 600;
  }
  .body {
    flex: 1;
    overflow: auto;
    padding: 12px 12px calc(24px + env(safe-area-inset-bottom));
  }
  .hint {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 13px;
  }
  fieldset {
    margin: 0 0 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    color: var(--muted);
    font-size: 13px;
  }
  input,
  select,
  textarea {
    padding: 10px;
    font: inherit;
    font-size: 16px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .remove,
  .add {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
  }
  .remove {
    color: var(--danger);
  }
  .add {
    width: 100%;
    margin-bottom: 12px;
  }
  .error {
    color: var(--danger);
  }
</style>
