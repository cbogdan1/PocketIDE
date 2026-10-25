import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TermInput } from './termInput.ts';
import { chunkInput, type Mods } from './termio.ts';
import { applyMessage, keepScrolledLines } from './termProtocol.ts';

const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#4ade80',
  cursorAccent: '#0d1117',
  selectionBackground: '#2f4a6d',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

interface Callbacks {
  sticky: { get(): Mods; clear(): void };
  /** The agent no longer has this terminal (closed elsewhere, or the agent restarted). */
  onGone(id: string): void;
  onScrolled(atBottom: boolean): void;
}

/**
 * One xterm.js for whichever terminal is in front; switching re-attaches and the agent restores the screen.
 * Its size always comes from the agent (see termProtocol.ts): the view only proposes what fits its screen.
 */
export class TermView {
  readonly term: Terminal;
  readonly input: TermInput;
  private fit = new FitAddon();
  private ws?: WebSocket;
  private id: string | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private encoder = new TextEncoder();
  private resizeObserver: ResizeObserver;
  /** What fits this screen; the agent makes it the terminal's size while this device is the active one. */
  private proposal?: { cols: number; rows: number };

  constructor(private host: HTMLElement, fontSize: number, private callbacks: Callbacks) {
    this.term = new Terminal({
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: THEME,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon()); // same character widths as the agent's mirror
    this.term.unicode.activeVersion = '11';
    keepScrolledLines(this.term);
    // A tapped link opens in Safari (from the home-screen app too).
    this.term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener')));
    this.term.open(host);
    // Programs ask the terminal things (what it is, where the cursor is, its colors); the agent's mirror
    // answers. If every attached device answered too, the extra answers would arrive in the program as input.
    const quiet = () => true;
    for (const id of [
      { final: 'c' },
      { prefix: '>', final: 'c' },
      { prefix: '=', final: 'c' },
      { final: 'n' },
      { prefix: '?', final: 'n' },
      { intermediates: '$', final: 'p' },
      { prefix: '?', intermediates: '$', final: 'p' },
      { prefix: '>', final: 'q' },
    ]) {
      this.term.parser.registerCsiHandler(id, quiet);
    }
    this.term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, quiet);
    for (const osc of [4, 10, 11, 12]) this.term.parser.registerOscHandler(osc, (data) => data.split(';').includes('?'));
    this.input = new TermInput(this.term, (data) => this.send(data), callbacks.sticky);
    this.term.onData((data) => this.send(data)); // pastes, mouse and focus reports
    const scrolled = () => {
      const buffer = this.term.buffer.active;
      callbacks.onScrolled(buffer.viewportY >= buffer.baseY);
    };
    this.term.onScroll(scrolled);
    this.term.onWriteParsed(scrolled);
    // Rotation, the iOS keyboard and the text size change what fits; touching the terminal makes this device
    // the active one. Either way the agent decides, and tells every attached device the new size.
    this.resizeObserver = new ResizeObserver(() => this.propose());
    this.resizeObserver.observe(host);
    host.addEventListener('pointerdown', () => this.propose(), { passive: true });
    this.touchScroll(host);
  }

  /** xterm.js has no touch scrolling: drag through the scrollback, with a little momentum when let go. */
  private touchScroll(host: HTMLElement) {
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0; // lines per millisecond
    let carry = 0; // fraction of a line not scrolled yet
    let frame = 0;
    const lineHeight = () => host.clientHeight / this.term.rows || 16;
    const scroll = (lines: number) => {
      carry += lines;
      const whole = Math.trunc(carry);
      if (whole) this.term.scrollLines(whole);
      carry -= whole;
    };
    host.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(frame);
      lastY = e.touches[0].clientY;
      lastTime = e.timeStamp;
      velocity = 0;
      carry = 0;
    }, { passive: true });
    host.addEventListener('touchmove', (e) => {
      const y = e.touches[0].clientY;
      const lines = (lastY - y) / lineHeight();
      if (e.timeStamp > lastTime) velocity = lines / (e.timeStamp - lastTime);
      lastY = y;
      lastTime = e.timeStamp;
      scroll(lines);
      e.preventDefault(); // no page bounce
    }, { passive: false });
    host.addEventListener('touchend', () => {
      let previous = performance.now();
      const glide = (now: number) => {
        scroll(velocity * (now - previous));
        velocity *= 0.95 ** ((now - previous) / 16);
        previous = now;
        if (Math.abs(velocity) > 0.002) frame = requestAnimationFrame(glide);
      };
      if (Math.abs(velocity) > 0.01) frame = requestAnimationFrame(glide);
    });
  }

  /** Tells the agent the size that fits this screen (it also makes this device the active one). */
  propose() {
    if (!this.host.clientWidth || !this.host.clientHeight) return; // hidden tab
    const fits = this.fit.proposeDimensions();
    if (!fits || !(fits.cols > 0 && fits.rows > 0)) return;
    this.proposal = { cols: fits.cols, rows: fits.rows };
    this.control({ t: 'resize', ...this.proposal });
  }

  setFontSize(px: number) {
    this.term.options.fontSize = px;
    requestAnimationFrame(() => this.propose()); // xterm.js measures the new font when it next renders
  }

  /** Shows terminal `id` (or nothing), replacing whatever was attached. */
  attach(id: string | null) {
    if (id === this.id && this.ws) return;
    this.close();
    this.id = id;
    this.attempt = 0;
    // A full reset after whatever is still queued for the previous terminal (reset() would act before it).
    this.term.write('\x1bc');
    if (id) this.connect();
  }

  /** Back in front (or the agent is reachable again): reconnect now, or claim the size if still connected. */
  resume() {
    if (!this.id) return;
    if (this.ws) return this.propose();
    this.attempt = 0;
    this.connect();
  }

  /** Clears the history (for every device) and asks the program to clear its screen. */
  clear() {
    this.control({ t: 'clear' });
  }

  private connect() {
    clearTimeout(this.retryTimer);
    this.propose();
    const { cols, rows } = this.proposal ?? this.term;
    const id = this.id!;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?id=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => (this.attempt = 0);
    ws.onmessage = (e) => {
      if (this.ws !== ws) return; // a socket we've replaced: its output belongs to another terminal
      // Acknowledged once rendered, so the agent never runs far ahead of a busy phone.
      applyMessage(this.term, e.data, (bytes) => this.control({ t: 'ack', n: bytes }, ws));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // replaced on purpose
      this.ws = undefined;
      // 4404: terminal closed; 404 at the handshake shows up as 1006 after a successful earlier session.
      if (e.code === 4404) return this.callbacks.onGone(id);
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempt++, 10_000));
    };
  }

  private close() {
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  /** Keystrokes and pastes; large pastes go in pieces under the agent's message limit. */
  send(data: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const chunk of chunkInput(data)) this.ws.send(this.encoder.encode(chunk));
  }

  private control(msg: object, ws = this.ws) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Scrollback and screen as plain text, with wrapped lines joined back together. */
  plainText(): string {
    const buffer = this.term.buffer.active;
    let text = '';
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)!;
      text += (i && !line.isWrapped ? '\n' : '') + line.translateToString(true);
    }
    return text.replace(/\s+$/, '');
  }

  dispose() {
    this.close();
    this.resizeObserver.disconnect();
    this.term.dispose();
  }
}
