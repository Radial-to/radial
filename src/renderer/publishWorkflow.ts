/* global window, document */
'use strict';
window.RadialPublish = (() => {
  /** The last receipt's pull request, its capabilities read without narrowing (a failed check has no merge methods). */
  type PullStatus = Exclude<PublishSurface['prStatus'], PullRequestDetail> | LoosePullRequestDetail;
  const drafts = new Map<string, PublishDraft>(), surfaces = new Map<HTMLElement, PublishSurface>(), jobs = new Map<string, PublishJob>();
  let receiptId = 0;
  const api = () => window.radial;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, className?: string): HTMLElementTagNameMap[K] => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
  const button = (text: string, action: (event: MouseEvent) => unknown, cls = 'pm-link'): HTMLButtonElement => { const n = node('button', text, cls); n.type = 'button'; n.onclick = action; return n; };
  const row = (...items: (Node | string)[]): HTMLDivElement => { const n = node('div', null, 'pm-detail-row'); n.append(...items); return n; };
  function draft(dir: string): PublishDraft {
    if (!drafts.has(dir)) {
      // localStorage holds what update() saved; a missing key parses as null.
      let saved: Partial<Pick<PublishDraft, 'target' | 'scope' | 'message'>> | null | undefined; try { saved = JSON.parse(localStorage.getItem('radial.publish:' + dir) as string) as Partial<Pick<PublishDraft, 'target' | 'scope' | 'message'>> | null; } catch {}
      drafts.set(dir, { target: 'staging', scope: 'all', message: '', ...saved });
    }
    return drafts.get(dir)!;
  }
  const job = (dir: string): PublishJob => { if (!jobs.has(dir)) jobs.set(dir, { busy: false, log: '' }); return jobs.get(dir)!; };
  function update(dir: string, patch: Partial<PublishDraft>): PublishDraft {
    const value = Object.assign(draft(dir), patch);
    try { localStorage.setItem('radial.publish:' + dir, JSON.stringify({ target: value.target, scope: value.scope, message: value.message })); } catch {}
    for (const s of surfaces.values()) if (s.context.repoDir === dir) {
      if (patch.target) { s.error = ''; selectPlan(s); warmPlans(s); }
      paint(s);
    }
    return value;
  }
  // The filter drops the missing receipts, so the sort only sees real ones.
  function receiptFor(dir: string, state?: LooseUnion<CollaborationState> | null): LooseUnion<PublishSurfaceReceipt> | undefined { return [draft(dir).receipt, state?.receipt].filter(r => r && (!r.remote || r.remote === state?.remote)).sort((a, b) => (b!.at || 0) - (a!.at || 0))[0] as LooseUnion<PublishSurfaceReceipt> | undefined; }
  const destination = (s: PublishSurface, target: PublishTarget = draft(s.context.repoDir).target): string | null | undefined => target === 'production' ? s.config?.config?.productionBranch || 'main' : target === 'staging' ? s.config?.effectiveStaging || s.config?.config?.stagingBranch || 'staging' : s.state?.branch;
  const elapsed = (at: number): string => { const min = Math.max(0, Math.floor((Date.now() - at) / 60000)); return min < 1 ? 'Just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.floor(min / 60)} hr ago` : `${Math.floor(min / 1440)} d ago`; };
  const effect = (plan: { deployment: LooseUnion<import('../shared/radialApi').DeploymentDestination>; hosting?: LooseUnion<import('../shared/radialApi').HostingInfo> | null }): import('../shared/radialApi').DeploymentEffect => ({ state: plan.deployment.state, production: !!plan.deployment.production, projectId: plan.hosting?.projectId || null, orgId: plan.hosting?.orgId || null });
  const hasConflicts = (state: LooseUnion<CollaborationState> | null | undefined): boolean => !!(state?.operationRecord || state?.operation || state?.conflicts?.length);
  const keyFor = (s: PublishSurface, target: PublishTarget = draft(s.context.repoDir).target): string => JSON.stringify([target, destination(s, target), s.config?.remote, s.config?.config, s.state?.head, s.state?.branch, s.state?.changes, s.state?.operation, s.state?.operationRecord]);
  function paintAll(dir: string): void { for (const s of surfaces.values()) if (s.context.repoDir === dir) paint(s); }
  function invalidate(dir: string): void { for (const s of surfaces.values()) if (s.context.repoDir === dir) { s.plan = null; s.relation = null; s.plans.clear(); s.pendingPlans.clear(); s.revision++; } }
  function selectPlan(s: PublishSurface): void {
    const entry = s.plans.get(draft(s.context.repoDir).target);
    const fresh = entry?.key === keyFor(s) && Date.now() - entry.at < 30000;
    s.plan = fresh ? entry.plan : null;
    s.relation = s.plan?.relation || null;
  }
  function requestPlan(s: PublishSurface, target: PublishTarget): void {
    const key = keyFor(s, target), version = s.revision, dir = s.context.repoDir;
    const cached = s.plans.get(target), pending = s.pendingPlans.get(target);
    if (cached?.key === key && Date.now() - cached.at < 30000) return;
    if (pending?.key === key && pending.version === version) return;
    const request: Parameters<PublishSurface['pendingPlans']['set']>[1] = { key, version };
    s.pendingPlans.set(target, request);
    const valid = () => surfaces.get(s.host) === s && s.host.isConnected && s.revision === version && keyFor(s, target) === key;
    request.promise = (async () => {
      try {
        const plan = await api().collaborationPlan(dir, { target });
        if (!valid()) return;
        if (!plan.ok) throw Error(plan.message || 'Couldn’t check the publish destination.');
        // The plan's fresher checkout over the last state read, which keeps its receipt and integration.
        // The cast claims more than holds: RepoStatus's ok: true lands on whatever the last state was,
        // which can be a failure (no-remote, detached, fetch-failed) whose reason stays, a mix no
        // CollaborationState member describes. Nothing here narrows the state on ok or reason.
        s.state = { ...s.state, ...plan.local } as LooseUnion<CollaborationState>;
        const checkedKey = keyFor(s, target);
        s.plans.set(target, { key: checkedKey, plan, at: Date.now() });
        selectPlan(s); paint(s);
        if (checkedKey !== key) warmPlans(s);
      } catch (error) {
        if (valid() && draft(dir).target === target) { s.error = (error as Error).message; paint(s); }
      } finally { if (s.pendingPlans.get(target) === request) s.pendingPlans.delete(target); }
    })();
  }
  function warmPlans(s: PublishSurface): void {
    if (!s.config || !s.state?.isRepo || job(s.context.repoDir).busy) return;
    for (const target of new Set<PublishTarget>([draft(s.context.repoDir).target, 'staging', 'production'])) requestPlan(s, target);
  }
  function setBusy(s: PublishSurface, value: boolean): void { const work = job(s.context.repoDir); work.busy = value; if (value) { work.kind = 'settings'; work.progress = ''; } paintAll(s.context.repoDir); }
  function closeTask(s: PublishSurface): void {
    if (job(s.context.repoDir).busy) return;
    s.task = null; s.ui.task.hidden = true; s.host.classList.remove('pm-wide', 'pm-editing', 'pm-roomy'); paint(s); refreshSurface(s);
  }
  function showTask(s: PublishSurface, page: PublishPage, extra: Pick<CollaborationContext, 'number'> = {}): void {
    if (job(s.context.repoDir).busy || window.RadialCollaboration.isBusy()) return;
    window.RadialCollaboration.close();
    s.task = page; s.ui.task.replaceChildren(); s.ui.task.hidden = false;
    s.host.classList.toggle('pm-wide', !['settings', 'repository', 'hosting'].includes(page));
    s.host.classList.add('pm-editing');
    if (['settings', 'repository', 'hosting'].includes(page)) {
      s.ui.details.open = page === 'repository';
      window.RadialPublishSettings.mount(s.ui.task, { repoDir: s.context.repoDir, page: page as PublishSettingsOptions['page'],
        done: () => closeTask(s), busy: value => setBusy(s, value), setup: s.context.setupHosting,
        changed: async result => {
          invalidate(s.context.repoDir); s.error = ''; job(s.context.repoDir).error = '';
          for (const other of surfaces.values()) if (other.context.repoDir === s.context.repoDir && result.remote !== undefined) {
            // Lacks isRepo and effectiveStaging when the panel hadn't read its config yet; paint falls back without them.
            other.config = { ...other.config, remote: result.remote, config: result.config || other.config?.config } as import('../shared/radialApi').ConfigInfo;
            // Only { remote, slug } when the panel hadn't read its state yet, and on a not-a-repo state it sets
            // fields that member lacks, so the cast claims more than holds. The readers here only read fields:
            // a missing isRepo holds the panel back until refresh() reads the state again.
            other.state = { ...other.state, remote: result.remote, slug: null } as LooseUnion<CollaborationState>;
          }
          await s.context.settingsChanged?.(result); refresh();
        },
      });
    } else {
      window.RadialCollaboration.open({ ...s.context, ...extra,
        settings: () => showTask(s, 'settings'), onClose: () => closeTask(s), onBusy: value => setBusy(s, value),
      }, page, s.ui.task);
    }
    paint(s);
  }
  function paint(s: PublishSurface): void {
    const { ui, state, config, plan }: Omit<PublishSurface, 'plan'> & { plan?: LoosePlan | null } = s, dir = s.context.repoDir, value = draft(dir), work = job(dir);
    const remote = !!config?.remote, target = destination(s), relation = s.relation || plan?.relation;
    // behind is null or undefined without a remote branch to compare; that compares as not behind.
    const conflict = hasConflicts(state), behind = relation?.behind! > 0;
    const receipt = receiptFor(dir, state), deployment = value.receipt?.sha === receipt?.sha ? value.deployment : null;
    const currentReceipt = receipt && receipt.target === value.target && (receipt.sha === state?.head || receipt.mode === 'merge' && receipt.sourceHead === state?.head) && !state?.changes?.length;
    const pr: PullStatus = currentReceipt && receipt.mode !== 'merge' && receipt.prNumber && s.prKey === `${receipt.remote}:${receipt.prNumber}` ? s.prStatus : null;
    const mergeable = pr?.ok && pr.pr.state === 'open' && !pr.pr.draft && pr.pr.mergeable && ['clean', 'has_hooks'].includes(pr.pr.mergeState) && !pr.capabilities?.mergeQueue && pr.capabilities?.mergeMethods?.length;
    // An open pull request (its receipt has the prUrl) isn't published; a merge's receipt has no prUrl.
    const live = currentReceipt && !receipt.prUrl && (receipt.mode === 'vercel' || deployment?.state === 'ready');
    ui.status.textContent = work.busy ? work.kind === 'integration' ? 'Updating checkout' : work.kind === 'publish' ? 'Publishing' : 'Saving' : work.error ? 'Publish needs attention' : live ? 'Published' : receipt?.prUrl ? 'PR opened' : receipt?.pushed ? 'Pushed' : 'Publish';
    ui.time.textContent = receipt?.at ? elapsed(receipt.at) : ''; ui.time.hidden = !receipt?.at || work.busy;
    ui.files.textContent = Array.isArray(state?.changes) ? `${state.changes.length} changed ${state.changes.length === 1 ? 'file' : 'files'}` : 'Reading changes…';
    ui.files.disabled = work.busy;
    for (const input of ui.targets.querySelectorAll('input')) { input.checked = input.value === value.target; input.disabled = work.busy || !!s.task; }
    ui.targets.querySelector('[data-branch=staging]')!.textContent = !config ? 'Checking destination…' : remote ? 'origin/' + (config.effectiveStaging || config.config.stagingBranch) : 'Direct Vercel preview';
    ui.targets.querySelector('[data-branch=production]')!.textContent = !config ? 'Checking destination…' : remote ? 'origin/' + config.config.productionBranch : 'Direct Vercel production';
    for (const code of ui.targets.querySelectorAll('code')) code.title = code.textContent;
    ui.current.hidden = value.target !== 'branch'; ui.current.textContent = `Destination · ${target || 'Current branch'}`;
    ui.connection.textContent = remote ? state?.slug ? 'GitHub connected' : 'Git remote connected' : config ? 'Local project' : 'Checking connection…';
    ui.repo.textContent = state?.slug || config?.remote || dir.split('/').pop()!; ui.repo.title = config?.remote || dir;
    ui.branch.textContent = state?.branch || 'Detached'; ui.branch.title = ui.branch.textContent;
    ui.remoteRows.hidden = !remote;
    ui.outgoing.textContent = relation?.ok ? relation.exists ? `${relation.ahead} unpushed ${relation.ahead === 1 ? 'commit' : 'commits'}` : 'Branch has not been pushed' : 'Comparison unavailable';
    ui.remoteStatus.textContent = relation?.ok ? relation.exists ? `${relation.behind || 'No'} incoming ${relation.behind === 1 ? 'commit' : 'commits'}` : 'Remote branch does not exist' : 'Incoming state unavailable';
    ui.remoteStatus.title = `Compared with origin/${target}. Fetch refreshes remote refs without changing local files.`;
    // fetching is undefined until the first fetch, which disabled reads as false.
    ui.fetch.disabled = !remote || work.busy || s.fetching!; ui.fetch.textContent = s.fetching ? 'Fetching…' : 'Fetch';
    ui.github.hidden = ui.pulls.hidden = !remote || !state?.slug;
    // Hidden unless the state has a slug.
    ui.github.onclick = () => api().openExternal(`https://github.com/${state!.slug}`);
    for (const site of ui.sites.children as HTMLCollectionOf<HTMLButtonElement>) { const url = config?.config?.[(site.dataset.site + 'Url') as 'stagingUrl' | 'productionUrl'] || s.links?.urls?.[site.dataset.site as 'staging' | 'production']; site.hidden = !url; site.onclick = () => { if (/^https?:\/\//.test(url || '')) api().openExternal(url!); }; }
    ui.sites.hidden = ![...ui.sites.children as HTMLCollectionOf<HTMLButtonElement>].some(n => !n.hidden);
    ui.error.hidden = !(s.error || work.error); ui.error.textContent = s.error || work.error || '';
    ui.retry.hidden = !ui.error.textContent || work.busy;
    ui.incoming.hidden = !conflict && !behind;
    ui.incoming.textContent = conflict ? 'Resolve conflicts before publishing' : `${relation?.behind} incoming ${relation?.behind === 1 ? 'commit' : 'commits'}`;
    ui.incoming.onclick = () => showTask(s, conflict ? 'conflicts' : 'incoming');
    ui.integrationNote.hidden = !behind || conflict;
    ui.integrationNote.textContent = 'Your local changes will be saved and reapplied. Updating the checkout does not publish.';
    ui.prFields.hidden = !plan?.pr || behind || conflict || !!s.task || work.busy || !!(currentReceipt && receipt.prNumber);
    if (document.activeElement !== ui.prTitle) ui.prTitle.value = value.message;
    ui.prBranch.textContent = state?.branch !== target ? `${state?.branch} → ${target}` : `Contribution branch → ${target}`;
    ui.prNote.textContent = plan?.deployment?.production ? 'Pushes a branch for review. Merging the PR can deploy production.' : 'Pushes a branch for review. The destination branch is unchanged until merge.';
    // Before the state is read the count is undefined, which compares as nothing to commit.
    const commits = value.scope !== 'none' && (value.scope === 'staged' ? state?.staged : state?.changes?.length)! > 0;
    ui.deploymentNote.hidden = !remote || !plan;
    ui.deploymentNote.textContent = plan ? plan.pr ? `${ui.prNote.textContent} ${plan.deployment.label}` : `${commits ? value.scope === 'staged' ? 'Commits staged changes and pushes' : 'Commits changes and pushes' : 'Pushes existing commits'} to ${target}. ${plan.deployment.label}` : '';
    ui.progress.hidden = !work.busy && (s.receiptOpen || (!currentReceipt && !work.error));
    ui.progress.textContent = work.busy ? work.progress || 'Working…' : currentReceipt ? receipt.prNumber && receipt.mode !== 'merge' ? `Pull request #${receipt.prNumber} · production has not been published by this action.` : receipt.mode === 'vercel' ? 'Local files deployed.' : `${receipt.pushed ? 'Pushed' : 'Saved'} ${receipt.sha.slice(0, 8)}${deployment ? ' · deployment ' + (({ unobserved: 'not yet reported', unknown: 'status unavailable' } as Partial<Record<string, string>>)[deployment.state] || deployment.state) : ''}` : work.error ? 'Publish needs attention.' : '';
    const result = work.result && (!work.result.remote || work.result.remote === state?.remote) ? work.result : work.error ? null : receipt;
    const log = result?.deploy?.log || (!work.result || result === work.result ? work.log : '');
    const hasReceipt = !!(result || log || work.error);
    ui.logs.hidden = !s.receiptOpen || !!s.task || work.busy || !hasReceipt;
    ui.history.disabled = !!s.task || work.busy || !hasReceipt;
    ui.receiptChevron.hidden = !hasReceipt || work.busy;
    ui.history.setAttribute('aria-expanded', String(!ui.logs.hidden));
    ui.history.setAttribute('aria-label', ui.logs.hidden ? 'View publish details' : 'Hide publish details');
    ui.history.title = ui.logs.hidden ? 'View publish details' : 'Hide publish details';
    ui.receiptSummary.textContent = result?.mode === 'vercel' ? 'Deployed local files' : result?.sha ? `${result.mode === 'merge' ? 'Merged' : result.pushed ? 'Pushed' : 'Saved locally'} ${result.sha.slice(0, 8)}${result.branch ? ' · ' + result.branch : ''}` : 'Publish did not complete';
    ui.receiptMessage.textContent = result?.message || work.error || '';
    ui.receiptMessage.hidden = !ui.receiptMessage.textContent;
    ui.receiptBuild.hidden = !result?.deploy?.gate;
    ui.receiptBuild.textContent = result?.deploy?.gate ? `Build check: ${result.deploy.gate}${result.deploy.reason ? ' · ' + result.deploy.reason : ''}` : '';
    const resultDeployment = result?.sha === receipt?.sha ? deployment : null;
    ui.receiptDeployment.hidden = !result?.pushed || !!result?.prNumber && result.mode !== 'merge';
    // Without a deployment the lookup is of undefined, which falls through to the state or the default.
    ui.receiptDeployment.textContent = `Deployment: ${({ unobserved: 'not yet reported', unknown: 'status unavailable' } as Partial<Record<string, string>>)[resultDeployment?.state!] || resultDeployment?.state || 'not yet reported'}`;
    ui.receiptOutput.hidden = !log; ui.receiptLog.textContent = log;
    ui.receiptAgent.hidden = !result?.fixPrompt || !s.context.sendAgent;
    // Hidden unless the result has a fix prompt.
    ui.receiptAgent.onclick = () => s.context.sendAgent?.(result!.fixPrompt!);
    const resultUrl = result?.prUrl || (result?.mode === 'vercel' ? result.url : resultDeployment?.url);
    ui.receiptLink.hidden = !/^https:\/\//.test(resultUrl || '');
    ui.receiptLink.textContent = result?.prUrl ? 'Open pull request on GitHub' : 'Open deployment';
    // Hidden unless the URL is https.
    ui.receiptLink.onclick = () => api().openExternal(resultUrl!);
    ui.liveLog.hidden = !work.busy || !work.log; ui.liveLogText.textContent = work.log;
    ui.prReview.hidden = !(currentReceipt && receipt.prNumber && receipt.mode !== 'merge');
    ui.prReview.textContent = `Review pull request #${receipt?.prNumber || ''}`;
    // Hidden unless the receipt is current.
    ui.prReview.onclick = () => showTask(s, 'pull', { number: receipt!.prNumber });
    ui.prStatus.hidden = ui.prReview.hidden;
    ui.prStatus.textContent = !pr?.ok ? 'Checking PR approvals and checks…' : pr.pr.merged ? 'Pull request merged. Check deployments for its status.' : `Checks: ${pr.checksKnown ? [...pr.checks, ...pr.statuses].filter(c => ['success', 'neutral', 'skipped'].includes(c.state)).length + ' passed' : 'unavailable'} · ${pr.pr.mergeState === 'blocked' ? 'Waiting for required reviews or checks' : pr.pr.mergeState === 'dirty' ? 'Conflicts need attention' : mergeable ? 'Ready to merge' : pr.pr.state}`;
    ui.mergeField.hidden = !mergeable;
    // mergeable means the pull request has merge methods.
    if (mergeable && ui.mergeMethod.dataset.methods !== pr.capabilities.mergeMethods!.join(',')) {
      ui.mergeMethod.replaceChildren(...pr.capabilities.mergeMethods!.map(value => { const option = node('option', value === 'merge' ? 'Merge commit' : value === 'squash' ? 'Squash merge' : 'Rebase merge'); option.value = value; return option; }));
      ui.mergeMethod.dataset.methods = pr.capabilities.mergeMethods!.join(',');
    }
    if (s.task) { ui.progress.hidden = true; ui.hint.hidden = true; } else ui.hint.hidden = false;
    ui.action.hidden = !!s.task; ui.settings.hidden = !!s.task;
    ui.action.disabled = work.busy || !state?.isRepo || (!plan && remote) || !!s.error;
    ui.settings.disabled = ui.edit.disabled = work.busy;
    if (work.busy) { ui.action.textContent = work.kind === 'integration' ? 'Updating…' : 'Publishing…'; ui.hint.textContent = ''; return; }
    if (!config) { ui.action.textContent = 'Checking destination…'; ui.hint.textContent = ''; }
    else if (conflict) { ui.action.textContent = 'Resolve conflicts'; ui.action.disabled = false; ui.hint.textContent = 'Resolve the integration before publishing.'; }
    else if (plan?.mismatch) { ui.action.textContent = 'Fix publish settings'; ui.hint.textContent = `Vercel reports ${plan.hosting.productionBranch} as production. Check the destination.`; }
    // behind means the relation is there.
    else if (behind && !plan?.pr) { ui.action.textContent = `${relation!.ahead ? 'Merge updates' : 'Update'} from ${target}`; ui.hint.textContent = ''; }
    else if (live) { ui.action.textContent = 'Open ' + (value.target === 'production' ? 'production' : 'deployment'); ui.action.disabled = false; ui.hint.textContent = 'Deployment ready · ' + receipt.sha.slice(0, 8); }
    else if (currentReceipt && receipt.prNumber && receipt.mode !== 'merge') { ui.action.textContent = mergeable ? plan?.deployment?.production ? 'Merge and deploy production' : 'Merge pull request' : 'Review pull request'; ui.hint.textContent = mergeable ? plan?.deployment?.label || 'Deployment behavior is not verified.' : 'Approvals and merge status are available here.'; }
    else if (!remote) { ui.action.textContent = value.target === 'branch' ? 'Commit local changes' : 'Deploy local files'; ui.hint.textContent = value.target === 'branch' ? 'Saves a local commit without pushing.' : 'Commit and upload local files to Vercel. GitHub is optional.'; }
    else if (!plan) { ui.action.textContent = value.target === 'branch' ? `Push to ${target}` : `Publish to ${value.target}`; ui.hint.textContent = 'Checking GitHub and deployment settings.'; }
    else {
      ui.action.textContent = plan.pr ? 'Open pull request' : plan.deployment.state === 'configured' ? 'Publish to ' + (plan.deployment.production ? 'production' : 'staging') : `${commits ? 'Commit and push' : 'Push'} to ${target}`;
      ui.hint.textContent = plan.pr ? ui.prNote.textContent : `Pushes to ${target} · ${plan.deployment.state === 'configured' ? 'deploys ' + (plan.deployment.production ? 'production' : 'staging') : plan.deployment.state === 'disabled' ? 'automatic deployments off' : 'deployment unverified'}`;
      if (plan.pr && plan.capabilities?.canPush === false) { ui.action.disabled = true; ui.hint.textContent = 'The connected GitHub account cannot push a contribution branch.'; }
    }
  }
  async function fetchUpdates(s: PublishSurface): Promise<void> {
    if (job(s.context.repoDir).busy || s.fetching) return;
    const target = destination(s), remote = s.config?.remote; s.fetching = true; s.error = ''; paint(s);
    try {
      // Main reads a null target (a detached checkout) as none (repository.ts syncStatus). The cast covers
      // CollaborationStateOptions.target (radialApi.ts), which doesn't list the null this can send.
      const result = await api().collaborationState(s.context.repoDir, { target: target as string | undefined, fetch: true });
      if (!result.ok) throw Error('Couldn’t fetch updates. Try again.');
      if (target === destination(s) && remote === s.config?.remote) s.relation = result;
    } catch (error) { s.error = (error as Error).message; }
    finally { s.fetching = false; invalidate(s.context.repoDir); paint(s); refreshSurface(s); }
  }
  async function refreshSurface(s: PublishSurface): Promise<void> {
    if (!s.host.isConnected || job(s.context.repoDir).busy || s.loading) return;
    s.loading = true; const version = s.revision, dir = s.context.repoDir;
    const valid = () => surfaces.get(s.host) === s && s.revision === version;
    try {
      const [config, state, links] = await Promise.all([api().configGet(dir), api().collaborationState(dir), api().publishLinkState(dir)]);
      if (!valid()) return;
      s.config = config; s.state = state; s.links = links;
      selectPlan(s);
      paint(s);
      warmPlans(s);
      const receipt = receiptFor(dir, state);
      if (receipt?.prNumber && receipt.mode !== 'merge' && (s.prKey !== `${receipt.remote}:${receipt.prNumber}` || !s.prStatus || Date.now() - (s.prAt || 0) > 30000)) {
        s.prAt = Date.now();
        const status = await api().collaborationReview(dir, 'detail', { number: receipt.prNumber });
        if (valid()) { s.prStatus = status; s.prKey = `${receipt.remote}:${receipt.prNumber}`; }
      }
      if (receipt?.pushed && Date.now() - (s.deploymentAt || 0) > 15000) {
        s.deploymentAt = Date.now();
        const deployment = await api().collaborationDeployment(dir, receipt);
        if (valid() && receiptFor(dir, s.state)?.sha === receipt.sha) update(dir, { receipt, deployment });
      }
    } catch (error) { if (valid()) s.error = 'Couldn’t check publishing: ' + (error as Error).message; }
    finally { s.loading = false; if (surfaces.get(s.host) === s) { paint(s); if (!valid()) refreshSurface(s); } }
  }
  function refresh(): void { for (const [host, s] of surfaces) { if (!host.isConnected) surfaces.delete(host); else refreshSurface(s); } }
  async function execute(s: PublishSurface): Promise<void> {
    const dir = s.context.repoDir, work = job(dir), plan: LoosePlan | null | undefined = s.plan, value = { ...draft(dir) }, relation = s.relation || plan?.relation;
    if (work.busy || s.task) return;
    if (hasConflicts(s.state)) return showTask(s, 'conflicts');
    if (plan?.mismatch) return showTask(s, 'settings');
    const receipt = receiptFor(dir, s.state), current = (receipt?.sha === s.state?.head || receipt?.mode === 'merge' && receipt.sourceHead === s.state?.head) && receipt?.target === value.target && !s.state?.changes?.length;
    if (current && receipt.prNumber && receipt.mode !== 'merge') {
      const pr: PullStatus = s.prKey === `${receipt.remote}:${receipt.prNumber}` ? s.prStatus : null;
      if (pr?.ok && pr.pr.state === 'open' && !pr.pr.draft && pr.pr.mergeable && ['clean', 'has_hooks'].includes(pr.pr.mergeState) && !pr.capabilities?.mergeQueue && pr.capabilities?.mergeMethods?.includes(s.ui.mergeMethod.value as MergeMethod)) return merge(s, pr);
      return showTask(s, 'pull', { number: receipt.prNumber });
    }
    if (current && (receipt.mode === 'vercel' || value.deployment?.state === 'ready') && (!receipt.prNumber || receipt.mode === 'merge')) { const url = receipt.mode === 'vercel' ? receipt.url : value.deployment!.url; if (/^https?:\/\//.test(url || '')) api().openExternal(url!); return; }
    if (!s.config?.remote) return showTask(s, value.target === 'branch' ? 'commit' : 'local-deploy');
    if (!plan || s.error) return;
    // As in paint: a missing behind compares as not behind, and integrating means the relation is there.
    const integrating = relation?.behind! > 0 && !plan.pr;
    Object.assign(work, { busy: true, kind: integrating ? 'integration' : 'publish', error: '', result: null, log: '', progress: integrating ? 'Saving local work and updating the checkout…' : 'Committing and checking the production build…' }); paintAll(dir);
    let result: LooseUnion<import('../shared/radialApi').IntegrationResult | import('../shared/radialApi').PublishDeployResult> | undefined;
    try {
      result = integrating ? await api().syncRun(dir, { target: plan.branch, strategy: relation!.ahead ? 'merge' : undefined }) : await api().publishDeploy(dir, {
        target: plan.target, branch: plan.branch, pr: plan.pr, push: true, commit: value.scope !== 'none', scope: value.scope === 'none' ? 'all' : value.scope, message: value.message,
        expectedHead: plan.local.head, expectedFingerprint: plan.fingerprint, expectedRemote: plan.local.remote, expectedPr: plan.pr, expectedDeployment: effect(plan),
      });
      work.result = result;
      // A failure with a sha spreads the whole receipt it had written (publish.ts), so it reads as one.
      // When git throws (pr-required, integration-required, git-error), PublishResult gives every receipt
      // field as optional, since the receipt may not be written yet: a sha shows it was, as the cast says.
      if (result.sha) s.context.onResult?.(result as LooseUnion<PublishSurfaceReceipt>);
      if (!result.ok) work.error = result.message || 'The action could not be completed.';
      else { work.progress = ''; await s.context.onChanged?.(); }
    } catch (error) { work.error = (error as Error).message; }
    finally {
      work.busy = false; invalidate(dir); paintAll(dir); refresh();
      if ((['conflict', 'integration-paused', 'operation-in-progress'] as (string | undefined)[]).includes(result?.reason)) showTask(s, 'conflicts');
    }
  }
  async function merge(s: PublishSurface, status: PullRequestDetail): Promise<void> {
    const dir = s.context.repoDir, work = job(dir), plan = s.plan;
    if (!plan) return;
    const { pr } = status;
    Object.assign(work, { busy: true, kind: 'publish', error: '', progress: 'Merging the reviewed pull request…' }); paintAll(dir);
    try {
      const result = await api().collaborationReview(dir, 'merge', { number: pr.number, sha: pr.sha, baseSha: pr.baseSha, method: s.ui.mergeMethod.value as MergeMethod, branch: pr.base, expectedRemote: plan.local.remote, expectedDeployment: effect(plan) });
      if (!result.ok) { work.error = result.error; return; }
      const receipt = { ...result, target: draft(dir).target, sourceHead: s.state!.head };
      work.result = receipt; s.context.onResult?.(receipt); s.prStatus = null;
      await s.context.onChanged?.();
    } catch (error) { work.error = (error as Error).message; }
    finally { work.busy = false; invalidate(dir); refresh(); paintAll(dir); }
  }
  function mount(host: HTMLElement, context: CollaborationContext): void {
    const previous = surfaces.get(host);
    if (previous?.context.repoDir === context.repoDir && host.contains(previous.ui.targets)) { previous.context = context; paint(previous); refreshSurface(previous); return; }
    // mount fills in every control below, before anything reads them.
    const s: PublishSurface = { host, context, revision: 0, plans: new Map(), pendingPlans: new Map(), ui: {} as PublishSurfaceUi }, ui = s.ui;
    const open = (page: PublishPage): void => showTask(s, page);
    host.classList.add('pm-expand-github'); host.classList.remove('pm-wide', 'pm-editing', 'pm-roomy');
    const head = node('div', null, 'pane-head'), layout = node('div', null, 'pm-layout'), content = node('div', null, 'pm-workflow');
    ui.task = node('div', null, 'pm-task'); ui.task.hidden = true;
    ui.history = button('', () => { s.receiptOpen = !s.receiptOpen; paint(s); }, 'pm-history'); ui.status = node('span', 'Publish'); ui.time = node('span', '', 'pm-time'); ui.receiptChevron = node('span', '', 'pm-receipt-chevron'); ui.receiptChevron.setAttribute('aria-hidden', 'true'); ui.history.append(ui.status, ui.time, ui.receiptChevron);
    ui.files = button('Reading changes…', () => open('changes'), 'pm-change-count'); head.append(ui.history, ui.files);
    ui.targets = node('fieldset', null, 'pm-destinations'); ui.targets.append(node('legend', 'Publish to'));
    for (const [value, title] of [['staging', 'Staging'], ['production', 'Production']] as const) {
      const label = node('label', null, 'pm-target'), check = node('input'), main = node('span', null, 'pm-target-main'), code = node('code'); code.dataset.branch = value;
      check.type = 'checkbox'; check.value = value; check.setAttribute('aria-label', title);
      check.onchange = () => update(context.repoDir, { target: value });
      main.append(node('span', title), code); label.append(check, main); ui.targets.append(label);
    }
    ui.current = node('p', '', 'pm-note');
    ui.details = node('details', null, 'pm-github-details'); const disclosure = node('summary', null, 'pm-disclosure');
    ui.connection = node('span', 'Checking connection…'); disclosure.append(ui.connection, node('span', 'See more +', 'pm-see-more'), node('span', 'See less −', 'pm-see-less'));
    const info = node('div', null, 'pm-github-info'), repository = node('div', null, 'pm-repo-detail');
    ui.repo = node('p', '', 'pm-repository'); ui.edit = button('Edit', () => open('repository')); repository.append(row(node('span', 'Repository', 'pm-detail-label'), ui.edit), ui.repo);
    ui.branch = node('code', '', 'pm-checkout-branch'); ui.outgoing = node('span', '', 'pm-commit-count'); ui.remoteStatus = node('span', '', 'pm-remote-status');
    ui.fetch = button('Fetch', () => fetchUpdates(s), 'pm-control'); ui.github = button('Open GitHub', () => {}); ui.pulls = button('Pull requests', () => open('pulls'));
    ui.remoteRows = node('div', null, 'pm-remote-rows'); ui.remoteRows.append(row(ui.outgoing, button('Review', () => open('review'))), row(ui.remoteStatus, ui.fetch), row(ui.github, ui.pulls));
    ui.sites = node('div', null, 'pm-sites'); for (const kind of ['staging', 'production']) { const site = button(kind === 'staging' ? 'Staging site' : 'Production site', () => {}); site.dataset.site = kind; ui.sites.append(site); }
    ui.deploymentNote = node('p', '', 'pm-note pm-effect');
    info.append(repository, row(node('span', 'Local branch', 'pm-detail-label'), ui.branch), ui.remoteRows, ui.sites, ui.deploymentNote); ui.details.append(disclosure, info);
    ui.error = node('p', '', 'pm-fetch-error'); ui.error.setAttribute('role', 'status');
    ui.retry = button('Refresh checks', () => { s.error = ''; job(context.repoDir).error = ''; invalidate(context.repoDir); refresh(); });
    ui.incoming = button('', () => {}, 'pm-incoming-alert'); ui.integrationNote = node('p', '', 'pm-note');
    ui.prFields = node('div', null, 'pm-pr-fields'); ui.prTitle = node('input'); ui.prTitle.placeholder = 'Update the site'; ui.prTitle.setAttribute('aria-label', 'Pull request title'); ui.prTitle.oninput = () => update(context.repoDir, { message: ui.prTitle.value });
    ui.prBranch = node('code'); ui.prNote = node('p', '', 'pm-note'); const label = node('label', null, 'pm-field'); label.append(node('span', 'Pull request title'), ui.prTitle); ui.prFields.append(node('strong', 'A pull request is required'), label, ui.prBranch, ui.prNote);
    ui.hint = node('p', '', 'pm-note pm-effect'); ui.progress = node('p', '', 'pm-note pm-progress'); ui.progress.setAttribute('role', 'status');
    ui.prReview = button('Review pull request', () => {});
    ui.prStatus = node('p', '', 'pm-note'); ui.mergeMethod = node('select'); ui.mergeMethod.setAttribute('aria-label', 'Merge method'); ui.mergeField = node('label', null, 'pm-field'); ui.mergeField.append(node('span', 'Merge method'), ui.mergeMethod);
    ui.liveLog = node('details', null, 'pm-live-log'); ui.liveLogText = node('pre'); ui.liveLog.append(node('summary', 'Build output'), ui.liveLogText);
    ui.logs = node('div', null, 'pm-publish-details'); ui.logs.id = 'publish-receipt-' + ++receiptId;
    ui.history.setAttribute('aria-controls', ui.logs.id);
    const receiptBody = node('div', null, 'pm-receipt');
    ui.receiptSummary = node('p', '', 'pm-note'); ui.receiptMessage = node('p', '', 'pm-note');
    ui.receiptBuild = node('p', '', 'pm-note'); ui.receiptDeployment = node('p', '', 'pm-note');
    ui.receiptOutput = node('details', null, 'pm-live-log'); ui.receiptLog = node('pre');
    ui.receiptOutput.append(node('summary', 'Build output'), ui.receiptLog);
    ui.receiptAgent = button('Ask your terminal agent to fix this', () => {});
    ui.receiptLink = button('Open deployment', () => {});
    receiptBody.append(ui.receiptSummary, ui.receiptMessage, ui.receiptBuild, ui.receiptDeployment, ui.receiptOutput, ui.receiptLink, ui.receiptAgent);
    ui.logs.append(receiptBody);
    ui.action = button('Checking destination…', () => execute(s), 'pm-action primary pm-publish'); if (host.id === 'publishMenu') ui.action.id = 'pmPublish';
    ui.settings = button('Publish settings', () => open('settings'), 'pm-settings');
    content.append(ui.targets, ui.current, ui.details, ui.error, ui.retry, ui.incoming, ui.integrationNote, ui.prFields, ui.progress, ui.liveLog, ui.prReview, ui.prStatus, ui.mergeField, ui.hint, ui.action, ui.settings);
    layout.append(content, ui.task); host.replaceChildren(head, ui.logs, layout); surfaces.set(host, s); paint(s); refreshSurface(s);
  }
  api().onPublishEvent?.(event => { const work = job(event.repoDir); if (!work.busy || work.kind !== 'publish') return; if (event.kind === 'build_log') work.log = (work.log + event.text).slice(-50000); else if (event.kind === 'status') work.progress = event.text; else if (event.kind === 'gate') work.progress = event.status === 'failed' ? 'Build failed. Nothing was pushed.' : 'Build checked. Pushing the saved commit…'; paintAll(event.repoDir); });
  setInterval(() => { for (const [host, s] of surfaces) { if (!host.isConnected) surfaces.delete(host); else if (host.getClientRects().length && !document.hidden) refreshSurface(s); } }, 5000);
  return { draft, update, mount, refresh, receiptFor, open: (host, page) => { const s = surfaces.get(host); if (s) showTask(s, page); } };
})();
