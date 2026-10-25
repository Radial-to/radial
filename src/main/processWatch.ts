// When one of Electron's processes goes away (the window's own renderer, a
// preview's, the GPU process, a utility process), app_error says so with the
// reason, the exit code and a few numbers that hold no content: the memory
// the process used at the last sample, how long the app had been up, and how
// many previews and terminals were open (errorReport.reportGone).
//
// No minidumps, and no crashReporter uploads: a dump holds the process's
// memory, which can be page content (the site in a preview, the text in the
// window), and the usage-data page promises nothing but these events leaves
// the Mac. Don't add Electron's crashReporter here.
import type { App, ProcessMetric, RenderProcessGoneDetails, WebContents } from 'electron';
import type { GoneCounts, GoneDetails } from './errorReport';

/** What this file needs of Electron's webContents module: every live webContents. */
export interface WebContentsList { getAllWebContents(): WebContents[] }
/** errorReport.reportGone, or a test's stand-in. */
export type ReportGone = (surface: 'renderer' | 'preview' | 'process', details: GoneDetails, counts: GoneCounts) => void;

export interface WatchOptions {
  app: Pick<App, 'on' | 'getAppMetrics'>;
  webContents: WebContentsList;
  report: ReportGone;
  /** Whether a webContents is the app's own window (its renderer is the window); any other is a page (a preview, a popup, the screenshot window). */
  isAppWindow(contents: WebContents): boolean;
  /** How many terminals are running, when an already-connected PTY daemon says so in time; null when not (never start one for this). */
  terminals?(): Promise<number | null>;
  /** How often to sample memory, in ms. */
  sampleMs?: number;
  /** Seconds the process has been up (process.uptime). */
  uptime?(): number;
}

/** What watchProcesses leaves running: a sample now (for tests), and the timer's stop. */
export interface ProcessWatch { sample(): void; stop(): void }

const mb = (kb: number): number => Math.round(kb / 1024);

/** Watches the app's processes until it quits, reporting each that goes away. */
export function watchProcesses({ app, webContents, report, isAppWindow, terminals, sampleMs = 30000, uptime = () => process.uptime() }: WatchOptions): ProcessWatch {
  let quitting = false;
  // At the last sample, each made afresh so a process that's gone leaves nothing behind:
  let memoryOf = new Map<number, number>(); // webContents id → MB
  let memoryOfType = new Map<string, number>(); // a process's type (GPU, Utility:<service>) → MB
  const typeOf = (m: Pick<ProcessMetric, 'type' | 'serviceName'>): string => (m.serviceName ? `${m.type}:${m.serviceName}` : m.type);

  function sample(): void {
    try {
      const metrics = app.getAppMetrics();
      const byPid = new Map(metrics.map((m) => [m.pid, m]));
      const byType = new Map<string, number>();
      for (const m of metrics) byType.set(typeOf(m), mb(m.memory.workingSetSize));
      const byContents = new Map<number, number>();
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        const m = byPid.get(wc.getOSProcessId());
        if (m) byContents.set(wc.id, mb(m.memory.workingSetSize));
      }
      memoryOf = byContents;
      memoryOfType = byType;
    } catch {}
  }
  const timer = setInterval(sample, sampleMs);
  timer.unref?.();

  async function counts(memoryMb: number | undefined): Promise<GoneCounts> {
    const webviews = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getType() === 'webview').length;
    let open: number | null = null;
    if (terminals) {
      let wait: NodeJS.Timeout | undefined;
      try { open = await Promise.race([terminals(), new Promise<null>((r) => { wait = setTimeout(() => r(null), 1500); })]); } catch {} finally { clearTimeout(wait); }
    }
    return { memoryMb, uptimeMin: Math.round(uptime() / 60), webviews, ...(open === null ? {} : { terminals: open }) };
  }

  app.on('before-quit', () => { quitting = true; });
  // A renderer: the window's own, or a page's.
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.on('render-process-gone', (_ev, details: RenderProcessGoneDetails) => {
      if (quitting || details.reason === 'clean-exit') return;
      const surface = isAppWindow(contents) ? 'renderer' : 'preview';
      void counts(memoryOf.get(contents.id)).then((c) => { try { report(surface, { reason: details.reason, exitCode: details.exitCode }, c); } catch {} });
    });
  });
  // Every other process: the GPU process, the network and other utility processes.
  app.on('child-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    const type = typeOf({ type: details.type as ProcessMetric['type'], serviceName: details.serviceName });
    void counts(memoryOfType.get(type)).then((c) => { try { report('process', { reason: details.reason, exitCode: details.exitCode, processType: type }, c); } catch {} });
  });
  return { sample, stop: () => clearInterval(timer) };
}
