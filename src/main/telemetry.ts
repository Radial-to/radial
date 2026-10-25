// Anonymous usage stats — the whole contract lives in this file.
//
// The public promise (trust.html, privacy.html, docs) is: event names only,
// never content. Every event must be in EVENTS below, properties are limited
// to primitives from ALLOWED_PROPS, the distinct ID is a random UUID that
// identifies an installation (not a person), and every event that is actually
// sent is also appended to telemetry-log.jsonl in userData so a user can read
// the exact payloads. The Settings switch persists here; when it is off,
// capture() returns before anything is queued — nothing is sent, not even
// the fact that it was turned off.
//
// Mirrors the recents.js userData-store pattern: init(userDataDir)
// then in-memory getters. PostHog itself is injected via init opts so this
// module stays pure Node and unit-testable under `node --test`.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { PostHog } from 'posthog-node';
import type { RadialApi } from '../shared/radialApi';

// Official builds only: the PostHog key arrives with the official build config
// (officialBuild.js). A build from source has no key, so no client is ever
// made and capture() is a no-op: nothing is sent, events or error reports.
// RADIAL_POSTHOG_KEY / RADIAL_POSTHOG_HOST override both, for tests and for
// anyone deliberately pointing their own build at their own project.
// Region-fixed host: events go to PostHog US Cloud.
// The official radial-cli npm package (radial serve) carries the same config
// (scripts/pack-cli.mts --official) and follows the same contract, and is
// also off whenever CI or DO_NOT_TRACK is set (envOptOut, sendAllowedFor).
import * as official from './officialBuild';
/** The analytics key in an environment: RADIAL_POSTHOG_KEY, else the official build's; null in a build from source. */
function keyFor(env: NodeJS.ProcessEnv = process.env): string | null { return env.RADIAL_POSTHOG_KEY || official.get('posthogKey') || null; }
const POSTHOG_KEY = keyFor();
const POSTHOG_HOST = process.env.RADIAL_POSTHOG_HOST || official.get('posthogHost') || 'https://us.i.posthog.com';

/** Whether an environment variable is set to something that means yes (not empty, 0 or false). */
const setTo = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v.trim());
/**
 * Why usage events are off in an environment whatever the switch says: CI
 * (any CI system sets it) or DO_NOT_TRACK (the console-wide opt-out); null
 * when neither is set. The headless core honors both.
 */
