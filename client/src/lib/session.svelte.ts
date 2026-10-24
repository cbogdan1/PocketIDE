type Status = 'loading' | 'offline' | 'login' | 'app';

export const session = $state({ status: 'loading' as Status, host: '' });

/** Shows the app if our cookie is still good, the login screen if not. */
export async function checkSession(): Promise<void> {
  try {
    const res = await fetch('/api/session');
    if (res.ok) Object.assign(session, { status: 'app', host: (await res.json()).host });
    else session.status = 'login';
  } catch {
    session.status = 'offline';
  }
}

/** Resolves to an error message, or undefined once logged in. */
export async function login(password: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return "Can't reach your PC.";
  }
  if (res.ok) {
    await checkSession();
    return;
  }
  if (res.status === 429) {
    const minutes = Math.ceil(Number(res.headers.get('Retry-After')) / 60);
    return `Too many attempts. Try again in ${minutes} min.`;
  }
  return res.status === 401 ? 'Wrong password.' : `Login failed (${res.status}).`;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  session.status = 'login';
}
