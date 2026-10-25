import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMessageEvent, WebviewTag } from 'electron';
import type { ProjectPage, RadialApi, RadialConfig } from '../src/shared/radialApi.ts';
import type { ViewportRect } from '../src/shared/overlayMessages.ts';
import type { ViewportMode } from '../src/renderer/threadPreview.ts';
import { launchApp } from './support/app.ts';

// The window's globals the test calls (renderer.ts), as far as it uses them.
// The test adds its own tab: a webview and what zooming reads.
interface ZoomTestTab {
  id: string;
  name: string;
  repoDir: string;
  webview: WebviewTag;
  zoom: number;
  /** Visual zoom and pan. */
  vz: number;
  vtx?: number;
  vty?: number;
  viewportMode: ViewportMode;
  width: number;
  config: Partial<RadialConfig>;
  terminals: unknown[];
  pages: ProjectPage[];
  guides: { axis: 'v' | 'h'; off: number }[];
}
declare const tabs: ZoomTestTab[];
declare let activeId: string | null;
declare let quickEdit: { tab: ZoomTestTab; sels: { rect: ViewportRect }[] } | null;
declare function $(id: 'emptyState' | 'previews'): HTMLDivElement;
declare function activeTab(): ZoomTestTab | null;
declare function applyWidth(tab: ZoomTestTab): void;
declare function handleWebviewMessage(tab: ZoomTestTab, e: IpcMessageEvent): Promise<void>;
declare function zoomVisual(tab: ZoomTestTab | null, factor: number): void;
declare function zoomPreview(mult: number): void;
declare function zoomToSelection(): void;
declare function panVisual(tab: ZoomTestTab | null, dx: number, dy: number): void;
declare function applyVisualZoom(tab: ZoomTestTab): void;
declare const window: Window & typeof globalThis & { radial: RadialApi };

// A resize-driven canvas and a long page exercise the guest's rendering path.
// Record transient viewport changes too: comparing only the final dimensions
// misses the breakpoint/DPR changes caused by the former sharpen timer.
const fixture = `<!doctype html><style>
body{margin:0;font:16px system-ui;background:#faf9f6;color:#242321}
canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
main{position:relative;padding:32px}article{padding:12px;border-bottom:1px solid #ddd}
</style><canvas></canvas><main><h1>Canvas zoom</h1>
${'<article>A long marketing page with editable content</article>'.repeat(2000)}</main>
<script>
window.samples=[];window.frames=0;
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
function measure(){return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio};}
function resize(){
  samples.push(measure());
  // Protect the test runner when running this regression against the old code.
  canvas.width=Math.min(2048,innerWidth*devicePixelRatio);
  canvas.height=Math.min(2048,innerHeight*devicePixelRatio);
}
addEventListener('resize',resize);resize();
function draw(){frames++;ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#dac7a8';ctx.fillRect(frames%300,24,80,80);requestAnimationFrame(draw);}
draw();
</script>`;

