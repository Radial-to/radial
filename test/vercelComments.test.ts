import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as comments from '../src/main/comments';
import * as vc from '../src/main/vercelComments';
import type { StoredComment } from '../src/main/comments';
import type { VercelRunResult } from '../src/main/vercel';
import type { VercelAttachmentFetch, VercelCliRun, VercelPullOutcome, VercelThread, VercelThreadContext } from '../src/main/vercelComments';
import { tmpDir } from './support/tmp';

// A pull the test expects to succeed: its asserts on the counts fail otherwise.
type Pulled = Extract<VercelPullOutcome, { ok: true }>;
// A pull the test expects to be refused (by the CLI, or before it runs): it asserts `ok` is false first.
type PullRefused = Extract<VercelPullOutcome, { ok: false }>;

function tmp() { return tmpDir('radial-vc-'); }

const THREAD_A = {
  id: 'wl-4IKUcckYD', resolved: false, resolvedBy: null, branch: 'staging', webUrl: 'https://vercel.com/acme-co/site/c/wl-4IKUcckYD', messageCount: 2,
  context: { href: 'https://site-abc.vercel.app/pricing?utm=x', path: '/pricing', selection: 'Book a demo', selector: 'section#pricing > div.flex > a.btn:nth-of-type(2)' },
  messages: [
    { id: 'm1', author: { name: 'Dana', type: 'user' }, timestamp: 1786733118830, text: 'This CTA should say Talk to sales.', attachments: [{ filename: 'shot.png', url: 'https://files.example/shot.png' }] },
    { id: 'm2', author: { username: 'sam', type: 'user' }, timestamp: 1786733200000, text: 'Agreed, on it.' },
  ],
} satisfies VercelThread;
const THREAD_B = {
  id: 'zz-resolved', resolved: true, resolvedBy: { name: 'Dana', type: 'user' }, branch: 'main', webUrl: 'https://vercel.com/acme-co/site/c/zz', messageCount: 1,
  context: { href: 'https://site-abc.vercel.app/', selector: 'body.min-h-full > section.bg-\\[\\#f1eee9\\] > div.mt-10' },
  messages: [{ id: 'm3', author: { name: 'Linear', type: 'app' }, timestamp: 1786700000000, text: 'Converted to LIN-42' }],
} satisfies VercelThread;

