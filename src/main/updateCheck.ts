// "Check for Updates…" (app menu) — the update path for a manual-dmg app.
// Asks the public releases API for the newest tag, compares against the
// running version, and hands the verdict back to main.js, which owns the
// dialogs. No auto-download, no background polling: the user asks, we answer,
// and the Download button just opens radial.to/download.
//
// Pure Node (fetch only), fetch injectable — unit-testable under `node --test`.

const RELEASES_API = process.env.RADIAL_RELEASES_API
  || 'https://api.github.com/repos/Radial-to/radial-releases/releases/latest';
const DOWNLOAD_URL = 'https://radial.to/download';

/** A parsed version: [major, minor, patch]. */
export type Version = [number, number, number];

/** The slice of fetch check() uses; global fetch fits, and tests pass a fake. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** check()'s options. */
export interface ReleaseCheckOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** check()'s verdict: versions without the leading v. */
export type ReleaseCheckResult =
  | { ok: true; current: string; latest: string; updateAvailable: boolean }
  | { ok: false; error: string };

// The part of GitHub's latest-release payload we read.
interface LatestRelease {
  tag_name?: unknown;
}

// 'v0.5.0' | '0.5.0' → [0, 5, 0]; null if it doesn't look like a version.
function parse(tag: string | null | undefined): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest: string, current: string): boolean {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

// → { ok: true, current, latest, updateAvailable } or { ok: false, error }.
// Never throws.
async function check(current: string, { fetchImpl = fetch, timeoutMs = 10000 }: ReleaseCheckOptions = {}): Promise<ReleaseCheckResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    // GitHub's JSON, trusted as before: a null body throws on .tag_name and lands
    // in the catch below; any other body without a tag fails the version check.
    const body = await res.json() as LatestRelease;
    const latest = String(body.tag_name || '').replace(/^v/, '');
    if (!parse(latest)) return { ok: false, error: 'no version tag in latest release' };
    return { ok: true, current, latest, updateAvailable: isNewer(latest, current) };
  } catch (e) {
    return { ok: false, error: String(((e as Error) && (e as Error).message) || e) };
  }
}

export { check, isNewer, parse, DOWNLOAD_URL };