test('canvas zoom preserves the guest viewport, stays responsive, and anchors predictably', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-zoom-'));
  let app;
  try {
    app = await launchApp({
      executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'),
      args: ['.'], cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof zoomVisual === 'function');
    await win.evaluate(async (html) => {
      document.body.classList.remove('home-active');
      $('emptyState').style.display = 'none';
      const wv = document.createElement('webview');
      wv.className = 'tab-webview active';
      wv.setAttribute('preload', window.radial.overlayPreloadUrl);
      wv.setAttribute('webpreferences', 'sandbox=no,contextIsolation=no');
      $('previews').append(wv);
      const tab: ZoomTestTab = {
        id: 'zoom-test', name: 'Zoom test', repoDir: '/tmp/radial-zoom-fixture',
        webview: wv, zoom: 1, vz: 1, viewportMode: 'responsive', width: 1440,
        config: {}, terminals: [], pages: [], guides: [],
      };
      tabs.push(tab); activeId = tab.id;
      wv.addEventListener('ipc-message', e => {
        if (['radial:pinch-zoom', 'radial:pan'].includes(e.channel)) handleWebviewMessage(tab, e);
      });
      const ready = new Promise(resolve => (wv as HTMLElement).addEventListener('dom-ready', resolve, { once: true }));
      wv.src = 'data:text/html,' + encodeURIComponent(html);
      await ready;
      applyWidth(tab);
    }, fixture);
    const guest = (code: string) => win.evaluate(code => activeTab()!.webview.executeJavaScript(code) as Promise<unknown>, code);
    for (const mode of ['responsive', 'locked', 'mobile'] as const) {
      await win.evaluate(mode => {
        zoomPreview(0); activeTab()!.viewportMode = mode; applyWidth(activeTab()!);
      }, mode);
      await win.waitForTimeout(300);
      const baseline = await guest('samples=[]; measure()');
      const frames = await guest('frames') as number;
      await win.evaluate(() => zoomPreview(5));
      await win.waitForTimeout(350); // beyond the old 160ms sharpening timer
      await win.evaluate(() => zoomPreview(1 / 1.35));
      await win.waitForTimeout(350);
      assert.deepEqual(await guest('measure()'), baseline, `${mode}: layout and DPR stay fixed`);
      assert.deepEqual(await guest('samples'), [], `${mode}: no transient breakpoint changes`);
      assert.ok((await guest('frames') as number) > frames, `${mode}: guest animation remains alive`);

      // Exercise the actual overlay IPC path with repeated pinch/pan gestures.
      const zoomBeforePinch = await win.evaluate(() => activeTab()!.vz);
      await guest(`window.dispatchEvent(new WheelEvent('wheel',{
        ctrlKey:true,deltaY:-10,clientX:innerWidth/2,clientY:innerHeight/2}));`);
      await win.waitForFunction(before => activeTab()!.vz > before, zoomBeforePinch);
      await guest(`for(let i=0;i<40;i++)window.dispatchEvent(new WheelEvent('wheel',{
        ctrlKey:true,deltaY:i%2 ? 2 : -2,clientX:innerWidth/2,clientY:innerHeight/2}));`);
      await win.waitForTimeout(250);
      assert.deepEqual(await guest('samples'), [], `${mode}: repeated gestures never resize the guest`);
      await win.evaluate(() => {
        quickEdit = { tab: activeTab()!, sels: [{ rect: { x: 100, y: 120, w: 80, h: 40 } }] };
        zoomToSelection(); quickEdit = null;
      });
      assert.equal(await win.evaluate(() => activeTab()!.vz), 5);
      await win.evaluate(() => zoomPreview(0));
      assert.equal(await win.locator('#previews').evaluate(el => el.style.transform), '');
      await win.waitForTimeout(250);
      assert.deepEqual(await guest('samples'), [], `${mode}: selection zoom and reset also preserve layout`);
    }

    await win.evaluate(() => { activeTab()!.viewportMode = 'responsive'; applyWidth(activeTab()!); zoomPreview(2); });
    await win.evaluate(() => { panVisual(activeTab(), 80, 60); applyVisualZoom(activeTab()!); });
    const center = () => win.evaluate(() => {
      const t = activeTab()!, el = $('previews');
      return [(el.offsetWidth / 2 - t.vtx!) / t.vz, (el.offsetHeight / 2 - t.vty!) / t.vz];
    });
    const before = await center();
    await win.evaluate(() => zoomPreview(1.35));
    const after = await center();
    after.forEach((v, i) => assert.ok(Math.abs(v - before[i]) < 0.01, 'keyboard zoom keeps the visible center pinned after panning'));

    // At 100%, the guest regains ordinary page scrolling.
    await win.evaluate(() => zoomPreview(0));
    await win.waitForTimeout(100);
    const box = (await win.locator('#preview').boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.wheel(0, 300);
    await win.waitForTimeout(250);
    assert.ok((await guest('scrollY') as number) > 0, 'reset restores native page scrolling');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