// A fake CLI: pages of threads (cursor), inspect for truncated ones, resolve.
interface FakeRunOptions { inspect?: Record<string, VercelThread>; log?: string[]; fail?: (args: string[]) => Promise<VercelRunResult> }
function fakeRun(pages: VercelThread[][], { inspect = {}, log = [], fail }: FakeRunOptions = {}): VercelCliRun {
  return async (args, { cwd }) => {
    log.push(args.join(' '));
    if (fail) return fail(args);
    if (args[1] === 'list') {
      const i = args.indexOf('--next'); const cursor = i >= 0 ? args[i + 1] : null;
      const idx = cursor ? Number(cursor.replace('p', '')) : 0;
      const page = pages[idx] || [];
      return { ok: true, stdout: `\n${JSON.stringify({ scope: {}, filters: {}, pagination: { nextCursor: pages[idx + 1] ? `p${idx + 1}` : null }, threads: page })}\n`, stderr: 'Vercel CLI 59.11.7\nRetrieving project…\n' };
    }
    if (args[1] === 'inspect') { const t = inspect[args[2]]; return t ? { ok: true, stdout: JSON.stringify(t), stderr: '' } : { ok: false, stdout: '{"error":{"code":"not_found","message":"no thread"}}', stderr: '' }; }
    if (args[1] === 'resolve') return { ok: true, stdout: JSON.stringify({ thread: { id: args[2], resolved: true } }), stderr: '' };
    return { ok: false, stdout: '', stderr: `unknown ${args.join(' ')}` };
  };
}
// arrayBuffer() resolves a real ArrayBuffer, as fetch does: a copy of the bytes
// (bytes.buffer would hand over Buffer's shared pool, not just these bytes).
const fakeFetch = (bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]), ok = true): VercelAttachmentFetch => async () => ({ ok, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test('parseJson takes the outermost object from noisy stdout', () => {
  assert.deepEqual(vc.parseJson('banner\n{"a":{"b":1}}\ntrailing'), { a: { b: 1 } });
  assert.equal(vc.parseJson('no json here'), null);
  assert.equal(vc.parseJson('{broken'), null);
});

test('classifyFailure: old CLI, signed out, and API errors', () => {
  assert.equal(vc.classifyFailure({ ok: false, stdout: '', stderr: 'Error: "comments" is not a valid target directory or subcommand. Did you mean "certs"?' }).code, 'unsupported-cli');
  assert.equal(vc.classifyFailure({ ok: false, stdout: '', stderr: 'Error: No existing credentials found. Please run `vercel login`' }).code, 'not-authed');
  const api = vc.classifyFailure({ ok: false, stdout: '{"error":{"code":"PROJECT_NOT_FOUND","message":"Project not found"}}', stderr: '' }, { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
  assert.equal(api.code, 'error'); assert.equal(api.vercelCode, 'PROJECT_NOT_FOUND'); assert.equal(api.error, 'Project not found');
});

test('mapThread: route from href, escaped selector untouched, anchor in Radial form, replies folded, author labels', () => {
  const m = vc.mapThread(THREAD_A);
  assert.equal(m.id, 'vercel-wl-4IKUcckYD');
  assert.equal(m.route, '/pricing');
  assert.equal(m.selector, 'section#pricing > div.flex > a.btn:nth-of-type(2)');
  assert.equal(m.anchor, '<a> “Book a demo”');
  assert.equal(m.text, 'This CTA should say Talk to sales.\n↳ sam: Agreed, on it.');
  assert.equal(m.who, 'Dana');
  assert.equal(m.createdAt, 1786733118830);
  assert.equal(m.resolved, false);
  assert.deepEqual(m.attachments, [{ url: 'https://files.example/shot.png', name: 'shot.png' }]);
  const b = vc.mapThread(THREAD_B);
  assert.equal(b.route, '/');
  assert.equal(b.selector, 'body.min-h-full > section.bg-\\[\\#f1eee9\\] > div.mt-10', 'CSS-escaped selectors pass through as-is (Radial stores escaped ones too)');
  assert.equal(b.anchor, '<div>');
  assert.equal(b.who, 'Linear (app)');
  assert.equal(b.resolved, true); assert.equal(b.resolvedBy, 'Dana');
  assert.equal(vc.routeOf({ path: 'about' }), '/about');
  assert.equal(vc.routeOf({}), '/');
  assert.equal(vc.anchorOf({ selector: '.hero > .cta', selection: 'x' }), '“x”');
});

test('pull writes synced comments, downloads attachments once, and is idempotent', async () => {
  const dir = tmp();
  const mine = comments.add(dir, { route: '/', selector: 'h1', anchor: '<h1>', text: 'mine, untouched' }) as StoredComment;
  const log: string[] = [];
  const truncated = { ...THREAD_A, messages: [THREAD_A.messages[0]] }; // listing shows 1 of 2
  const run = fakeRun([[truncated], [THREAD_B]], { inspect: { 'wl-4IKUcckYD': THREAD_A }, log });
  let fetches = 0;
  const fetchImpl: VercelAttachmentFetch = async (...a) => { fetches++; return fakeFetch()(...a); };
  const r = await vc.pull(dir, { run, fetchImpl }) as Pulled;
  assert.deepEqual({ ok: r.ok, total: r.total, added: r.added, updated: r.updated, changed: r.changed }, { ok: true, total: 2, added: 2, updated: 0, changed: true });
  assert.ok(log.some((l) => l.startsWith('comments list --json --status all --all-branches --limit 100') && !l.includes('--scope')), log.join('\n'));
  assert.ok(log.some((l) => l.includes('--next p1')), 'paginated with the cursor');
  assert.ok(log.some((l) => l.startsWith('comments inspect wl-4IKUcckYD --json')), 'refetched the truncated thread');
  const list = comments.list(dir);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, mine.id, 'own comment keeps its place');
  const b = list[1], a = list[2]; // appended oldest first
  assert.equal(b.id, 'vercel-zz-resolved'); assert.equal(b.resolved, true); assert.equal(b.resolvedBy, 'Dana'); assert.equal(b.vercelResolved, true);
  assert.equal(a.id, 'vercel-wl-4IKUcckYD'); assert.equal(a.source, 'vercel'); assert.equal(a.addressed, false); assert.equal(a.url, THREAD_A.webUrl);
  assert.equal(a.text, 'This CTA should say Talk to sales.\n↳ sam: Agreed, on it.', 'the inspect result (both messages) is what landed');
  assert.equal(a.images!.length, 1); assert.match(a.images![0], /^\.radial\/comment-images\/vercel-wl-4IKUcckYD-1\.png$/);
  assert.ok(fs.existsSync(path.join(dir, a.images![0])));
  assert.equal(fetches, 1);
  assert.ok(!fs.readdirSync(path.join(dir, '.radial')).some((f) => f.includes('.tmp-')), 'atomic save left no temp file');
  // Second pull: nothing changes, nothing is written, nothing re-downloaded.
  const before = fs.statSync(path.join(dir, '.radial', 'comments.json')).mtimeMs;
  await new Promise((res) => setTimeout(res, 20));
  const r2 = await vc.pull(dir, { run, fetchImpl }) as Pulled;
  assert.deepEqual({ added: r2.added, updated: r2.updated, changed: r2.changed }, { added: 0, updated: 0, changed: false });
  assert.equal(fs.statSync(path.join(dir, '.radial', 'comments.json')).mtimeMs, before);
  assert.equal(fetches, 1);
});

test('ownership: Vercel overwrites text/route/selector, Radial keeps addressed + offsets, resolved only moves forward', async () => {
  const dir = tmp();
  const run1 = fakeRun([[THREAD_A]]);
  await vc.pull(dir, { run: run1, fetchImpl: fakeFetch() });
  // Radial-side work: addressed, a dragged pin, and resolved locally.
  comments.update(dir, 'vercel-wl-4IKUcckYD', { addressed: true, offsetX: 0.3, offsetY: 0.7, resolved: true, resolvedBy: '' });
  // Vercel-side: a new reply, moved element, still open there.
  const moved = { ...THREAD_A, context: { ...THREAD_A.context, href: 'https://site-abc.vercel.app/plans', selector: 'main > a.cta' }, messages: [...THREAD_A.messages, { id: 'm9', author: { name: 'Dana' }, timestamp: 1786740000000, text: 'Also the color.' }] };
  const r = await vc.pull(dir, { run: fakeRun([[moved]]), fetchImpl: fakeFetch() }) as Pulled;
  assert.equal(r.updated, 1);
  const c = comments.list(dir)[0];
  assert.equal(c.route, '/plans'); assert.equal(c.selector, 'main > a.cta');
  assert.match(c.text, /↳ Dana: Also the color\.$/);
  assert.equal(c.addressed, true); assert.equal(c.offsetX, 0.3); assert.equal(c.offsetY, 0.7);
  assert.equal(c.resolved, true, 'a pull never reopens what Radial resolved');
  assert.equal(c.vercelResolved, false, 'but remembers Vercel still shows it open');
  assert.equal(vc.pendingResolves(dir).length, 1);
  // Vercel resolves it → resolvedBy comes from Vercel only when Radial had it open.
  const dir2 = tmp();
  await vc.pull(dir2, { run: fakeRun([[THREAD_A]]), fetchImpl: fakeFetch() });
  const r2 = await vc.pull(dir2, { run: fakeRun([[{ ...THREAD_A, resolved: true, resolvedBy: { name: 'Dana' } }]]), fetchImpl: fakeFetch() }) as Pulled;
  assert.equal(r2.resolved, 1);
  const c2 = comments.list(dir2)[0];
  assert.equal(c2.resolved, true); assert.equal(c2.resolvedBy, 'Dana'); assert.equal(c2.vercelResolved, true);
  assert.equal(vc.pendingResolves(dir2).length, 0);
});

test('a failed attachment keeps the URL in the text, retries up to 3 pulls, and never touches other comments', async () => {
  const dir = tmp();
  comments.add(dir, { route: '/', text: 'keep me' });
  const run = fakeRun([[THREAD_A]]);
  for (let i = 0; i < 4; i++) await vc.pull(dir, { run, fetchImpl: fakeFetch(Buffer.alloc(0), false) });
  const list = comments.list(dir);
  assert.equal(list[0].text, 'keep me');
  const c = list[1];
  assert.deepEqual(c.images, []);
  assert.match(c.text, /\(attachment: https:\/\/files\.example\/shot\.png\)$/);
  assert.equal(c.attachments![0].tries, 3);
  // A later pull that succeeds is not attempted past the cap; the text still carries the link.
  const r = await vc.pull(dir, { run, fetchImpl: fakeFetch() }) as Pulled;
  assert.equal(r.changed, false);
});

test('a malformed comments file refuses the pull instead of wiping it', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.radial')); fs.writeFileSync(path.join(dir, '.radial', 'comments.json'), '{ not an array');
  const r = await vc.pull(dir, { run: fakeRun([[THREAD_A]]), fetchImpl: fakeFetch() }) as PullRefused;
  assert.equal(r.ok, false); assert.match(r.error, /not a valid JSON array/);
  assert.equal(fs.readFileSync(path.join(dir, '.radial', 'comments.json'), 'utf8'), '{ not an array');
});

test('CLI failures map to codes; a wrong-team listing retries with the scope', async () => {
  const dir = tmp();
  const old = await vc.pull(dir, { run: async () => ({ ok: false, stdout: '', stderr: 'Error: "comments" is not a valid target directory or subcommand.' }) });
  assert.equal(old.code, 'unsupported-cli');
  const out = await vc.pull(dir, { run: async () => ({ ok: false, stdout: '', stderr: 'Error: No existing credentials found. Please run `vercel login`' }) });
  assert.equal(out.code, 'not-authed');
  const log: string[] = [];
  const run: VercelCliRun = async (args) => {
    log.push(args.join(' '));
    if (!args.includes('--scope')) return { ok: false, stdout: '{"error":{"code":"PROJECT_NOT_FOUND","message":"Project not found"}}', stderr: '' };
    return { ok: true, stdout: JSON.stringify({ pagination: {}, threads: [THREAD_B] }), stderr: '' };
  };
  const r = await vc.pull(dir, { run, scope: 'acme-co' }) as Pulled;
  assert.equal(r.ok, true); assert.equal(r.added, 1);
  assert.ok(log[1].endsWith('--scope acme-co'), log.join('\n'));
});

test('resolvePushed resolves locally-resolved synced comments on Vercel once, with the commit in the note', async () => {
  const dir = tmp();
  await vc.pull(dir, { run: fakeRun([[THREAD_A, { ...THREAD_B, resolved: false, resolvedBy: null }]]), fetchImpl: fakeFetch() });
  comments.add(dir, { route: '/', text: 'own comment', });
  const own = comments.list(dir).find((c) => c.text === 'own comment')!;
  comments.update(dir, own.id, { resolved: true });
  comments.update(dir, 'vercel-wl-4IKUcckYD', { resolved: true, resolvedBy: '' });
  const log: string[] = [];
  const r = await vc.resolvePushed(dir, { run: fakeRun([], { log }), sha: 'abc1234', now: () => 42 });
  assert.deepEqual({ ok: r.ok, done: r.done, failed: r.failed, pending: r.pending }, { ok: true, done: 1, failed: 0, pending: 1 });
  assert.deepEqual(log, ['comments resolve wl-4IKUcckYD -m Resolved in Radial, pushed as abc1234 --yes --json']);
  const c = comments.list(dir).find((x) => x.id === 'vercel-wl-4IKUcckYD')!;
  assert.equal(c.vercelResolved, true); assert.equal(c.vercelPushedAt, 42);
  // Again: nothing pending, no CLI call.
  const log2: string[] = [];
  const r2 = await vc.resolvePushed(dir, { run: fakeRun([], { log: log2 }), sha: 'abc1234' });
  assert.equal(r2.pending, 0); assert.deepEqual(log2, []);
  // A failure leaves it pending for the next publish.
  comments.update(dir, 'vercel-zz-resolved', { resolved: true, resolvedBy: '' });
  const r3 = await vc.resolvePushed(dir, { run: async () => ({ ok: false, stdout: '{"error":{"code":"internal","message":"boom"}}', stderr: '' }), sha: 'def' });
  assert.equal(r3.ok, false); assert.equal(r3.failed, 1); assert.equal(r3.error, 'boom');
  assert.equal(vc.pendingResolves(dir).length, 1);
});

// ── Everything else the CLI exposes (shape observed on a real project, 2026-09-04) ──
const REAL_CTX = {
  href: 'https://site-abc.vercel.app/?_vercel_share=abc', path: '/?_vercel_share=abc', pageTitle: 'NPS Prism | NPS Benchmarking',
  selector: 'body.min-h-full > section.w-full > div.w-full:nth-of-type(3) > div.relative',
  device: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', screenWidth: 1680, screenHeight: 962, devicePixelRatio: 2 },
  frameworkContext: 'React Component Tree (root to selected element):\n\nSelected: <div.relative.w-full.overflow-hidden>\n\n... [19 more] ...\n  <_  ...>\n    <[minified] name="/" ...>\n      <[minified] url="/" tree="[Array(5)]" ...>\n        <section className="w-full overflow-x-clip bg-[#f3f1ec]">\n          <div className="w-full">\n            <div className="relative w-full overflow-hidden bg-[#490732]">',
} satisfies VercelThreadContext;

test('altSelectors: the selector without nth-of-type counts, then the tag.classes descriptor Vercel prints', () => {
  assert.deepEqual(vc.altSelectors(REAL_CTX), ['body.min-h-full > section.w-full > div.w-full > div.relative', 'div.relative.w-full.overflow-hidden']);
  assert.deepEqual(vc.altSelectors({ selector: 'main > a.cta' }), [], 'nothing to relax, no descriptor');
  assert.deepEqual(vc.altSelectors({ selector: 'section#pricing > div.flex:nth-of-type(2) > a.btn:nth-of-type(2)', frameworkContext: 'Selected: <a.btn>' }), ['section#pricing > div.flex > a.btn:nth-of-type(2)', 'section#pricing > div.flex > a.btn', 'a.btn'], 'the element keeps which sibling it was; only the ancestors relax first');
  assert.deepEqual(vc.altSelectors({ selector: 'a.btn', frameworkContext: 'Selected: <a.btn>' }), [], 'a descriptor equal to the selector is not repeated');
  assert.deepEqual(vc.altSelectors({ selector: 'section > div', frameworkContext: 'Selected: <div.max-w-[1200px].lg:flex>' }), ['div.max-w-\\[1200px\\].lg\\:flex'], 'Tailwind classes come out CSS-escaped');
});

test('treeLines keeps the component lines with classNames and drops the header and minified frames', () => {
  assert.deepEqual(vc.treeLines(REAL_CTX.frameworkContext), [
    '<section className="w-full overflow-x-clip bg-[#f3f1ec]">', '<div className="w-full">', '<div className="relative w-full overflow-hidden bg-[#490732]">',
  ]);
  assert.deepEqual(vc.treeLines(''), []);
  assert.equal(vc.treeLines(Array.from({ length: 20 }, (_, i) => `<div className="l${i}">`).join('\n')).length, 8, 'capped to the last 8');
});

test('deviceOf: platform and browser label, screen, and the viewport class that picks the canvas preset', () => {
  const mac = vc.deviceOf(REAL_CTX.device);
  assert.deepEqual(mac, { label: 'Mac · Chrome', w: 1680, h: 962, dpr: 2, viewport: 'desktop' });
  const phone = vc.deviceOf({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 });
  assert.equal(phone.label, 'iPhone · Safari'); assert.equal(phone.viewport, 'mobile');
  assert.equal(vc.deviceOf({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', screenWidth: 820, screenHeight: 1180 }).viewport, 'tablet');
  assert.equal(vc.deviceOf({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36 Edg/120.0', screenWidth: 1920, screenHeight: 1080 }).label, 'Windows · Edge');
  assert.deepEqual(vc.deviceOf(null), { label: '', w: 0, h: 0, dpr: 0, viewport: 'desktop' });
});

test('mapThread carries the fallbacks, the where-it-was-left facts, the tree and the avatar, deterministically', () => {
  const thread = { ...THREAD_A, branch: 'staging', isLocalhost: false, context: REAL_CTX, messages: [{ ...THREAD_A.messages[0], author: { name: 'Dana', type: 'user', avatar: 'https://vercel.com/api/www/avatar/?u=dana&s=64' } }] };
  const m = vc.mapThread(thread);
  assert.equal(m.route, '/', 'the share query never leaks into the route');
  assert.deepEqual(m.alt, ['body.min-h-full > section.w-full > div.w-full > div.relative', 'div.relative.w-full.overflow-hidden']);
  assert.equal(m.selText, '');
  assert.deepEqual(m.vercel, {
    href: REAL_CTX.href, path: REAL_CTX.path, pageTitle: 'NPS Prism | NPS Benchmarking', branch: 'staging', localhost: false,
    device: 'Mac · Chrome', screen: { w: 1680, h: 962, dpr: 2 }, viewport: 'desktop',
    tree: ['<section className="w-full overflow-x-clip bg-[#f3f1ec]">', '<div className="w-full">', '<div className="relative w-full overflow-hidden bg-[#490732]">'],
    avatar: 'https://vercel.com/api/www/avatar/?u=dana&s=64',
  });
  assert.deepEqual(vc.mapThread(thread), m, 'pure: the same thread maps to the same comment');
  // Landed comments keep all of it; a re-pull with the same thread writes nothing.
  const dir = tmp();
  return (async () => {
    const run = fakeRun([[thread]]);
    await vc.pull(dir, { run, fetchImpl: fakeFetch() });
    const c = comments.list(dir)[0];
    assert.deepEqual(c.alt, m.alt); assert.equal(c.vercel!.viewport, 'desktop'); assert.equal(c.vercel!.branch, 'staging');
    const r2 = await vc.pull(dir, { run, fetchImpl: fakeFetch() }) as Pulled;
    assert.equal(r2.changed, false);
  })();
});
