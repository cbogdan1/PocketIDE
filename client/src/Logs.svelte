<script lang="ts">
  import Icon from './Icon.svelte';
  import Sheet, { type Action } from './Sheet.svelte';
  import { parseAnsi, stripAnsi, type Segment } from './lib/ansi.ts';
  import { findFileRefs, resolveRef } from './lib/fileLinks.ts';
  import {
    allLines,
    clearLog,
    isActive,
    log,
    openAt,
    restartRun,
    runs,
    seenLogs,
    sendInput,
    setAutoLogs,
    setTimestamps,
    statusText,
    stopRun,
    view,
    viewedRun,
    type LogLine,
  } from './lib/runs.svelte.ts';
  import { toast, ui } from './lib/ui.svelte.ts';
  import { workspace } from './lib/workspace.svelte.ts';

  interface Piece extends Segment {
    ref?: { path: string; line: number; col?: number };
  }

  let box = $state<HTMLDivElement>();
  let follow = $state(true);
  let query = $state('');
  let input = $state('');
  let menu = $state<Action[] | null>(null);
  const run = $derived(viewedRun());
  const active = $derived(isActive(run));

  // Looking at the logs clears the badge.
  $effect(() => {
    if (ui.tab === 'logs') seenLogs();
  });

  /** Lines matching the filter (the newest 2,000), or null without a filter. */
  const matches = $derived.by(() => {
    void log.chunks; // recomputed when lines arrive
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return allLines()
      .filter((l) => stripAnsi(l.text).toLowerCase().includes(q))
      .slice(-2000);
  });

  // New output scrolls into view unless you've scrolled up to read.
  $effect(() => {
    void log.chunks;
    void matches;
    if (follow && box && ui.tab === 'logs') box.scrollTop = box.scrollHeight;
  });

  function onScroll() {
    if (box) follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  }

  function toBottom() {
    follow = true;
    if (box) box.scrollTop = box.scrollHeight;
  }

  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

  /** Colored pieces of a line; "file:line" references become links into the editor. */
  function pieces(line: LogLine): Piece[] {
    const segments = parseAnsi(line.text);
    const root = workspace.config?.projectsRoot;
    if (!run || !root || line.s === 'in' || line.s === 'info') return segments;
    const plain = segments.map((s) => s.text).join('');
    const refs = findFileRefs(plain)
      .map((r) => ({ ...r, target: resolveRef(r.path, run.cwd, root) }))
      .filter((r) => r.target);
    if (!refs.length) return segments;
    const out: Piece[] = [];
    let pos = 0;
    for (const seg of segments) {
      const end = pos + seg.text.length;
      let at = pos;
      while (at < end) {
        const ref = refs.find((r) => at >= r.start && at < r.end);
        const next = Math.min(end, ref ? ref.end : Math.min(...refs.filter((r) => r.start > at).map((r) => r.start), end));
        out.push({ text: plain.slice(at, next), style: seg.style, ref: ref && { path: ref.target!, line: ref.line, col: ref.col } });
        at = next;
      }
      pos = end;
    }
    return out;
  }

  function submitInput(e: SubmitEvent) {
    e.preventDefault();
    if (!run) return;
    void sendInput(run.id, input);
    input = '';
  }

  function openMenu() {
    menu = [
      {
        label: 'Copy all',
        run: () => {
          const text = allLines().map((l) => (runs.timestamps ? `${time(l.t)} ` : '') + stripAnsi(l.text)).join('\n');
          navigator.clipboard.writeText(text).then(
            () => toast('Copied the log'),
            () => toast("iOS didn't allow copying"),
          );
        },
      },
      { label: 'Clear', run: () => run && void clearLog(run.id) },
      { label: runs.autoLogs ? 'Stay on the current tab after Run' : 'Open Logs after Run', run: () => setAutoLogs(!runs.autoLogs) },
    ];
  }
</script>

