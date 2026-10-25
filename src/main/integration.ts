import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as repo from './repository';
import type { AbortResult, ConflictFile, ConflictResolution, ConflictsResult, FinalizeResult, IncomingPreview, IntegrationDone, IntegrationPaused, IntegrationRecord, IntegrationResult, RepoState, RepoStateFailure, ResolveResult, SyncOptions } from '../shared/radialApi';
const git = repo.run;

/**
 * resolve(): one file resolved, or why not. radialApi's ResolveResult also
 * covers finalize(), which publish.resolveSync runs after resolving every file;
 * this picks the per-file members out of it by their own fields.
 */
export type ResolveFileResult = RepoStateFailure | Extract<ResolveResult, { ok: true; file: string } | { reason: 'not-conflicted' | 'conflict-changed' | 'resolution-failed' }>;
/**
 * switchTo(): stash, check out, replay. A replay that stopped is still a switch
 * (`stashed`), with popConflict true when it stopped on conflicts;
 * publish.stashAndSwitch turns that one into the window's ok: true
 * (radialApi's BranchSwitchResult). Only the stashed pauses have popConflict,
 * so it reads on the union.
 */
export type StashSwitchResult =
  | { ok: false; reason: 'operation-in-progress'; message?: string; popConflict?: undefined }
  | { ok: false; reason: 'switch-failed'; message: string; popConflict?: undefined }
  | (IntegrationPaused & { popConflict?: undefined })
  | (IntegrationDone & { stashed: true; popConflict?: undefined })
  | (IntegrationPaused & { stashed: true; popConflict: false })
  | (IntegrationPaused & { stashed: true; popConflict: true });