function envOptOut(env: NodeJS.ProcessEnv = process.env): 'CI' | 'DO_NOT_TRACK' | null {
  if (setTo(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (setTo(env.CI)) return 'CI';
  return null;
}
/**
 * Whether a Radial may send at all, before the key and the switch: the Mac
 * app when it's an installed one; radial serve unless CI or DO_NOT_TRACK is
 * set; neither in a throwaway data dir (RADIAL_USERDATA: tests, the smoke).
 * RADIAL_TELEMETRY_FORCE=1 lets a dev or test run send to check the
 * pipeline, never past CI or DO_NOT_TRACK for radial serve.
 */
function sendAllowedFor(flavor: 'packaged' | 'dev' | 'headless', env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.RADIAL_TELEMETRY_FORCE === '1';
  if (flavor === 'headless') return !envOptOut(env) && (!env.RADIAL_USERDATA || forced);
  return (flavor === 'packaged' && !env.RADIAL_USERDATA) || forced;
}

// The full event vocabulary. Also published at radial.to/docs — adding an
// event here means updating that page in the same change.
const EVENTS = new Set([
  'cli_command', // a `radial` verb or MCP tool ran (plans/radial-agent-native.md); prop: command
  'app_opened',
  'project_created',
  'project_opened',
  'agent_session_started',
  'agent_keep_awake', // a session was kept awake or released (rail menu or `radial agent keep`); prop: on
  'launch_check_run',
  'site_published',
  'adjust_applied',
  'adjust_undo',
  'tool_provisioned',
  'app_error',
  'dev_server_memory_restarted', // a dev server over the memory limit was restarted (main.ts checkDevMemory); no props
  'dev_server_memory_stopped', // one that climbed past the limit again right after two restarts was stopped (checkDevMemory); no props
  'serve_started', // radial serve started (src/headless/serve.ts); props: listen (with its HTTP listener), remote (--allow-remote), never an address, a port or a token
] as const);
/** An event capture() sends: one of EVENTS, the vocabulary published at radial.to/docs. */
export type TelemetryEvent = typeof EVENTS extends Set<infer E> ? E : never;

// Property names capture() will pass through. Values must be primitives;
// anything else is dropped. Nothing here can carry user content.
// surface/error_name/where/error_code belong to app_error (see errorReport.ts):
// which process broke, what it was (the error's class, or the kind of thing
// thrown or rejected), where in Radial's own code (like
// "src/renderer/renderer.ts:1234 (showEmpty)"), and a system error's code —
// never the message, which can embed user paths. A process that went away adds
// reason, exit_code, process_type and four counts: memory_mb (its memory at
// the last sample), uptime_min, and how many webviews and terminals were open.
// tweaks belongs to adjust_applied: how many style properties one apply
// batched (a count, never which properties or their values). direct says
// whether that apply wrote source itself or went through the agent. kind
// belongs to tool_provisioned: which tool (claude/gh/gh-auth/node), never
// anything about the machine.
// listen and remote belong to serve_started: whether radial serve took HTTP,
// and whether beyond this machine (booleans, never where). source on
// cli_command is 'http' for an op that came through radial serve's listener
// (MCP at /mcp or the CLI at /rpc), and left out for the control socket.
const ALLOWED_PROPS = new Set(['provider', 'mode', 'template', 'issue_count', 'first_publish', 'surface', 'error_name', 'where', 'error_code', 'reason', 'exit_code', 'process_type', 'memory_mb', 'uptime_min', 'webviews', 'terminals', 'source', 'tweaks', 'direct', 'kind', 'command', 'on', 'listen', 'remote'] as const); // command: a CLI/MCP verb name only — never a target, path or prompt; on: keep-awake toggled on/off
/** A property name capture() passes through (ALLOWED_PROPS). */
export type TelemetryProp = typeof ALLOWED_PROPS extends Set<infer P> ? P : never;
/** An event's properties: allowlisted names with primitive values (anything else is dropped). */
export type TelemetryProps = { [K in TelemetryProp]?: string | number | boolean };
/** The part of a posthog-node client this module uses; tests pass a stand-in. */
export type TelemetryClient = Pick<PostHog, 'capture' | 'shutdown'>;
export interface TelemetryInitOptions {
  appVersion?: string;
  /** The OS's own version: macOS's (process.getSystemVersion, "27.0.0"), never the Darwin kernel's. */
  osVersion?: string;
  /** The Mac app's Electron; radial serve runs on plain Node and has none. */
  electronVersion?: string | null;
  sendAllowed?: boolean;
  makeClient?: () => TelemetryClient;
}
/** radial-telemetry.json in userData: the Settings switch (or `radial telemetry on|off`), the install ID, and whether radial serve showed its one-time note. */
export interface TelemetryStore { enabled: boolean; distinctId: string | null; noticeShown?: boolean }
/** telemetry:set's reply (setEnabled), as the window's RadialApi.telemetrySet declares it. */
export type TelemetrySetResult = Awaited<ReturnType<RadialApi['telemetrySet']>>;

const LOG_NAME = 'telemetry-log.jsonl';
const LOG_MAX_BYTES = 512 * 1024; // rotate: keep the newest lines under this

let filePath: string | null = null;
let logPath: string | null = null;
let store: TelemetryStore = { enabled: true, distinctId: null };
let storeMtimeMs = 0; // the file's mtime when store last matched it: another process's change (radial telemetry off) shows as a new one
let client: TelemetryClient | null = null; // posthog-node instance, null when sending is off the table
let base: { app_version?: string | null; os_version?: string | null; electron_version?: string } = {}; // constant properties: app_version, os_version, and the Mac app's electron_version

const SETTINGS_NAME = 'radial-telemetry.json';
const mtimeOf = (file: string): number => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

function save(): void {
  try { fs.writeFileSync(filePath!, JSON.stringify(store, null, 2)); storeMtimeMs = mtimeOf(filePath!); } catch {}
}

/** A data dir's telemetry settings as they are on disk, writing nothing: on unless switched off, no install ID before init made one. */
function readSettings(dataDir: string): TelemetryStore {
  try { return { enabled: true, distinctId: null, ...(JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_NAME), 'utf8')) as Partial<TelemetryStore>) }; }
  catch { return { enabled: true, distinctId: null }; }
}
/** Changes a data dir's settings on disk (`radial telemetry on|off`, serve's one-time note) without minting an install ID; a running Radial picks it up at its next event. */
function writeSettings(dataDir: string, change: Partial<Pick<TelemetryStore, 'enabled' | 'noticeShown'>>): TelemetryStore {
  const next = { ...readSettings(dataDir), ...change };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SETTINGS_NAME), JSON.stringify(next, null, 2));
  if (filePath === path.join(dataDir, SETTINGS_NAME)) { store = next; storeMtimeMs = mtimeOf(filePath); }
  return next;
}
/** The settings again when another process changed the file since: `radial telemetry off` stops a running serve's next event. */
function refresh(): void {
  if (!filePath) return;
  const m = mtimeOf(filePath);
  if (!m || m === storeMtimeMs) return;
  storeMtimeMs = m;
  try { store = { ...store, ...(JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TelemetryStore>) }; } catch {}
}