<div class="logs">
  {#if !workspace.project}
    <p class="empty">Open a project to run it.</p>
  {:else if !runs.list.length}
    <p class="empty">Nothing has run in {workspace.project} yet. Pick a configuration at the top and tap ▶, or tap ▶ on a file in the Editor.</p>
  {:else}
    <div class="runs" role="tablist" aria-label="Runs">
      {#each runs.list as r (r.id)}
        <button role="tab" aria-selected={r.id === runs.viewing} onclick={() => view(r.id)}>
          <span class="dot {r.status}"></span>
          {r.name}
          {#if !isActive(r)}<span class="when">{time(r.startedAt).slice(0, 5)}</span>{/if}
        </button>
      {/each}
    </div>
    {#if run}
      <div class="status">
        <span class="text" class:failed={run.status === 'crashed'}>{statusText(run)}</span>
        {#if active}
          <button class="small" disabled={run.status === 'stopping'} onclick={() => restartRun(run)}><Icon name="restart" size={16} />Restart</button>
          <button class="small stop" disabled={run.status === 'stopping'} onclick={() => stopRun(run.id)}><Icon name="stop" size={16} />Stop</button>
        {:else}
          <button class="small" disabled={runs.busy} onclick={() => restartRun(run)}><Icon name="play" size={16} />Run again</button>
        {/if}
      </div>
    {/if}
    <div class="toolbar">
      <input type="search" placeholder="Filter" aria-label="Filter the log" bind:value={query} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button class="icon" aria-label="Timestamps" aria-pressed={runs.timestamps} onclick={() => setTimestamps(!runs.timestamps)}><Icon name="clock" /></button>
      <button class="icon" aria-label="Log actions" onclick={openMenu}><Icon name="more" /></button>
    </div>

    {#snippet row(line: LogLine)}
      <div class="line {line.s}">
        {#if runs.timestamps}<span class="time">{time(line.t)}</span>{/if}
        {#if line.s === 'in'}<span class="prompt">›</span>{/if}
        {#each pieces(line) as piece, i (i)}
          {#if piece.ref}
            {@const ref = piece.ref}
            <button class="ref" style={piece.style} onclick={() => openAt(ref.path, ref.line, ref.col)}>{piece.text}</button>
          {:else}
            <span style={piece.style}>{piece.text}</span>
          {/if}
        {/each}
      </div>
    {/snippet}

    <div class="output" bind:this={box} onscroll={onScroll}>
      {#if matches}
        {#each matches as line (line.seq)}{@render row(line)}{/each}
        {#if !matches.length}<p class="none">No lines match.</p>{/if}
      {:else}
        {#each log.chunks as chunk (chunk[0].seq)}
          <div class="chunk">{#each chunk as line (line.seq)}{@render row(line)}{/each}</div>
        {/each}
      {/if}
    </div>
    {#if !follow}
      <button class="bottom" aria-label="Jump to the bottom" onclick={toBottom}><Icon name="down" /></button>
    {/if}

    {#if active}
      <form class="input" onsubmit={submitInput}>
        <input bind:value={input} placeholder="Input for the program" aria-label="Input for the program" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="send" />
        <button type="submit" class="send">Send</button>
      </form>
    {/if}
  {/if}
</div>

{#if menu}<Sheet title="Log" actions={menu} onclose={() => (menu = null)} />{/if}

<style>
  .logs {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .empty {
    margin: 30vh 24px 0;
    text-align: center;
    color: var(--muted);
  }
  .runs {
    display: flex;
    gap: 6px;
    flex: none;
    padding: 8px;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
  }
  .runs button {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: none;
    font-size: 14px;
    white-space: nowrap;
  }
  .runs button[aria-selected='true'] {
    border-color: var(--accent);
    background: var(--surface);
  }
  .when {
    color: var(--muted);
    font-size: 12px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-size: 14px;
  }
  .text {
    flex: 1;
    color: var(--muted);
  }
  .failed {
    color: var(--danger);
  }
  .small {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: none;
    font-size: 14px;
  }
  .small.stop {
    color: var(--danger);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .toolbar input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
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
  .icon[aria-pressed='true'] {
    color: var(--accent);
  }
  .output {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px 8px 12px;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-user-select: text;
    user-select: text;
  }
  /* Chunks out of view are skipped by layout and painting, so 10,000 lines stay smooth. */
  .chunk {
    content-visibility: auto;
    contain-intrinsic-size: auto 3500px;
  }
  .line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-left: 6px;
    border-left: 2px solid transparent;
  }
  .line.err {
    border-left-color: var(--danger);
    background: #f8514912;
  }
  .line.info {
    color: var(--muted);
    font-style: italic;
  }
  .line.in {
    color: var(--accent);
  }
  .time {
    margin-right: 8px;
    color: var(--muted);
  }
  .prompt {
    margin-right: 6px;
  }
  .ref {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: #79c0ff;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .none {
    color: var(--muted);
  }
  .bottom {
    position: absolute;
    right: 14px;
    bottom: 70px;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 2px 8px #0008;
  }
  .input {
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .input input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .send {
    padding: 0 14px;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: #052e16;
    font-weight: 600;
  }
  .dot {
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
