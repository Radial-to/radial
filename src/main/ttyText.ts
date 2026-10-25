/**
 * Render a PTY byte stream to the plain text a terminal would show — how
 * `radial agent output` and `agent wait` turn an agent TUI's escape-coded
 * scrollback (Ink cursor moves, line redraws, colors) into lines a person or a
 * model can read (plans/radial-agent-native.md). A headless xterm replays the
 * bytes at the pty's own size, so relative cursor movement lands where it did
 * on screen; without the emulator the fallback strips escapes, which reads
 * roughly for a redrawing TUI but never garbles plain output. Electron-free.
 */

/** The pty's size and how much scrollback to keep; the defaults fit an agent TUI. */
export interface TtyRenderOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

let Headless: typeof import('@xterm/headless').Terminal | null = null;
try { ({ Terminal: Headless } = require('@xterm/headless') as typeof import('@xterm/headless')); } catch {}

async function render(data: string | null | undefined, { cols = 120, rows = 40, scrollback = 4000 }: TtyRenderOptions = {}): Promise<string> {
  const text = String(data == null ? '' : data);
  if (!Headless) return strip(text);
  const term = new Headless({ cols: Math.max(20, cols | 0), rows: Math.max(4, rows | 0), scrollback, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(text, resolve));
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i); if (!l) continue;
      const s = l.translateToString(true);
      if (l.isWrapped && lines.length) lines[lines.length - 1] += s; else lines.push(s);
    }
    return trimBlank(lines).join('\n');
  } finally { try { term.dispose(); } catch {} }
}

/**
 * What a pty shows, read the way the window reads its xterm: the rows on
 * screen now (screen, what cliQuestion.ts reads), the rows just above them in
 * the scrollback, oldest first (above, at most ABOVE_ROWS: where a dialog
 * taller than the screen begins; none for a full-screen CLI), and the last 60
 * rows of the buffer run together (recent, where a paste is looked for:
 * whitespace aside, a wrapped line reads whole). How the core checks a CLI it
 * types into (src/core/agentLane.ts, src/core/questions.ts, shared/agentPaste.ts).
 */
export interface ScreenView { screen: string; above: string[]; recent: string }
const ABOVE_ROWS = 400;
async function screen(data: string | null | undefined, { cols = 120, rows = 40, scrollback = 4000 }: TtyRenderOptions = {}): Promise<ScreenView> {
  const text = String(data == null ? '' : data);
  if (!Headless) { const lines = strip(text).split('\n'); const n = Math.max(4, rows | 0); return { screen: lines.slice(-n).join('\n'), above: lines.slice(Math.max(0, lines.length - n - ABOVE_ROWS), Math.max(0, lines.length - n)), recent: lines.slice(-60).join('') }; }
  const term = new Headless({ cols: Math.max(20, cols | 0), rows: Math.max(4, rows | 0), scrollback, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(text, resolve));
    const b = term.buffer.active;
    const shown = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) || '').join('\n');
    const above: string[] = [];
    for (let i = Math.max(0, b.baseY - ABOVE_ROWS); i < b.baseY; i++) above.push(b.getLine(i)?.translateToString(true) || '');
    let recent = '';
    for (let i = Math.max(0, b.length - 60); i < b.length; i++) { const l = b.getLine(i); if (l) recent += l.translateToString(true); }
    return { screen: shown, above, recent };
  } finally { try { term.dispose(); } catch {} }
}

/** Escape-code stripping, for when no emulator is at hand. */
function strip(text: string | null | undefined): string {
  const s = String(text == null ? '' : text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks, clipboard)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')          // CSI (colors, cursor moves, clears)
    .replace(/\x1b[()][A-Za-z0-9]/g, '')                 // charset selection
    .replace(/\x1b[@-Z\\-_]/g, '')                       // other two-byte escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');   // C0 controls, keeping \t \n \r
  const lines = s.replace(/\r\n/g, '\n').split('\n').map((l) => { const parts = l.split('\r'); return parts[parts.length - 1].replace(/\s+$/, ''); }); // CRLF is a newline; a bare CR rewrites the line
  return trimBlank(lines).join('\n');
}

// Blank edges go; a run of blank lines inside (a TUI's spacer rows) collapses to one.
function trimBlank(lines: string[]): string[] {
  let a = 0, z = lines.length;
  while (a < z && !lines[a].trim()) a++;
  while (z > a && !lines[z - 1].trim()) z--;
  const out: string[] = [];
  for (const l of lines.slice(a, z)) { if (!l.trim() && out.length && !out[out.length - 1].trim()) continue; out.push(l); }
  return out;
}
function lastLines(text: string, n?: number): string { if (!n || n <= 0) return text; return String(text).split('\n').slice(-n).join('\n'); }

export { render, screen, strip, lastLines };
export const hasEmulator = (): boolean => !!Headless;