async function read(dir: string): Promise<IntegrationRecord | null> {
  const file = await repo.gitPath(dir, 'radial-integration.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as IntegrationRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function save(dir: string, record: IntegrationRecord | null): Promise<void> {
  const file = await repo.gitPath(dir, 'radial-integration.json');
  if (!record) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file + '.tmp', JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

async function snapshot(dir: string, ref: string): Promise<string> {
  const index = path.join(os.tmpdir(), 'radial-recovery-' + crypto.randomUUID());
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', 'HEAD'], { env });
    await git(dir, ['add', '-A'], { env });
    const tree = await git(dir, ['write-tree'], { env });
    const sha = await git(dir, ['-c', 'user.name=Local recovery', '-c', 'user.email=recovery@localhost', 'commit-tree', tree, '-p', 'HEAD', '-m', 'Before integration recovery'], { env });
    await git(dir, ['update-ref', ref, sha]);
    return sha;
  } finally { fs.rmSync(index, { force: true }); }
}

async function preview(dir: string, sha: string): Promise<IncomingPreview> {
  const log = await git(dir, ['log', '-30', '--format=%h%x1f%s%x1f%an', `HEAD..${sha}`]);
  const fields = (await git(dir, ['diff', '--name-status', '-z', '--no-renames', `HEAD...${sha}`], { raw: true })).split('\0');
  const changed: IncomingPreview['changed'] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changed.push({ status: fields[i], file: fields[i + 1] });
  return { incoming: log.split('\n').filter(Boolean).map(line => { const [hash, subject, author] = line.split('\x1f'); return { hash, subject, author }; }), changed };
}

async function result(dir: string, record: IntegrationRecord, extra: Partial<Pick<IntegrationPaused, 'reason' | 'message'>> = {}): Promise<IntegrationPaused> {
  // A failed state() has no conflict list: the pause then reads as integration-paused with no files.
  const state: RepoState & { conflicts?: string[] } = await repo.state(dir);
  return { ok: false, reason: state.conflicts?.length ? 'conflict' : 'integration-paused', branch: record.branch, pulled: record.behind,
    files: state.conflicts || [], localFiles: record.localFiles, ...record.preview, operation: record, ...extra };
}

async function replay(dir: string, record: IntegrationRecord): Promise<IntegrationPaused | IntegrationDone> {
  record.phase = 'replay';
  record.integratedHead = await git(dir, ['rev-parse', 'HEAD']);
  await save(dir, record);
  if (record.stash) {
    try { await git(dir, ['stash', 'apply', '--index', record.stash]); }
    catch (error) {
      const state = await repo.state(dir);
      // --index can refuse before restoring any working files. A plain replay
      // then exposes the conflict; the original index remains in the saved stash.
      if (state.ok && !state.changes.length) {
        try { await git(dir, ['stash', 'apply', record.stash]); }
        catch (replayError) { return result(dir, record, { message: (replayError as Error).message }); }
      } else return result(dir, record, { message: (error as Error).message });
    }
  }
  await save(dir, null);
  return { ok: true, branch: record.branch, pulled: record.behind, keptLocal: !!record.stash, localFiles: record.localFiles, recoveryRef: record.recoveryRef, ...record.preview };
}

async function start(dir: string, { strategy, target }: SyncOptions = {}): Promise<IntegrationResult> {
  try {
    const local = await repo.state(dir);
    if (!local.ok) return local;
    const pending = await read(dir);
    if (pending) return result(dir, pending);
    const state = await repo.syncStatus(dir, { target });
    if (!state.ok) return state;
    if (state.operation || state.conflicts.length) return { ok: false, reason: 'operation-in-progress', message: 'Finish or abort the current Git operation first.' };
    if (!state.exists) return { ok: false, reason: 'no-upstream', message: 'This branch has not been pushed yet.' };
    if (!state.behind) return { ok: true, upToDate: true, branch: state.branch };
    if (state.ahead && !(['merge', 'rebase'] as (string | undefined)[]).includes(strategy)) return { ok: false, reason: 'diverged', ahead: state.ahead, behind: state.behind, branch: state.branch };
    const ignored = (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { raw: true })).split('\0').filter(Boolean);
    const targetPaths = new Set((await git(dir, ['ls-tree', '-r', '--name-only', '-z', state.sha], { raw: true })).split('\0'));
    if (ignored.some(file => [...targetPaths].some(target => target === file || target.startsWith(file + '/') || file.startsWith(target + '/')))) return { ok: false, reason: 'ignored-collision', message: 'An ignored local file would be replaced by incoming tracked content. Move or back it up before integrating.' };
    if (strategy === 'rebase') {
      const outgoing = (await git(dir, ['rev-list', `${state.sha}..HEAD`])).split('\n').filter(Boolean);
      for (const sha of outgoing) {
        const published = await git(dir, ['for-each-ref', '--format=%(refname)', `--contains=${sha}`, 'refs/remotes/']);
        if (published) return { ok: false, reason: 'published-history', message: 'Some of these commits are already on a remote branch. Merge to preserve their history.' };
      }
    }
    const id = crypto.randomUUID();
    // The `!`s: syncStatus answers ok only with a branch and a HEAD, and a
    // checkout that is ahead got here only with strategy merge or rebase.
    const record: IntegrationRecord = { id, branch: state.branch!, startHead: state.head!, integratedHead: state.head!, target: state.sha, strategy: state.ahead ? strategy! : 'ff', behind: state.behind,
      phase: 'prepared', localFiles: state.changes.map(c => c.file), preview: await preview(dir, state.sha), recoveryRef: `refs/radial/recovery/${id}`, stash: null };
    await git(dir, ['update-ref', record.recoveryRef + '/head', state.head!]);
    await save(dir, record);
    if ((await git(dir, ['rev-parse', 'HEAD'])) !== state.head) return result(dir, record, { reason: 'checkout-changed' });
    if (state.changes.length) {
      record.stashBefore = await git(dir, ['rev-parse', '--verify', 'refs/stash']).catch(() => null);
      record.phase = 'stashing';
      await save(dir, record);
      await git(dir, ['stash', 'push', '-u', '-m', `Radial integration ${id}`]);
      record.stash = await git(dir, ['rev-parse', 'refs/stash']);
      if (record.stash === record.stashBefore) throw new Error('The checkout changed before local work could be saved.');
      await git(dir, ['update-ref', record.recoveryRef + '/work', record.stash]);
      await save(dir, record);
    }
    record.phase = 'integrating';
    await save(dir, record);
    try {
      // A merge commit and rebased commits need a committer: with no git identity (a fresh VM or container) git refuses to guess one.
      const identity = await repo.missingIdentityArgs(dir);
      await git(dir, [...identity, ...(record.strategy === 'rebase' ? ['rebase', state.sha] : ['merge', '--no-overwrite-ignore', record.strategy === 'ff' ? '--ff-only' : '--no-edit', state.sha])]);
    } catch (error) { return result(dir, record, { message: (error as Error).message }); }
    return replay(dir, record);
  } catch (error) { return { ok: false, reason: 'integration-failed', message: (error as Error).message }; }
}

