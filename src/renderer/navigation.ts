// Small, DOM-free helpers for preview navigation. Keeping route matching here
// makes the renderer's async webview flow straightforward to test.

/** The in-flight preview navigation a commit has to match (renderer.js navigateWebview). */
export interface PendingNavigation { id: string; target: string }

function normRoute(route: string | null | undefined): string {
  const path = String(route || '/').split(/[?#]/, 1)[0] || '/';
  return path === '/' ? '/' : path.replace(/\/+$/, '');
}

function routeFromUrl(url: string, baseUrl: string | null | undefined): string | null {
  try {
    const target = new URL(url);
    // A tab with no base yet: the `!` is knowingly loose, new URL throws on it and the catch answers null.
    const base = new URL(baseUrl!);
    return target.origin === base.origin ? normRoute(target.pathname) : null;
  } catch { return null; }
}

function sameRoute(a: string | null | undefined, b: string | null | undefined): boolean { return normRoute(a) === normRoute(b); }

// A navigation can complete only for its own id (when the preload supplies
// one) and its requested route. This rejects late events from an older click.
function acceptsCommit(nav: PendingNavigation | null | undefined, route: string, id?: string | null): boolean {
  if (!nav) return true;
  if (id != null && id !== nav.id) return false;
  return sameRoute(nav.target, route);
}

export { normRoute, routeFromUrl, sameRoute, acceptsCommit };
