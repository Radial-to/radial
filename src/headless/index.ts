/**
 * `radial serve`: the host that runs Radial's core (src/core) under plain Node
 * with no window, for a coding agent in a VM, a container or a Linux server
 * (plans/headless-core.md). serve.ts builds the core with the Node platform,
 * no page and no viewer, takes the data dir's control socket (refusing when
 * another Radial already answers there), stops the dev servers on SIGINT and
 * SIGTERM, and with --detach runs in the background, logging to the data dir.
 * The `radial` CLI reaches it through command(), and starts one through
 * spawnDetached() when nothing answers and there's no Mac app to launch.
 * browser.ts is `radial browser [install]`, the browser its page work uses,
 * and doctor.ts is `radial doctor`, what serve needs on the machine; the CLI
 * loads them on their own, without the core.
 *
 * With --listen (phase 4), listen.ts takes HTTP beside the socket (MCP, the
 * CLI's /rpc, events and files), with apiTokens.ts's tokens (`radial token`),
 * and previewProxy.ts gives each open project's preview a stable port.
 *
 * Like the core, it never reaches electron or electron-updater
 * (test/coreBoundary.test.ts).
 */
export { command, run, detach, status, stop, spawnDetached, hello, eventLog, nodePlatform, serveOptions, parseIdle, logFile, listenConfig } from './serve';
export type { Log, ServeReply, ListenConfig } from './serve';
export { command as tokenCommand } from './apiTokens';
export { startListener, parseListen } from './listen';
export type { HttpListener } from './listen';
export { command as browserCommand, browserInfo, install as installBrowser } from './browser';
export type { BrowserInfo, InstallReply } from './browser';
export { command as doctorCommand, checks as doctorChecks } from './doctor';
export type { Check } from './doctor';