async function conflicts(dir: string): Promise<ConflictsResult> {
  const record = await read(dir);
  const state = await repo.state(dir);
  if (!state.ok) return state;
  const files: ConflictFile[] = [];
  for (const file of state.conflicts) {
    const versions = await Promise.all([1, 2, 3].map(stage => git(dir, ['show', `:${stage}:${file}`], { raw: true }).catch(() => null)));
    const [base, ours, theirs] = versions;
    const reversed = record?.phase === 'replay' || record?.strategy === 'rebase' || state.operation === 'rebase';
    const abs = path.join(dir, file);
    const stat = fs.existsSync(abs) ? fs.lstatSync(abs) : null;
    const working = stat?.isFile() && stat.size <= 1024 * 1024 ? fs.readFileSync(abs, 'utf8') : null;
    // A missing stat's or version's undefined size compares false on purpose.
    const binary = !!(stat && !stat.isFile()) || ((stat?.size as number) > 1024 * 1024) || [working, ...versions].some(v => v?.includes('\0') || (v?.length as number) > 1024 * 1024);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([versions, working])).digest('hex');
    files.push({ file, binary, reversed, fingerprint, working: binary ? null : working, base: binary ? null : base, mine: binary ? null : reversed ? theirs : ours, incoming: binary ? null : reversed ? ours : theirs });
  }
  return { ok: true, operation: record, externalOperation: state.operation, files };
}

async function resolve(dir: string, { file, strategy, text, deleted = false, expectedFingerprint }: ConflictResolution): Promise<ResolveFileResult> {
  const state = await repo.state(dir);
  if (!state.ok) return state;
  if (!state.conflicts.includes(file)) return { ok: false, reason: 'not-conflicted', message: 'Refresh the conflicts before resolving this file.' };
  if (expectedFingerprint) {
    // A failed snapshot has no files, so it reads as a changed conflict.
    const snapshot: ConflictsResult & { files?: ConflictFile[] } = await conflicts(dir);
    if (snapshot.files?.find(item => item.file === file)?.fingerprint !== expectedFingerprint) return { ok: false, reason: 'conflict-changed', message: 'This conflict was edited by another tool. Refresh and review its current contents before saving.' };
  }
  const record = await read(dir);
  const reversed = record?.phase === 'replay' || record?.strategy === 'rebase' || state.operation === 'rebase';
  try {
    if (strategy === 'mine' || strategy === 'theirs') {
      const stage = (strategy === 'mine') !== reversed ? 2 : 3;
      const exists = await git(dir, ['ls-files', '--unmerged', '-z', '--', file], { raw: true });
      if (!exists.split('\0').some(line => line.split('\t')[0].endsWith(` ${stage}`))) deleted = true;
      else await git(dir, ['checkout', stage === 2 ? '--ours' : '--theirs', '--', file]);
    } else if (strategy === 'manual') {
      if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('The resolution is too large for this editor.');
      if (/^(<{7}|>{7}|\|{7})/m.test(text)) throw new Error('Remove the remaining conflict markers before saving.');
      const abs = path.resolve(dir, file);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid file path.');
      if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error('Resolve this symbolic link in your Git tool.');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    } else throw new Error('Choose a resolution.');
    if (deleted) await git(dir, ['rm', '-f', '--', file]);
    else await git(dir, ['add', '--', file]);
    return { ok: true, file };
  } catch (error) { return { ok: false, reason: 'resolution-failed', message: (error as Error).message }; }
}

async function finalize(dir: string): Promise<FinalizeResult> {
  try {
    const record = await read(dir);
    if (!record) return { ok: false, reason: 'no-operation', message: 'No Radial integration is pending. Complete the operation in your Git tool.' };
    const state = await repo.state(dir);
    if (!state.ok) return state;
    if (state.branch !== record.branch && state.operation !== 'rebase') throw new Error('The checkout changed. Return to the integration branch first.');
    for (const file of state.conflicts) {
      const abs = path.resolve(dir, file);
      if (!fs.existsSync(abs)) throw new Error(`Resolve the deletion of ${file} explicitly.`);
      const data = fs.readFileSync(abs);
      if (data.includes(0) || /^(<{7}|>{7}|\|{7})/m.test(data.toString('utf8'))) throw new Error(`Review the remaining conflict in ${file}.`);
      await git(dir, ['add', '--', file]);
    }
    if (record.phase === 'integrating') {
      const identity = await repo.missingIdentityArgs(dir); // the merge commit, or the rest of the rebase (see start)
      if (state.operation === 'merge') await git(dir, [...identity, 'commit', '--no-edit']);
      else if (state.operation === 'rebase') {
        try { await git(dir, [...identity, 'rebase', '--continue'], { env: { GIT_EDITOR: 'true' } }); }
        catch (error) { return result(dir, record, { message: (error as Error).message }); }
      } else if (state.head === record.startHead) throw new Error('Integration did not complete. Abort and retry.');
      return replay(dir, record);
    }
    if (record.phase !== 'replay') throw new Error('Integration was interrupted before replay. Abort to recover the saved work.');
    await save(dir, null);
    return { ok: true, recoveryRef: record.recoveryRef };
  } catch (error) { return { ok: false, reason: 'unresolved', message: (error as Error).message }; }
}

