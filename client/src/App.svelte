<script lang="ts">
  import Login from './Login.svelte';
  import Shell from './Shell.svelte';
  import { checkSession, session } from './lib/session.svelte.ts';

  checkSession();
</script>

{#if session.status === 'app'}
  <Shell />
{:else if session.status === 'login'}
  <Login />
{:else if session.status === 'offline'}
  <div class="offline">
    <p>Can't reach your PC. Is Tailscale connected?</p>
    <button class="primary" onclick={checkSession}>Retry</button>
  </div>
{/if}

<style>
  .offline {
    margin: auto;
    padding: 24px;
    text-align: center;
  }
</style>
