import type { LogLine } from './runs.svelte.ts';
import { session } from './session.svelte.ts';

/** Live link to the agent; reconnects with backoff while the app is open. */
export const link = $state({ connected: false });

/** `connected` fires on every (re)connect: anything missed while away has to be caught up on. */
export type AgentEvent =
  | { type: 'connected' }
  | { type: 'fs'; project: string; paths: string[] | null }
  | { type: 'terminals' }
  | { type: 'activity'; id: string }
  | { type: 'runs'; project: string }
  | { type: 'log'; id: string; lines: LogLine[]; clear?: boolean };

let ws: WebSocket | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
const listeners = new Set<(event: AgentEvent) => void>();

export function onEvent(listener: (event: AgentEvent) => void): void {
  listeners.add(listener);
}

/** Sends a message if connected; listeners re-send what matters on `connected`. */
export function send(message: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

const emit = (event: AgentEvent) => listeners.forEach((listener) => listener(event));

export function connect(): void {
  clearTimeout(retryTimer);
  if (ws) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
  ws = socket;
  socket.onopen = () => {
    attempt = 0;
    link.connected = true;
    emit({ type: 'connected' });
  };
  socket.onmessage = (e) => emit(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return; // closed on purpose by disconnect()
    ws = undefined;
    link.connected = false;
    retryTimer = setTimeout(retry, Math.min(1000 * 2 ** attempt++, 15_000));
  };
}

export function disconnect(): void {
  clearTimeout(retryTimer);
  const socket = ws;
  ws = undefined;
  socket?.close();
  link.connected = false;
}

async function retry(): Promise<void> {
  // A refused upgrade looks like any other drop, so ask whether the session is gone.
  const res = await fetch('/api/session').catch(() => undefined);
  if (res?.status === 401) session.status = 'login';
  else if (session.status === 'app') connect();
}

// iOS suspends backgrounded PWAs and kills their sockets; reconnect as soon as we're visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session.status === 'app' && !ws) {
    attempt = 0;
    connect();
  }
});
