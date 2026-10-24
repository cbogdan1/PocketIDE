<script lang="ts">
  import { login } from './lib/session.svelte.ts';

  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = (await login(password)) ?? '';
    busy = false;
  }
</script>

<form onsubmit={submit}>
  <img src="/icons/icon-192.png" alt="" width="64" height="64" />
  <h1>PocketIDE</h1>
  <!-- A username field lets iOS Keychain save and autofill the password. -->
  <input type="text" name="username" autocomplete="username" value="pocketide" hidden />
  <input
    type="password"
    name="password"
    autocomplete="current-password"
    placeholder="Password"
    aria-label="Password"
    required
    bind:value={password}
  />
  <button class="primary" type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</form>

<style>
  form {
    margin: auto;
    width: min(320px, calc(100% - 48px));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  img {
    border-radius: 14px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
  }
  input,
  button {
    width: 100%;
    box-sizing: border-box;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 14px;
  }
</style>
