// A terminal's bell, told apart from the BEL that ends an escape string. While
// it works, Claude Code animates its window title (OSC 0) and prints links
// (OSC 8), and both end in BEL; only a bare BEL means "done" or "needs you".
// A string can span output chunks, so each terminal keeps its own scanner.
const ESC = 0x1b, BEL = 0x07, ST_FINAL = 0x5c; // ESC \ ends a string too
const STRING_START = new Set([0x5d, 0x50, 0x5f, 0x5e, 0x58]); // ] OSC, P DCS, _ APC, ^ PM, X SOS
const MAX_STRING = 8192; // an unterminated string never hides bells for long

/** Feed it each output chunk in order; true when the chunk rang a bare bell. */
export type BellScanner = (chunk: string) => boolean;

function bellScanner(): BellScanner {
  let state = 0, length = 0; // 0 text, 1 after ESC, 2 inside a string, 3 ESC inside a string
  return (chunk) => {
    if (state === 0 && chunk.indexOf('\x1b') < 0) return chunk.indexOf('\x07') >= 0;
    let bell = false;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (state === 0) { if (c === BEL) bell = true; else if (c === ESC) state = 1; }
      else if (state === 1) { if (STRING_START.has(c)) { state = 2; length = 0; } else if (c !== ESC) state = 0; }
      else if (state === 2) { if (c === BEL) state = 0; else if (c === ESC) state = 3; else if (++length > MAX_STRING) state = 0; }
      else if (c === ST_FINAL) state = 0;
      else if (STRING_START.has(c)) { state = 2; length = 0; } // a new string aborts the old one
      else state = c === ESC ? 1 : 0;
    }
    return bell;
  };
}

export { bellScanner };
