/**
 * The control socket's API (cliServer.ts's CliApi): what the `radial` CLI,
 * `radial mcp` and the Home agent drive, answered by the core's modules.
 * cliServer.ts validates each request and calls one of these. Moved from
 * main.ts (plans/headless-core.md, phase 1).
 */
import fs from 'fs';
import path from 'path';
import * as editEngine from '../main/editEngine';
import * as projectState from '../main/projectState';
import * as recents from '../main/recents';
import * as github from '../main/github';
import * as projectResolve from '../main/projectResolve';
import * as cliOpen from '../main/cliOpen';
import * as telemetry from '../main/telemetry';
import * as terminal from '../main/terminal';
import * as comments from '../main/comments';
import * as publish from '../main/publish';
import * as context from '../main/context';
import * as references from '../main/references';
import * as project from '../main/project';
import * as tokens from '../main/tokens';
import * as projectMemory from '../main/projectMemory';
import * as projectData from '../main/projectData';
import * as moments from '../main/moments';
import * as migrate from '../main/migrate';
import type { CliApi, ContextDoc, OpenProjectRow, ProjectList } from '../main/cliServer';
import type { CommentsRefusal, StoredComment } from '../main/comments';
import type { DeployEvent } from '../main/deploy';
import type { DevInfo } from '../main/devServer';
import type { SiteCapture, SiteComparison } from '../main/migrate';
import type { MomentListWithoutPreview } from '../main/moments';
import type { PageEntry } from '../main/project';
import type { TokenSummary } from '../main/tokens';
import type { CliResult, DevRestartResult, ElementContext, MomentList, ProjectReference, RepoState, SyncOptions } from '../shared/radialApi';
import type { LooseUnion } from './types';
import { activeRepoDir, notifyCommentsChanged, pullVercelComments, restartDevServer, sessions, stopSession, suspendSession, wake } from './sessions';
import { doRedo, doUndo, notifyMomentCreated, recordEdit } from './history';
import { agentKeep, agentKill, agentList, agentOutput, agentWait, sessionState } from './agents';
import { questions } from './questions';
import { META_FIELDS, nudgePreview, pageFileFor, swapImageFile } from './edits';
import { createNewProject, migrateLaunch, migratePrepare, migrationPlaybook, publishDeploy, publishPlain, syncCtxIndex, writeMigrationRecord } from './flows';
import { closeWithoutWindow, openWithoutWindow } from './fallbacks';
import { sendToAgent, startAgent, startHome } from './agentLane';
import { browserPage, platform, send, viewer } from './host';
import { noBrowser } from '../main/cliServer';
// The ⌘K palette's matcher (a UMD module the window shares), for a name → a project.
const fuzzy = require('../renderer/fuzzy.js') as typeof import('../renderer/fuzzy.js');

/**
 * A stored comment with its attachments dropped from the type: a bridge until
 * cliServer.ts declares comments.ts's StoredComment for CliApi's comments,
 * commentAdd and commentResolve (and the comments reply). Those say radialApi's
 * ReviewComment, whose attachments ({ url, name }) are not the ones comments.json
 * keeps ({ url, rel, tries }), so a stored comment passes only without them.
 * The CLI's and MCP's JSON still carries the stored attachments.
 */
type StoredCommentWithoutAttachments = Omit<StoredComment, 'attachments'>;
/**
 * cliServer's SyncRequest as cliApi passes it to publish.sync: radialApi's
 * SyncOptions, a knowingly loose cast until SyncOptions widens to SyncRequest
 * (as SyncRequest's doc asks). A 'ff', '' or null strategy and a null target
 * pass through, and integration.start reads them as the default fast-forward
 * from the upstream.
 */
type SyncRequestAsOptions = SyncOptions;

