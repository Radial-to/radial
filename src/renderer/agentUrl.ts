// classifyUrl(url, baseUrl) -> 'webview' | 'external' | 'blocked'
//
// Decides where an agent-requested URL goes:
//   'webview'  — same origin as the project's dev server → load in the in-app
//                preview. Loopback hosts are treated as equivalent (an agent
//                often prints http://localhost:PORT while the dev server resolved
//                to http://127.0.0.1:PORT — same server).
//   'external' — any other http(s) URL → system browser (openExternal).
//   'blocked'  — non-http(s) or malformed (file://, junk). NEVER 'webview', and
//                not 'external' either since app:openExternal rejects non-http(s).
//
// Pure: no DOM. Loaded as a <script> (window.classifyUrl) and via require() in tests.

/** Where an agent-requested URL goes (see above). */
export type UrlTarget = 'webview' | 'external' | 'blocked';

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function classifyUrl(url: string, baseUrl?: string | null): UrlTarget {
  var u: URL;
  try { u = new URL(url); } catch (e) { return 'blocked'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'blocked';
  if (baseUrl) {
    try {
      var b = new URL(baseUrl);
      if (b.origin === u.origin) return 'webview';
      // loopback equivalence: same scheme + port, both loopback hosts.
      if (b.protocol === u.protocol && b.port === u.port &&
          isLoopback(b.hostname) && isLoopback(u.hostname)) return 'webview';
    } catch (e) { /* fall through to external */ }
  }
  return 'external';
}

export { classifyUrl };