// Keep the audit log honest but bounded: on boot, if it outgrew the cap,
// keep the newest half. Losing old lines is fine — PostHog has them; the
// log exists so a user can inspect what leaves their machine.
function rotateLog(): void {
  try {
    const st = fs.statSync(logPath!);
    if (st.size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(logPath!, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(logPath!, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  } catch {}
}

// opts: { appVersion, osVersion, electronVersion, sendAllowed, makeClient }
//   sendAllowed — false in dev / e2e flavors; capture() is then a full no-op.
//   makeClient  — () => PostHog-like ({ capture, shutdown }); injected so
//                 tests can observe payloads without the network.
function init(userDataDir: string, opts: TelemetryInitOptions = {}): void {
  filePath = path.join(userDataDir, SETTINGS_NAME);
  logPath = path.join(userDataDir, LOG_NAME);
  store = readSettings(userDataDir);
  storeMtimeMs = mtimeOf(filePath);
  if (!store.distinctId) { store.distinctId = crypto.randomUUID(); save(); }
  base = { app_version: opts.appVersion || null, os_version: opts.osVersion || null, ...(opts.electronVersion ? { electron_version: opts.electronVersion } : {}) };
  rotateLog();
  client = null; // re-init never inherits a client from a prior config
  if (opts.sendAllowed && POSTHOG_KEY && typeof opts.makeClient === 'function') {
    try { client = opts.makeClient(); } catch { client = null; }
  }
}

function isEnabled(): boolean { return !!store.enabled; }

// Whether this build can send at all: an official build (it has a key) where
// sending is allowed. False in builds from source, dev runs and tests.
function isAvailable(): boolean { return !!client; }

function setEnabled(on: boolean): TelemetrySetResult {
  store.enabled = !!on;
  save();
  return { ok: true, enabled: store.enabled };
}

function capture(event: TelemetryEvent, props: TelemetryProps = {}): void {
  if (!client) return;
  refresh();
  if (!store.enabled) return;
  if (!EVENTS.has(event)) { console.error('[telemetry] dropped unknown event:', event); return; }
  const properties: Record<string, string | number | boolean | null> = { ...base };
  for (const [k, v] of Object.entries(props)) {
    if ((ALLOWED_PROPS as ReadonlySet<string>).has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      properties[k] = v;
    }
  }
  try { fs.appendFileSync(logPath!, JSON.stringify({ ts: new Date().toISOString(), event, ...properties }) + '\n'); } catch {}
  try {
    client.capture({
      distinctId: store.distinctId!,
      event,
      properties: { ...properties, $process_person_profile: false },
      disableGeoip: true,
    });
  } catch {}
}

// Flush queued events on quit. Never lets a slow network hold the app open.
async function shutdown(): Promise<void> {
  if (!client) return;
  try { await Promise.race([client.shutdown(), new Promise((r) => setTimeout(r, 2000))]); } catch {}
  client = null;
}

export { init, capture, isEnabled, isAvailable, setEnabled, shutdown, readSettings, writeSettings, envOptOut, sendAllowedFor, keyFor, EVENTS, ALLOWED_PROPS, LOG_NAME, SETTINGS_NAME, POSTHOG_KEY, POSTHOG_HOST };