async function abort(dir: string): Promise<AbortResult> {
  try {
    const record = await read(dir);
    if (!record) return { ok: false, reason: 'no-operation' };
    const state = await repo.state(dir);
    if (!state.ok) return state;
    if (state.branch !== record.branch && state.operation !== 'rebase') throw new Error('The checkout changed. Return to the integration branch before aborting.');
    if (!state.operation && !([record.startHead, record.integratedHead] as (string | null)[]).includes(state.head)) throw new Error('New commits were made after integration. Recover the saved work without resetting those commits.');
    await snapshot(dir, record.recoveryRef + '/before-abort');
    if (state.operation === 'merge') await git(dir, ['merge', '--abort']);
    else if (state.operation === 'rebase') await git(dir, ['rebase', '--abort']);
    if (record.phase === 'stashing' && !record.stash) {
      const stash = await git(dir, ['rev-parse', '--verify', 'refs/stash']).catch(() => null);
      const subject = stash && await git(dir, ['log', '-1', '--format=%s', stash]);
      if (stash !== record.stashBefore && subject?.includes(record.id)) record.stash = stash;
      else throw new Error('Interrupted while saving local work. Inspect the recovery refs and stash before continuing.');
    }
    if (record.phase !== 'prepared') {
      if (record.strategy === 'switch') {
        const original = await git(dir, ['rev-parse', `refs/heads/${record.startBranch}`]);
        if (original !== record.startHead) throw new Error('The original branch has new commits. Inspect recovery before restoring its files.');
        await git(dir, ['reset', '--hard', record.integratedHead]);
        // switchTo() writes every switch record with its startBranch.
        await git(dir, ['switch', record.startBranch!]);
      } else await git(dir, ['reset', '--hard', record.startHead]);
      if (record.stash) await git(dir, ['stash', 'apply', '--index', record.stash]);
    }
    await save(dir, null);
    return { ok: true, recoveryRef: record.recoveryRef, message: 'Integration aborted. The pre-abort files and original work remain in recovery refs.' };
  } catch (error) { return { ok: false, reason: 'abort-failed', message: (error as Error).message }; }
}

async function switchTo(dir: string, name: string): Promise<StashSwitchResult> {
  try {
    if (await read(dir)) return { ok: false, reason: 'operation-in-progress', message: 'Finish the current integration first.' };
    await git(dir, ['check-ref-format', '--branch', name]);
    const local = await repo.state(dir);
    if (!local.ok || !local.branch || local.operation || local.conflicts.length) return { ok: false, reason: 'operation-in-progress' };
    const target = await git(dir, ['rev-parse', '--verify', `refs/heads/${name}`]);
    const id = crypto.randomUUID();
    // The `!`s: an unborn branch has no HEAD, and update-ref then fails into switch-failed anyway.
    const record: IntegrationRecord = { id, strategy: 'switch', startBranch: local.branch, branch: local.branch, startHead: local.head!, integratedHead: local.head!, target,
      phase: 'prepared', localFiles: local.changes.map(c => c.file), preview: {}, behind: 0, recoveryRef: `refs/radial/recovery/${id}`, stash: null };
    await git(dir, ['update-ref', record.recoveryRef + '/head', local.head!]);
    await save(dir, record);
    record.stashBefore = await git(dir, ['rev-parse', '--verify', 'refs/stash']).catch(() => null);
    record.phase = 'stashing'; await save(dir, record);
    await git(dir, ['stash', 'push', '-u', '-m', `Radial integration ${id}`]);
    record.stash = await git(dir, ['rev-parse', 'refs/stash']);
    if (record.stash === record.stashBefore) throw new Error('No new stash was created. Refresh the checkout before switching.');
    await git(dir, ['update-ref', record.recoveryRef + '/work', record.stash]);
    await save(dir, record);
    try { await git(dir, ['checkout', '--no-overwrite-ignore', name]); }
    catch (error) { return result(dir, record, { message: (error as Error).message }); }
    record.branch = name;
    const res = await replay(dir, record);
    return res.ok ? { ...res, stashed: true } : { ...res, branch: name, stashed: true, popConflict: res.reason === 'conflict' };
  } catch (error) { return { ok: false, reason: 'switch-failed', message: (error as Error).message }; }
}

export { read, start, conflicts, resolve, finalize, abort, preview, snapshot, switchTo };