function readDevJson(dir: string): DevInfo | null { try { return JSON.parse(fs.readFileSync(projectData.dataDir(dir, 'dev.json'), 'utf8')); } catch { return null; } }
export function cliApi(): CliApi {
  const previewUrl = (dir: string): string | null => {
    const s = sessions.get(dir);
    if (s && !s.suspended && s.handle && s.handle.url) return s.handle.url;
    const j = readDevJson(dir); return (j && j.url) || null;
  };
  return {
    info: () => {
      const v = viewer(), l = platform().listener?.();
      return { version: platform().version, flavor: platform().flavor, pid: process.pid, windowReady: v ? v.ready() : false, browser: !!browserPage(), ...(l ? { listen: l.address } : {}) };
    },
    isOpen: (dir) => sessions.has(dir),
    focus: (): ReturnType<CliApi['focus']> => { const v = viewer(); if (!v) return { headless: true }; v.focus(); return {}; },
    telemetry: (command, via) => telemetry.capture('cli_command', { command: String(command || '').slice(0, 24), ...(via && via.http ? { source: 'http' } : {}) }), // over radial serve's listener: counted as such, never by who or where
    requestOpen: (dir) => { const v = viewer(); if (v) v.open(dir); else openWithoutWindow(dir); },
    async resolve(target, cwd) {
      const sources = {
        open: [...sessions.entries()].map(([dir, s]) => ({ path: dir, name: s.project && s.project.name, pageTitle: (projectState.get(dir) || {}).pageTitle, suspended: !!s.suspended })),
        recents: recents.listRecents(),
        available: (() => { try { return recents.scanProjectsDir(); } catch { return []; } })(),
        workspace: github.listWorkspaceDirs(),
      };
      const findLocalCopy = (url: string): string | null => {
        try { return github.findLocalCopy(url, { knownPaths: [...recents.listRecents().map((r) => r.path), ...recents.getSession().open, ...sessions.keys()], extraRoots: [recents.getProjectsDir()].filter(Boolean) }); }
        catch { return null; }
      };
      return projectResolve.resolve(target, { cwd, sources, normalizeOpenPath: cliOpen.normalizeOpenPath, urlFromText: github.urlFromText, findLocalCopy, fuzzy });
    },
    async clone(url, progress) {
      try {
        const res = await github.cloneOrPull(url, github.workspaceRoot(), (line) => { progress(line); send('log', line); });
        return { ok: true, dir: res.dir, github: { action: res.action, dirty: res.dirty, defaultBranch: res.defaultBranch } };
      } catch (e) {
        const msg = /not found|could not read|authentication|permission denied/i.test((e as Error).message) ? `GitHub can't find ${url}. Check the link, or sign in with gh if it's private.` : (e as Error).message;
        return { ok: false, code: 'error', error: msg };
      }
    },
    async projects({ all }) {
      const projects: OpenProjectRow[] = [];
      for (const [dir, s] of sessions) {
        // Triage columns for a phone or an agent: what needs a person here?
        let terminals = 0, waiting = 0; try { const live = (await terminal.list(dir)).filter((t) => t.alive); terminals = live.length; waiting = live.filter((t) => sessionState(t) === 'waiting').length; } catch {}
        let openComments = 0; try { openComments = (comments.list(dir) || []).filter((c) => !c.resolved).length; } catch {}
        let changes: number | null = null; try { const st = await publish.status(dir); changes = st.isRepo ? st.changes!.length : null; } catch {} // a failed status (changes: null) throws into the catch: null
        projects.push({ repoDir: dir, name: (s.project && s.project.name) || path.basename(dir), url: (s.handle && s.handle.url) || null, state: s.suspended ? 'asleep' : 'running', active: dir === activeRepoDir, terminals, waiting, openComments, changes });
      }
      const out: ProjectList = { projects };
      if (all) out.recents = recents.listRecents().filter((r) => !sessions.has(r.path)).map((r) => ({ repoDir: r.path, name: r.name || path.basename(r.path), lastOpened: r.lastOpened || null }));
      return out;
    },
    previewUrl,
    // radial serve --listen: the open project's preview proxy (src/headless/previewProxy.ts). A share link for a project that isn't open says why there's none.
    async previewAddress(dir, ask) {
      const l = platform().listener?.();
      if (!l) return null;
      if (!sessions.has(dir)) return ask.share ? { ok: false, error: `${dir} is not open, so it has no preview to share. Run \`radial open ${dir}\` first.` } : null;
      return l.preview(dir, ask);
    },
    async status(dir) {
      const s = sessions.get(dir);
      let git: RepoState | null = null; try { git = await publish.status(dir); } catch {}
      return { name: (s && s.project && s.project.name) || path.basename(dir), open: !!s, suspended: !!(s && s.suspended), url: previewUrl(dir), git, dev: readDevJson(dir) };
    },
    async context(dir) {
      const s = sessions.get(dir);
      const docs: ContextDoc[] = [];
      try {
        for (const f of context.list(dir) || []) {
          const abs = context.absPath(dir, f.rel)!; // a listed file is inside .context
          if (/\.(md|mdx|txt)$/i.test(f.rel)) docs.push({ file: f.rel, local: !!f.local, content: fs.readFileSync(abs, 'utf8') });
          else docs.push({ file: f.rel, local: !!f.local, bytes: fs.statSync(abs).size });
        }
      } catch {}
      let refs: ProjectReference[] = []; try { refs = references.list(dir) || []; } catch {}
      let pages: PageEntry[] | null = null; try { pages = s ? project.listPages(dir, s.project) : null; } catch {}
      let openComments = 0; try { openComments = (comments.list(dir) || []).filter((c) => !c.resolved).length; } catch {}
      let toks: TokenSummary[] | null = null; try { const t = tokens.indexTokens(dir); toks = t.tokens.filter((x) => x.type === 'color' || x.type === 'font' || x.type === 'length').slice(0, 80).map((x) => ({ name: x.name, value: x.value, type: x.type, modes: x.modes })); } catch {}
      return { name: (s && s.project && s.project.name) || path.basename(dir), rules: projectMemory.readForAgent(dir), docs, references: refs, pages, url: previewUrl(dir), openComments, tokens: toks, storage: projectData.status(dir) };
    },
    async pages(dir) { const s = sessions.get(dir); return s ? project.discoverPages(dir, s.project) : { pages: [], framework: null, router: null, source: null, reason: 'not-open' }; },
    async comments(dir, { open }) { const list = comments.list(dir) || []; return (open ? list.filter((c) => !c.resolved) : list) as StoredCommentWithoutAttachments[]; /* bridge: see StoredCommentWithoutAttachments */ },
    shot: (dir, route, width) => { const pg = browserPage(); return pg ? pg.shot(dir, route, width) : Promise.resolve(noBrowser('shot', dir)); },
    async create({ name, template, dir, github: gh }, progress) {
      const parentDir = dir || recents.getProjectsDir() || path.join(platform().home, 'Radial');
      return createNewProject({ templateId: template, name, parentDir, github: gh ? { create: true, owner: '' } : null }, (line: string) => { progress(line); send('newProject:log', line); send('log', `[new-project] ${line}`); });
    },
    async sleep(dir) { if (!sessions.has(dir)) return { ok: false, code: 'not-open', error: `${dir} is not open.` }; await suspendSession(dir); return { state: 'asleep' }; },
    // `radial reload` / `radial restart`: the project menu's two actions for agents.
    async reload(dir) {
      if (!sessions.has(dir)) return { ok: false, code: 'not-open', error: `${dir} is not open.` };
      const pg = browserPage();
      if (!pg) return { headless: true }; // no window or browser shows the preview: nothing to reload
      const r: LooseUnion<CliResult<'reload'>> = await pg.reload(dir);
      if (r && r.ok) return {};
      if (r && r.reason === 'asleep') return { ok: false, code: 'no-dev-server', error: `${dir} is asleep; wake it first (radial wake).` };
      return { ok: false, code: (r && r.code) || 'error', error: (r && r.error) || 'Could not reload the preview.' };
    },
    async restart(dir) {
      if (!sessions.has(dir)) return { ok: false, code: 'not-open', error: `${dir} is not open.` };
      // bridge: restartDevServer is typed in the other range; once it answers DevRestartResult, annotate r with LooseUnion<DevRestartResult> (r.error is read) and drop the cast
      const r = await restartDevServer(dir, { via: 'cli' }) as LooseUnion<DevRestartResult>; // asleep → this is a fresh start, same as wake
      if (r.ok) return { url: r.url };
      if (r.reason === 'external') return { ok: false, code: 'error', error: 'The preview uses a dev server started outside Radial. Restart it from the terminal where you started it.' };
      return { ok: false, code: 'error', error: r.error || 'The restart failed.' };
    },
    wake,
    async close(dir) {
      const v = viewer();
      if (!v) { await closeWithoutWindow(dir); return { state: 'closed' }; }
      const r = await v.close(dir);
      if (r.ok) return { state: 'closed' };
      if (sessions.has(dir)) await stopSession(dir); // no window to do it: stop the session directly
      return { state: 'closed' };
    },
    async liveTerminals(dir) { try { return (await terminal.list(dir)).filter((t) => t.alive).length; } catch { return 0; } },

    // ── write lane: the panels' own deterministic engines, no agent involved ──
    fileExists: (f) => { try { return fs.existsSync(f); } catch { return false; } },
    async editText(dir, { find, to, route, file, path: fieldPath }) {
      const preferFile = file || pageFileFor(dir, route);
      const context: ElementContext = {}; if (preferFile) context.preferFile = preferFile; if (Array.isArray(fieldPath) && fieldPath.length) context.path = fieldPath; // the field's structural pin (from `radial fields`)
      const result = editEngine.applyTextEdit(dir, { originalText: find, newText: to, context });
      recordEdit(dir, result);
      if (result.ok) nudgePreview(dir);
      return result;
    },
    async editImage(dir, { src, file }) { const r = swapImageFile(dir, src, file); if (r.ok) nudgePreview(dir); return r; },
    async metaSet(dir, { tag, value, route, file }) {
      const f = META_FIELDS[tag];
      if (!f) return { ok: false, reason: 'invalid', message: `Unknown tag ${tag}.` };
      const preferFile = file || pageFileFor(dir, route);
      const result = editEngine.setHeadTagValue(dir, { preferFile: preferFile || undefined, locator: f.locator, attr: f.attr || null, value });
      recordEdit(dir, result);
      if (result.ok) nudgePreview(dir);
      return result;
    },
    async commentAdd(dir, { text, route, selector }) {
      const item: LooseUnion<StoredComment | CommentsRefusal> = comments.add(dir, { route: route || '/', selector: selector || '', text });
      if (!item || item.error) return { ok: false, reason: 'error', message: (item && item.error) || 'Could not save the comment.' };
      notifyCommentsChanged(dir);
      return { ok: true, comment: item as StoredCommentWithoutAttachments }; // a refusal's error is never empty; bridge: see StoredCommentWithoutAttachments
    },
    async commentResolve(dir, id) {
      const c: LooseUnion<StoredComment | CommentsRefusal> | null = comments.update(dir, id, { resolved: true, resolvedBy: '' });
      if (c && c.error) return { ok: false, reason: 'error', message: c.error };
      if (!c) return { ok: false, reason: 'not-found' };
      notifyCommentsChanged(dir);
      return { ok: true, comment: c as StoredCommentWithoutAttachments }; // a refusal's error is never empty; bridge: see StoredCommentWithoutAttachments
    },
    async commentsPull(dir) { return pullVercelComments(dir, { manual: true }); },
    sync: (dir, opts) => publish.sync(dir, opts as SyncRequestAsOptions),
    publishDestination: (dir, to) => publish.destination(dir, to),
    async publish(dir, { to, message, gate, scope, pr, commit }, progress) {
      const opts = { target: to, push: true, scope, pr, commit, message: message || `Radial edit (${to})` };
      const onEvent = (ev: DeployEvent) => {
        if (ev.kind === 'status' && ev.text) progress(ev.text);
        else if (ev.kind === 'gate') progress(`Build gate: ${ev.status}${ev.reason ? ` (${ev.reason})` : ''}`);
        else if (ev.kind === 'build_log' && ev.text) progress(String(ev.text).trimEnd());
      };
      return gate === false ? publishPlain(dir, opts) : publishDeploy(dir, opts, { onEvent });
    },
    async momentsList(dir) { const r: MomentListWithoutPreview & { previewing?: boolean } = moments.list(dir); try { r.previewing = await moments.isPreviewing(dir); } catch {} /* knowingly loose: previewing stays unset when isPreviewing throws, until CliApi.momentsList (cliServer.ts) makes it optional */ return r as MomentList; },
    async momentRecord(dir, label) { const r = await moments.record(dir, { kind: 'edit', label: label || 'Recorded from the command line' }); notifyMomentCreated(dir, r); return r; },
    async momentRestore(dir, id) { const r = await moments.restore(dir, id); notifyMomentCreated(dir, r); if (r.ok) nudgePreview(dir); return r; },

    fields: (dir, route) => { const pg = browserPage(); return pg ? pg.fields(dir, route) : Promise.resolve(noBrowser('fields', dir)); },
    async tokens(dir) { return tokens.indexTokens(dir); },
    async tokenSet(dir, { name, value, mode }) {
      const result = tokens.setToken(dir, { name, value, mode: mode || null });
      recordEdit(dir, result);
      if (result.ok) nudgePreview(dir);
      return result;
    },
    // What an agent learned goes back into the site: a .context doc, a reference, a rule.
    async contextAdd(dir, { name, text, file, replace }) {
      if (file) {
        const r = context.importFiles(dir, [file]);
        syncCtxIndex(dir); try { context.ensureCommitted(dir); } catch {}
        return r.imported && r.imported.length ? { ok: true, rel: r.imported[0], imported: true } : { ok: false, reason: 'error', message: `Could not import ${file}.` };
      }
      let rel = String(name || '').trim().replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/^\.+/, '').trim() || 'untitled';
      if (!path.extname(rel)) rel += '.md';
      const exists = (context.list(dir) || []).some((f) => f.rel === rel);
      if (exists && !replace) return { ok: false, reason: 'exists', message: `.context/${rel} already exists. Pass --replace to overwrite it.` };
      const w = context.write(dir, rel, text == null ? '' : String(text));
      if (!w.ok) return { ok: false, reason: 'error', message: w.error };
      syncCtxIndex(dir); try { context.ensureCommitted(dir); } catch {}
      return { ok: true, rel, replaced: exists };
    },
    async refAdd(dir, url) { try { const ref = references.add(dir, url); syncCtxIndex(dir); return { ok: true, ref }; } catch (e) { return { ok: false, reason: 'error', message: (e as Error).message || String(e) }; } },
    async refRemove(dir, url) { const ok = references.remove(dir, url); syncCtxIndex(dir); return ok ? { ok: true, url } : { ok: false, reason: 'not-found' }; },
    async ruleAdd(dir, text) { const r = projectMemory.addRule(dir, text); return r && r.ok ? { ok: true, file: 'AGENTS.md' } : { ok: false, reason: 'invalid', message: 'The rule is empty.' }; },
    async undo(dir) { const rec = doUndo(dir); if (!rec) return { ok: false, reason: 'nothing', message: 'Nothing to undo.' }; nudgePreview(dir); return { ok: true, relFile: rec.relFile }; },
    async redo(dir) { const rec = doRedo(dir); if (!rec) return { ok: false, reason: 'nothing', message: 'Nothing to redo.' }; nudgePreview(dir); return { ok: true, relFile: rec.relFile }; },
    agentSend: (id, opts) => { const v = viewer(); return v ? v.agentSend({ id, ...opts }) : sendToAgent({ id, ...opts }); },
    // A CLI's own question, read and answered the same way in both hosts (questions.ts): from the daemon's
    // scrollback, and keys through this process, never the window.
    agentQuestion: (id) => questions().question(id),
    agentAnswer: (id, ask) => questions().answer(id, ask),
    home: (opts) => { const v = viewer(); return v ? v.home(opts || {}) : startHome(opts || {}); },

    // ── agent lane: real sessions in the project's terminal. The window boots the
    // user's own CLI (askRenderer 'agent'); with no window (radial serve) the core
    // does (agentLane.ts). Completion is read from the bell it rings (daemon
    // lastBellAt) and its screen from the pty tail.
    agentStart: (dir, opts) => { const v = viewer(); return v ? v.agentStart({ repoDir: dir, ...opts }) : startAgent({ repoDir: dir, ...opts }); },
    // Site migration (plans/site-migration.md): the same functions back the Home wizard.
    migratePrepare: (opts, progress) => (migratePrepare as CliApi['migratePrepare'] /* bridge: typed in the other range; drop the cast at merge */)(opts, progress),
    migrateLaunch: (prep) => (migrateLaunch as CliApi['migrateLaunch'] /* bridge: typed in the other range; drop the cast at merge */)(prep),
    async migrateCapture(dir, url, progress = () => {}, { only = [] }: { only?: string[] } = {}) {
      try {
        const pg = browserPage(); // no browser: the capture takes no reference screenshots, and says so
        const { dir: capDir, inventory: inv }: SiteCapture = await migrate.captureSite(dir, url, { shoot: pg ? pg.shoot : undefined, only, onProgress: progress });
        if (!fs.existsSync(path.join(projectData.contextDir(dir), 'migration.md'))) writeMigrationRecord(dir, migrate.intentRecord({ url: inv.source.url, platform: inv.platform.name, framework: migrate.frameworkOf(dir), captureRef: migrate.captureRef(dir, capDir), inventory: inv }));
        return { ok: true, capture: capDir, readme: path.join(capDir, 'README.md'), source: inv.source.url, platform: inv.platform.name, scope: inv.scope, pages: inv.counts.pages, assets: inv.counts.assets, screens: inv.screens.filter((x) => x.file).length, ...(pg ? {} : { screensSkipped: 'no-browser' as const }), playbook: path.join(migrationPlaybook(), 'SKILL.md') };
      } catch (e) { return { ok: false, code: /reach|web address|answered/.test((e as Error).message) ? 'not-found' : /must be on/.test((e as Error).message) ? 'bad-request' : 'error', error: (e as Error).message }; }
    },
    async migrateCompare(dir, { routes, widths }, progress = () => {}) {
      const pg = browserPage();
      if (!pg) return noBrowser('compare', dir);
      const url = previewUrl(dir);
      if (!url) return { ok: false, code: 'no-dev-server', error: 'The preview is not running yet. Wait for it, or run `radial restart`.' };
      try {
        const { dir: out, report }: SiteComparison = await migrate.compareSite(dir, url, { shoot: pg.shoot, decode: pg.decode, encode: pg.encode, routes, widths: widths && widths.length ? widths : migrate.WIDTHS, onProgress: progress });
        return { ok: true, dir: out, report: path.join(out, 'report.md'), rows: report.rows };
      } catch (e) { return { ok: false, code: /No capture/.test((e as Error).message) ? 'not-found' : 'error', error: (e as Error).message }; }
    },
    agentOutput, agentWait, agentList, agentKill, agentKeep, // the agent lane: src/core/agents.ts
  };
}
