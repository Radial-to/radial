// Delivery logic for the daemon's `open` op, extracted from term-daemon.js so it
// is unit-testable without the native node-pty dependency the daemon carries.
//
// The radial-open shim sends {op:'open', termId, url}. We deliver it to every APP
// subscriber except the sender, and return how many received it. The daemon acks
// `ok: delivered > 0` to the shim — so a browser-open with no listener (e.g. the
// app isn't connected) reports failure (exit 1) instead of a false success. That
// false-success case is the exact "says copied but didn't" bug, re-created; the
// ack is what closes it.
//
// clients: iterable of client objects (each may have `.isApp`).
// sender:  the client that sent the open (the shim) — never delivered to.
// payload: { termId, repoDir, url }.
// sendTo:  (client, msg) => void — the daemon's writer.
function relayOpen<C extends RelayClient>(clients: Iterable<C>, sender: C, payload: OpenPayload, sendTo: (client: C, msg: OpenMessage) => void): number {
  let delivered = 0;
  for (const c of clients) {
    if (c.isApp && c !== sender) {
      sendTo(c, { op: 'open', termId: payload.termId, repoDir: payload.repoDir, url: payload.url });
      delivered++;
    }
  }
  return delivered;
}

/**
 * What the shim asked to open: the terminal it came from (null when the shim
 * ran without RADIAL_TERM_ID), that terminal's project (null if unknown), the URL.
 * The app forwards the same three fields to the window (term:open-url).
 */
export interface OpenPayload {
  termId: string | null;
  repoDir: string | null;
  url: string;
}

/** The frame each app subscriber receives. */
export interface OpenMessage extends OpenPayload {
  op: 'open';
}

/** A daemon client as the relay sees it: the app marks itself a subscriber with isApp. */
export interface RelayClient {
  isApp?: boolean;
}

export { relayOpen };
