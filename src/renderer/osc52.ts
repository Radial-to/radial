// OSC 52 = the terminal "set clipboard" escape. A CLI copies by emitting
// `ESC ] 52 ; c ; <base64> BEL`; a real terminal honors it. xterm.js drops it
// unless a handler is registered, so a CLI that says "copied" copies nothing.
//
// decodeOsc52(payload) -> string | null   (null = ignore: read-query or malformed)
//   - Write-only: a read/query ("?") payload returns null so a program can never
//     exfiltrate the user's clipboard through OSC 52.
//   - base64 carries UTF-8 BYTES, not Latin-1 — atob() alone corrupts non-ASCII
//     (emoji, accents), so we decode the bytes through TextDecoder.
//   - Caps payload size so a hostile multi-MB write is refused.
//
// Loaded both as a <script> in the renderer (attaches window.decodeOsc52) and via
// require() in tests (module.exports). No DOM/clipboard access here — pure.

var OSC52_MAX = 1 << 20; // 1 MiB of base64

function decodeOsc52(payload: string): string | null {
  var b64 = (String(payload).split(';')[1] || '').trim();
  if (!b64 || b64 === '?' || b64.length > OSC52_MAX) return null;
  try {
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return null;
  }
}

export { decodeOsc52 };
