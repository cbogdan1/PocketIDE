import { session } from './session.svelte.ts';

/** A failed API call; the message comes from the agent and is meant to be shown. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** fetch() for the agent's API. Throws ApiError on failure; a 401 drops back to the login screen. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, "Can't reach your PC");
  }
  if (res.ok || res.status === 304) return res;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) session.status = 'login';
  throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
}

export async function getJson<T>(path: string): Promise<T> {
  return (await api(path)).json();
}

export async function sendJson<T = unknown>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

/** A root-relative path as a query parameter value. */
export const q = encodeURIComponent;

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
