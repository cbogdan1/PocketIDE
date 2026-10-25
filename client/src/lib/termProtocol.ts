/** What a terminal needs in order to follow the agent; xterm.js in the browser and @xterm/headless both fit. */
export interface FollowingTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  options: { windowsPty?: { backend?: 'conpty' | 'winpty'; buildNumber?: number } };
}

export interface AgentMessage {
  t: string;
  cols?: number;
  rows?: number;
  windowsPty?: { backend?: 'conpty' | 'winpty'; buildNumber?: number };
  exitCode?: number | null;
  code?: number;
}

/**
 * Applies one message from the agent's terminal socket. Output is written as it comes. A size change (and the
 * size that comes with a restore) waits until everything before it has been parsed, so it lands at the same
 * point in the stream as in the agent's mirror; this terminal then always matches the mirror exactly.
 * Returns control messages for the caller; `ack` is called with the number of bytes once they're on screen.
 */
export function applyMessage(
  term: FollowingTerminal,
  data: string | ArrayBuffer | Uint8Array,
  ack: (bytes: number) => void,
): AgentMessage | undefined {
  if (typeof data === 'string') {
    const msg: AgentMessage = JSON.parse(data);
    if ((msg.t === 'restore' || msg.t === 'size') && msg.cols && msg.rows) {
      const { cols, rows, windowsPty } = msg;
      term.write('', () => {
        if (windowsPty) term.options.windowsPty = windowsPty;
        term.resize(cols, rows);
      });
    }
    return msg;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  term.write(bytes, () => ack(bytes.length));
  return undefined;
}

interface ScrollingTerminal {
  rows: number;
  buffer: { active: { type: string } };
  parser: { registerCsiHandler(id: { final: string }, handler: (params: (number | number[])[]) => boolean): unknown };
}

/** The bits of xterm.js's internals that keepScrolledLines needs; the same in the browser and in @xterm/headless. */
interface XtermCore {
  buffer: { scrollTop: number; scrollBottom: number };
  _bufferService: { scroll(eraseAttr: unknown): void };
  _inputHandler: { _eraseAttrData(): unknown };
}

/**
 * ConPTY scrolls with CSI S (scroll up), e.g. on Enter in the last row, and xterm.js throws away the lines that
 * move off the screen. Like xterm, move them into the history instead (a line feed at the bottom does the same).
 * The agent's mirror and the app's xterm.js both use this, so they stay identical.
 */
export function keepScrolledLines(term: ScrollingTerminal): void {
  const core = (term as unknown as { _core: XtermCore })._core;
  term.parser.registerCsiHandler({ final: 'S' }, (params) => {
    const { scrollTop, scrollBottom } = core.buffer;
    if (term.buffer.active.type !== 'normal' || scrollTop !== 0 || scrollBottom !== term.rows - 1) return false;
    for (let n = Math.min(Number(params[0]) || 1, term.rows); n > 0; n--) {
      core._bufferService.scroll(core._inputHandler._eraseAttrData());
    }
    return true;
  });
}
