import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from '../src/renderer/threadPreview';
import type { PreviewOwner, PreviewView } from '../src/renderer/threadPreview';

/** A thread as these tests make them: an id beside the view it saved. */
interface Thread<View = PreviewView> extends PreviewOwner<View> { id: string }

test('threads inherit the visible page then remember independent routes, scroll, and viewport', async () => {
  let canvas: PreviewView = { route: '/', scroll: { x: 0, y: 300 }, viewportMode: 'locked', width: 1440, visualZoom: 1 };
  const saved = new Map<string, PreviewView | null | undefined>();
  const controller = create({ read: () => canvas, restore: async view => { canvas = view; }, persist: (term: Thread) => saved.set(term.id, structuredClone(term.preview)) });
  const a = { id: 'a' }, b = { id: 'b' };
  await controller.select(a);
  await controller.select(b);
  assert.equal(canvas.scroll!.y, 300);
  canvas = { ...canvas, route: '/pricing', scroll: { x: 0, y: 750 }, viewportMode: 'mobile', visualZoom: 2 };
  controller.save();
  await controller.select(a);
  assert.equal(canvas.route, '/');
  assert.equal(canvas.scroll!.y, 300);
  assert.equal(canvas.viewportMode, 'locked');
  await controller.select(b);
  assert.equal(canvas.route, '/pricing');
  assert.equal(canvas.scroll!.y, 750);
  assert.equal(canvas.visualZoom, 2);
  assert.equal(saved.get('a')!.scroll!.y, 300);
  const revived = { id: 'b', preview: saved.get('b') };
  const restarted = create({ read: () => ({ route: '/' }), restore: async view => { canvas = view; }, persist: () => {} });
  await restarted.select(revived);
  assert.equal(canvas.scroll!.y, 750);
});

test('rapid thread changes cannot save an unfinished restore over another thread', async () => {
  let canvas = { route: '/', scroll: { x: 0, y: 100 } };
  let release!: () => void;
  const controller = create({ read: () => canvas, persist: () => {}, restore: async (view, current) => {
    if (view.route === '/slow') await new Promise<void>(resolve => { release = resolve; });
    if (current()) canvas = view;
  } });
  const a: Thread<typeof canvas> = { id: 'a' }, b: Thread<typeof canvas> = { id: 'b', preview: { route: '/slow', scroll: { x: 0, y: 900 } } };
  await controller.select(a);
  const pending = controller.select(b);
  await Promise.resolve();
  controller.save();
  await controller.select(a);
  release(); await pending;
  assert.equal(canvas.route, '/');
  assert.equal(a.preview!.scroll.y, 100);
  assert.equal(b.preview!.scroll.y, 900);
});

test('shared mode keeps one view without overwriting the saved per-agent views', async () => {
  let canvas = { route: '/', scroll: { y: 120 } }, savedShared: typeof canvas | undefined;
  const a = { id: 'a', preview: { route: '/a', scroll: { y: 200 } } };
  const b = { id: 'b', preview: { route: '/b', scroll: { y: 700 } } };
  const controller = create({ read: () => canvas, restore: async view => { canvas = view; }, persist() {}, persistShared: view => { savedShared = view; } });
  await controller.select(a);
  await controller.setMode('shared');
  await controller.select(b);
  assert.equal(canvas.route, '/a');
  canvas = { route: '/shared', scroll: { y: 400 } };
  controller.save();
  await controller.select(a);
  assert.equal(canvas.route, '/shared');
  assert.equal(a.preview.route, '/a');
  assert.equal(b.preview.route, '/b');
  await controller.setMode('agent');
  assert.equal(canvas.route, '/a');
  assert.equal(canvas.scroll.y, 200);
  await controller.select(b);
  assert.equal(canvas.route, '/b');
  const restored = create({ mode: 'shared', sharedPreview: savedShared, read: () => canvas, restore: async view => { canvas = view; }, persist() {} });
  await restored.select(b);
  assert.equal(canvas.route, '/shared');
  await restored.select(a);
  assert.equal(canvas.scroll.y, 400);
});

test('changing mode waits for an in-flight thread restore before adopting the shared view', async () => {
  let canvas: PreviewView = { route: '/' }, release!: () => void;
  const controller = create<PreviewView, Thread>({ read: () => canvas, persist() {}, restore: async view => {
    await new Promise<void>(resolve => { release = resolve; }); canvas = view;
  } });
  const selection = controller.select({ id: 'a', preview: { route: '/a' } });
  await Promise.resolve();
  const mode = controller.setMode('shared');
  release(); await selection; await mode;
  assert.equal(controller.mode, 'shared');
  await controller.select({ id: 'b', preview: { route: '/b' } });
  assert.equal(canvas.route, '/a');
});

test('the first new agent adopts the visible page without navigating or dismissing editing UI', async () => {
  const canvas = { route: '/about', scroll: { x: 0, y: 450 } };
  const saved: Thread[] = [];
  let restores = 0;
  const controller = create<PreviewView, Thread>({ read: () => canvas, restore: async () => { restores++; }, persist: term => saved.push(structuredClone(term)) });
  const term: Thread = { id: 'new-agent' };
  await controller.select(term);
  assert.equal(restores, 0);
  assert.deepEqual(term.preview, canvas);
  assert.deepEqual(saved[0].preview, canvas);
  await controller.select({ id: 'restored-agent', preview: { route: '/other', scroll: { x: 0, y: 10 } } });
  assert.equal(restores, 1, 'an existing agent still restores its saved view');
});
