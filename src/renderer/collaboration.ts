/* global window, document */
'use strict';

window.RadialCollaboration = (() => {
  const api = () => window.radial;
  /**
   * A destination check with its parts read without narrowing (a field one
   * state lacks reads as undefined), or why it couldn't be made.
   */
  type PlanResult = LooseUnion<LoosePlan | Exclude<import('../shared/radialApi').CollaborationPlanResult, CollaborationPlan>>;
  /** A pull request's detail, its capabilities read without narrowing (a failed check has no merge methods), or why it couldn't be read. */
  type PullResult = LoosePullRequestDetail | import('../shared/radialApi').ReviewFailure;
  /**
   * The answer of an action act() runs, read without narrowing (a field
   * another answer has reads as undefined): a commit or publish, a local
   * deploy, a new branch, an integration step, a review or merge.
   */
  type ActResult = LooseUnion<
    | import('../shared/radialApi').PublishResult
    | import('../shared/radialApi').PublishDeployResult
    | LocalDeployReceipt
    | (Extract<import('../shared/radialApi').VercelDeployResult, { ok: false }> & { message: string })
    | Awaited<ReturnType<RadialApi['collaborationBranch']>>
    | import('../shared/radialApi').IntegrationResult
    | import('../shared/radialApi').ResolveResult
    | import('../shared/radialApi').AbortResult
    | import('../shared/radialApi').ReviewResults['review' | 'merge']
    | { ok: false; error: string }
  >;
  // body, feedback and context are set by open(), before anything reads them.
  let dialog: HTMLElement | null | undefined, body: HTMLDivElement, feedback: HTMLParagraphElement, context: CollaborationContext, closeHandler: (() => void) | null | undefined, revision = 0, timer: TimerId | undefined, busy = false, pendingPublish: PublishActionOverrides | null = null;
  const draft = (): PublishDraft => window.RadialPublish.draft(context.repoDir);
  const saveDraft = (patch: Partial<PublishDraft>): PublishDraft => window.RadialPublish.update(context.repoDir, patch);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const note = (text: string): HTMLParagraphElement => el('p', text, 'collab-note');
  function button(label: string, action: (node: HTMLButtonElement) => unknown, primary = false): HTMLButtonElement {
    const node = el('button', label, primary ? 'btn btn-primary' : 'btn');
    node.type = 'button';
    node.onclick = async () => {
      if (busy) return;
      try { await action(node); } catch (error) { message((error as Error).message, true); }
    };
    return node;
  }
  function field(label: string, control: HTMLElement): HTMLLabelElement {
    const wrap = el('label', undefined, 'collab-field');
    control.setAttribute('aria-label', label);
    wrap.append(el('span', label), control);
    return wrap;
  }
  function link(label: string, url: string | null | undefined): HTMLAnchorElement | HTMLParagraphElement {
    if (!/^https:\/\//.test(url || '')) return note(label + ': unavailable');
    const node = el('a', label);
    // An https URL from here on.
    node.href = url!;
    node.onclick = event => { event.preventDefault(); api().openExternal(url!); };
    return node;
  }
  function message(text: string | null | undefined, error = false): void {
    feedback.textContent = text || '';
    feedback.classList.toggle('collab-error', error);
  }
  // Busy, or the action threw: nothing comes back (a bare return, or the end of the function).
  // void rather than undefined: noImplicitReturns refuses a falling-off end unless the type is void.
  async function act<R extends ActResult>(node: HTMLButtonElement, fn: () => Promise<R>, done?: (result: Extract<R, { ok: true }>) => unknown): Promise<R | void> {
    if (busy) return;
    busy = true; context.onBusy?.(true);
    node.disabled = true;
    message('Working…');
    try {
      const result = await fn();
      // A failure with a sha spreads the whole receipt it had written (publish.ts), so it reads as one.
      // When git throws (pr-required, integration-required, git-error), PublishResult gives every
      // receipt field as optional, since the receipt may not be written yet: a sha shows it was, as
      // the cast says.
      if (result?.sha) context.onResult?.(result as LooseUnion<PublishSurfaceReceipt>);
      if (!result?.ok) {
        message(result?.message || result?.error || 'The action could not be completed.', true);
        if ((['conflict', 'integration-paused', 'operation-in-progress'] as (string | undefined)[]).includes(result?.reason)) await conflicts();
        if (result?.reason === 'integration-required') body.append(button('Review incoming changes', () => incoming(result.branch)));
        if (result?.reason === 'pr-required') body.append(button('Open a pull request instead', () => preparePublish({ target: result.target || 'production', branch: result.branch, pr: true, commit: false })));
        if (result?.fixPrompt && context.sendAgent) body.append(button('Ask your terminal agent to fix this', () => { context.sendAgent!(result.fixPrompt!); message('Review the agent’s changes before publishing again.'); }));
        if (result?.reason === 'build-failed' && result.sha) {
          body.append(note('The host may have environment settings unavailable locally. You can submit the saved commit without the local build check; GitHub still enforces required checks.'));
          body.append(button(`Push ${result.sha.slice(0, 8)} without the local build check`, button => act(button, () => api().publish(context.repoDir, { target: result.target, branch: result.base || result.branch, pr: result.mode === 'pr', commit: false, push: true, expectedHead: result.sha, expectedRemote: result.remote }), async receipt => { reset('Git operation complete'); await showReceipt(receipt, revision); })));
        }
      } else {
        message('Done.');

        await context.onChanged?.();
        if (done) await done(result as Extract<R, { ok: true }>);
      }
      return result;
    } catch (error) { message((error as Error).message, true); }
    finally { busy = false; context.onBusy?.(false); node.disabled = false; }
  }
  function reset(title: string): number {
    revision++;
    clearTimeout(timer);
    window.RadialDiffs.clear(body);
    body.replaceChildren(el('h3', title));
    message('');
    return revision;
  }
  function close(): boolean {
    if (busy) return false;
    clearTimeout(timer); revision++;
    if (dialog) { window.RadialDiffs.clear(dialog); dialog.remove(); dialog = null; }
    const callback = closeHandler; closeHandler = null; callback?.();
    return true;
  }
  function open(options: CollaborationContext, page: PublishPage = 'changes', host?: HTMLElement): boolean {
    if (!close()) return false;
    context = options; pendingPublish = null;
    const trigger = document.activeElement as HTMLElement | null;
    dialog = el(host ? 'section' : 'dialog', undefined, host ? 'collab-dialog collab-embedded' : 'collab-dialog');
    dialog.setAttribute('aria-label', 'Publish details');
    const head = el('header', undefined, 'collab-head');
    head.append(el('h2', 'Publish'), button(host ? 'Back to publish' : 'Close', close));
    const nav = el('nav', undefined, 'collab-nav'); nav.setAttribute('aria-label', 'Publish');
    nav.append(button('Changes', changes), button('Pull requests', pulls), button('Deployments', deployments), button('Publish settings', () => { const settings = context.settings; close(); settings?.(); }));
    body = el('div', undefined, 'collab-body');
    feedback = el('p', '', 'collab-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    dialog.append(head, nav, body, feedback);
    closeHandler = () => { options.onClose?.(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
    if (host) host.append(dialog);
    else { document.body.append(dialog); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); (dialog as HTMLDialogElement).showModal(); }
    head.querySelector('button')!.focus({ preventScroll: true });
    const run = page === 'review' ? () => preparePublish() : page === 'commit' ? () => preparePublish({ commitOnly: true })
      : page === 'local-deploy' ? localDeploy : page === 'incoming' ? () => { pendingPublish = {}; return incoming(); }
      // A 'pull' page is opened with its number: publishWorkflow showTask passes the receipt's prNumber.
      // (RadialPublish.open could ask for 'pull' without one, but no caller does.)
      : page === 'pull' ? () => pull(options.number!) : page === 'pulls' ? pulls : page === 'conflicts' ? conflicts : page === 'deployments' ? deployments : changes;
    const opened = dialog;
    Promise.resolve().then((): Promise<void> | void => { if (dialog === opened) return run(); }).catch((error: unknown) => { if (dialog === opened) message((error as Error).message, true); });
    return true;
  }

  async function changes(): Promise<void> {
    if (busy) return;
    const version = reset('Local changes');
    message('Reading the checkout…');
    const state: LooseUnion<CollaborationState> = await api().collaborationState(context.repoDir);
    if (version !== revision) return;
    if (!state.isRepo || !Array.isArray(state.changes)) { message(state.message || 'This folder is not a Git repository.', true); return; }
    message('');
    const branch = state.detached ? `Detached at ${state.head?.slice(0, 8)}` : state.branch || 'No commits yet';
    body.append(note(`${branch} · ${state.staged} staged · ${state.unstaged} unstaged · ${state.untracked} untracked`));
    if (state.operationRecord || state.conflicts?.length || state.operation) body.append(button('Review integration', conflicts));
    const actions = el('div', undefined, 'collab-actions');
    actions.append(button('Create branch', () => branchForm(state)), button('Commit…', () => preparePublish({ commitOnly: true })));
    if (state.remote) actions.append(button('Incoming changes', () => { pendingPublish = {}; return incoming(); }), button('Review and push…', () => preparePublish(), true));
    body.append(actions);
    if (!state.changes.length) body.append(note('Your working files match the current commit.'));
    const list = el('div', undefined, 'collab-file-list');
    const diff = el('div', 'Select a file to inspect its changes.', 'collab-note');
    diff.tabIndex = 0;
    let selection = 0;
    for (const change of state.changes) {
      const row = el('div', undefined, 'collab-file-row');
      row.append(el('code', `${change.status} ${change.originalFile ? change.originalFile + ' → ' : ''}${change.file}`));
      for (const staged of [false, true]) {
        if (staged && (change.untracked || change.index === ' ')) continue;
        if (!staged && !change.untracked && change.worktree === ' ') continue;
        row.append(button(staged ? 'Staged diff' : 'Working diff', async () => {
          const selected = ++selection;
          const result: LooseUnion<import('../shared/radialApi').FileDiff> = await api().collaborationDiff(context.repoDir, change.file, staged);
          if (version !== revision || selected !== selection) return;
          window.RadialDiffs.clear(diff);
          // A failure has an error or a message, a binary file its text.
          if (!result.ok || result.binary) { diff.textContent = (result.error || result.message || result.text)!; return; }
          await window.RadialDiffs.render(diff, result.addedFile ? { kind: 'files', oldFile: null, newFile: result.addedFile } : { kind: 'patch', patch: result.text, name: change.file, previousName: change.originalFile });
        }));
      }
      list.append(row);
    }
    body.append(list, diff);
    if (state.remote) await destinationField(version);
  }

  function branchForm(state: LooseUnion<CollaborationState>): void {
    reset('Create a branch');
    body.append(note('Your current files stay in this checkout. Uncommitted changes move with you to the new branch.'));
    const name = el('input'); name.placeholder = 'update-homepage'; name.autocomplete = 'off';
    const form = el('form');
    const submit = button('Create and switch', () => {} , true); submit.type = 'submit';
    form.append(field('Branch name', name), submit);
    form.onsubmit = e => { e.preventDefault(); act(submit, () => api().collaborationBranch(context.repoDir, { name: name.value.trim(), expectedHead: state.head }), () => { busy = false; return changes(); }); };
    body.append(form); name.focus();
  }

  async function incoming(target?: string | null): Promise<void> {
    if (busy) return;
    const entered = revision;
    if (typeof target !== 'string') {
      const config = await api().configGet(context.repoDir);
      if (entered !== revision) return;
      target = draft().target === 'production' ? config.config.productionBranch : draft().target === 'staging' ? config.effectiveStaging || config.config.stagingBranch : undefined;
    }
    const version = reset('Incoming changes');
    message('Fetching GitHub updates…');
    const state: LooseUnion<CollaborationState> = await api().collaborationState(context.repoDir, { fetch: true, target });
    if (version !== revision) return;
    if (state.operationRecord || state.conflicts?.length) return conflicts();
    // A state without a reason looks up undefined, which falls through to the default.
    if (!state.ok || !state.exists) { message(state.message || ({ 'no-remote': 'No remote is connected.', 'no-upstream': 'This branch has not been pushed yet.', detached: 'Switch to a branch to compare incoming changes.' } as Partial<Record<string, string>>)[state.reason!] || 'Remote state is unavailable.', true); return; }
    // A fetch stamps fetchedAt.
    message(`Fetched ${new Date(state.fetchedAt!).toLocaleTimeString()}.`);
    body.append(note(`${state.branch} compared with ${state.remoteName}/${state.targetBranch}: ${state.ahead} outgoing commits · ${state.behind} incoming commits.`));
    const logs = state.incoming?.incoming || [];
    if (version !== revision) return;
    const list = el('ul');
    for (const commit of logs) list.append(el('li', `${commit.hash} · ${commit.subject} — ${commit.author}`));
    body.append(list);
    for (const change of state.incoming?.changed || []) body.append(note(`${change.status} ${change.file}`));
    if (!state.behind) { body.append(note('There are no incoming commits to integrate.'), button('Continue to review push', () => preparePublish(pendingPublish || {}), true)); return; }
    body.append(note(state.changes.length ? 'Your local files and staged changes will be saved and replayed after integration. Recovery copies are retained.' : 'The checkout will update to include these commits.'));
    const run = (strategy: 'merge' | 'rebase' | undefined) => (node: HTMLButtonElement) => act(node, () => api().syncRun(context.repoDir, { strategy, target }), () => { busy = false; return pendingPublish ? preparePublish(pendingPublish) : changes(); });
    body.append(button(state.ahead ? 'Merge incoming commits' : 'Update with fast-forward', run(state.ahead ? 'merge' : undefined), true));
    if (state.ahead) body.append(button('Rebase unpublished commits', run('rebase')));
  }

  async function conflicts(): Promise<void> {
    const version = reset('Resolve integration');
    const result = await api().collaborationConflicts(context.repoDir);
    if (version !== revision) return;
    if (!result.ok) { message(result.message, true); return; }
    body.append(note('Choose text for each conflict or edit the result. Save only after reviewing it; publishing is a separate action.'));
    for (const file of result.files) {
      const section = el('section', undefined, 'collab-conflict');
      section.append(el('h4', file.file));
      const versions = el('div', undefined, 'collab-versions');
      for (const [label, value] of [['Common base', file.base], ['Your version', file.mine], ['Incoming version', file.incoming]] as const) {
        const details = el('details'), content = el('div');
        details.append(el('summary', label), content); versions.append(details);
        if (file.binary || value === null) content.append(note(file.binary ? 'Binary or large file: inspect in your editor.' : '(file absent)'));
        else details.addEventListener('toggle', () => { if (details.open && !content.dataset.started) { content.dataset.started = 'true'; window.RadialDiffs.render(content, { kind: 'file', file: { name: file.file, contents: value } }); } });
      }
      section.append(versions);
      if (!file.binary) {
        const editor = el('textarea'); editor.value = file.working ?? file.mine ?? file.incoming ?? ''; editor.rows = 12; editor.spellcheck = false;
        const hunks = [...(file.working || '').matchAll(/^<<<<<<<[^\n]*\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm)];
        for (const [index, match] of hunks.entries()) {
          const ours = match[1].split(/^\|{7}[^\n]*\n/m)[0], theirs = match[2];
          const choices = el('div', undefined, 'collab-hunk');
          choices.append(el('strong', `Conflict ${index + 1}`));
          const row = el('div', undefined, 'collab-versions');
          for (const [label, text] of [['Your text', file.reversed ? theirs : ours], ['Incoming text', file.reversed ? ours : theirs]]) {
            const choice = el('div', undefined, 'collab-hunk-choice');
            choice.append(el('span', label), el('pre', text, 'collab-diff'), button('Use ' + label.toLowerCase(), () => {
              if (!editor.value.includes(match[0])) { message('This conflict has already been edited. Continue editing the result below.'); return; }
              editor.value = editor.value.replace(match[0], () => text); editor.focus();
            })); row.append(choice);
          }
          choices.append(row); section.append(choices);
        }
        section.append(field('Resolved file contents', editor), button('Save this resolution', node => act(node, () => api().syncResolve(context.repoDir, { file: file.file, strategy: 'manual', text: editor.value, expectedFingerprint: file.fingerprint }), conflicts), true));
      } else section.append(note('Resolve this binary, large file, or symbolic link in your native editor, then refresh here.'));
      body.append(section);
    }
    if (context.sendAgent && result.files.length) body.append(button('Ask your terminal agent to propose resolutions', () => {
      context.sendAgent!(`Resolve the Git conflicts in these files: ${result.files.map(f => f.file).join(', ')}. Explain both sides and make the smallest resolution preserving their intent. Do not commit, push, drop stashes, or complete the integration. I will review the result in Radial.`);
      message('Review the agent’s edits here before continuing.');
    }));
    body.append(button('Refresh conflicts', conflicts));
    if (result.operation) {
      body.append(button('Review complete · continue integration', node => act(node, () => api().syncFinalize(context.repoDir), () => { busy = false; return pendingPublish ? preparePublish(pendingPublish) : changes(); }), true));
      body.append(note('Abort restores the saved starting work. Files as they exist immediately before abort are retained in recovery refs.'));
      body.append(button('Abort integration and restore saved work', node => act(node, () => api().collaborationAbort(context.repoDir), () => { busy = false; return changes(); })));
      body.append(el('code', result.operation.recoveryRef, 'collab-recovery'));
    } else body.append(note('This operation was started outside Radial. Resolve files here, then complete or abort it in your Git tool.'));
  }

  async function pulls(): Promise<void> {
    if (busy) return;
    const version = reset('Pull requests');
    message('Loading pull requests…');
    const result = await api().collaborationReview(context.repoDir, 'list');
    if (version !== revision) return;
    if (!result.ok) { message(result.error, true); return; }
    message('');
    body.append(button('Open a pull request…', () => preparePublish({ pr: true })));
    if (!result.prs.length) body.append(note('No open pull requests. Push a contribution branch to start a review.'));
    for (const pr of result.prs) {
      const row = el('article', undefined, 'collab-pr');
      row.append(button(`#${pr.number} ${pr.title}`, () => pull(pr.number)), note(`${pr.author} · ${pr.head} → ${pr.base}${pr.draft ? ' · Draft' : ''}`));
      body.append(row);
    }
    if (result.truncated) body.append(note('More pull requests are available on GitHub.'));
  }

  async function pull(number: number): Promise<void> {
    const version = reset(`Pull request #${number}`);
    message('Loading this revision, reviews, and checks…');
    const result: PullResult = await api().collaborationReview(context.repoDir, 'detail', { number });
    if (version !== revision) return;
    if (!result.ok) { message(result.error, true); body.append(button('Refresh', () => pull(number))); return; }
    message('');
    const pr = result.pr;
    body.append(el('h4', pr.title), note(`${pr.author} · ${pr.head} → ${pr.base} · ${pr.sha.slice(0, 8)} · ${pr.merged ? 'Merged' : pr.state}`), link('Open in GitHub', pr.url), note(pr.body || 'No description.'));
    const checks = el('ul');
    for (const check of [...result.checks, ...result.statuses]) { const item = el('li', `${check.name}: ${check.state} `); if (check.url) item.append(link('Details', check.url)); checks.append(item); }
    body.append(checks);
    if (!result.checksKnown) body.append(note('Some check information is unavailable. GitHub enforces the repository requirements.'));
    for (const review of result.reviews) body.append(note(`${review.author}: ${review.state}${review.sha !== pr.sha ? ' (earlier revision)' : ''}${review.body ? ' — ' + review.body : ''}`));
    if (!result.reviewsKnown) body.append(note('Review information is unavailable.'));
    for (const preview of result.previews) body.append(link(`${preview.environment}: ${preview.state} · preview of ${pr.sha.slice(0, 8)}`, preview.url));
    if (!result.previews.length) body.append(note('No deployment preview was found for this revision. Your local preview may contain different changes.'));
    if (result.filesError) body.append(note(result.filesError));
    for (const file of result.files) {
      const details = el('details');
      const content = el('div');
      details.append(el('summary', `${file.status} ${file.file} · +${file.additions} −${file.deletions}`), content);
      if (!file.patch) content.append(note('Text diff unavailable. Inspect this file on GitHub.'));
      else details.addEventListener('toggle', () => { if (details.open && !content.dataset.started) { content.dataset.started = 'true'; window.RadialDiffs.render(content, { kind: 'patch', patch: file.patch, hunksOnly: true, name: file.file, previousName: file.previousFile, status: file.status }); } });
      body.append(details);
    }
    if (result.filesTruncated) body.append(note('The file list is incomplete. Review the remaining files on GitHub.'));
    if (pr.state === 'open') {
      const comment = el('textarea'); comment.rows = 3;
      body.append(field('Review summary', comment));
      const row = el('div', undefined, 'collab-actions');
      for (const [label, event] of [['Approve', 'APPROVE'], ['Request changes', 'REQUEST_CHANGES']] as const) row.append(button(label, node => act(node, () => api().collaborationReview(context.repoDir, 'review', { number, sha: pr.sha, event, body: comment.value }), () => pull(number))));
      body.append(row);
      const plan: PlanResult = await api().collaborationPlan(context.repoDir, { target: 'branch', branch: pr.base });
      if (version !== revision) return;
      body.append(note(plan.deployment?.label || 'Deployment behavior is not verified.'));
      const method = el('select');
      for (const value of result.capabilities.mergeMethods || []) { const option = el('option', value === 'merge' ? 'Merge commit' : value === 'squash' ? 'Squash merge' : 'Rebase merge'); option.value = value; method.append(option); }
      body.append(field('Merge method', method));
      const merge = button(plan.deployment?.production ? 'Merge and deploy to production' : 'Merge pull request', node => act(node, () => api().collaborationReview(context.repoDir, 'merge', { number, sha: pr.sha, baseSha: pr.baseSha, method: method.value as MergeMethod, branch: pr.base, expectedRemote: plan.local?.remote, expectedDeployment: plan.hosting && { state: plan.deployment.state, production: !!plan.deployment.production, projectId: plan.hosting.projectId || null, orgId: plan.hosting.orgId || null } }), async res => { await pull(number); await showReceipt({ ...res, pushed: true, mode: 'merge' }, revision); }), true);
      // mergeQueue is undefined when the capability check failed, which disabled reads as false.
      merge.disabled = !plan.ok || !method.options.length || pr.draft || pr.mergeable !== true || result.filesTruncated || !!result.filesError || result.capabilities.mergeQueue!;
      body.append(merge, note(`GitHub merge state: ${pr.mergeState || 'not yet determined'}. Repository requirements still apply.`));
    }
    body.append(button('Refresh pull request', () => pull(number)));
  }

  async function destinationField(version: number, changed?: () => unknown): Promise<void> {
    const config = await api().configGet(context.repoDir);
    if (version !== revision) return;
    const select = el('select');
    for (const [value, label] of [['branch', 'Current branch'], ['staging', `Staging · origin/${config.effectiveStaging || config.config.stagingBranch}`], ['production', `Production · origin/${config.config.productionBranch}`]]) {
      const option = el('option', label); option.value = value; select.append(option);
    }
    select.value = draft().target;
    select.onchange = () => { saveDraft({ target: select.value as PublishTarget }); if (changed) changed(); };
    const wrap = field('Destination', select); wrap.classList.add('collab-destination');
    body.insertBefore(wrap, body.children[1] || null);
  }

  async function preparePublish(overrides: PublishActionOverrides = {}): Promise<void> {
    if (overrides.target || overrides.message !== undefined) saveDraft({ ...(overrides.target ? { target: overrides.target } : {}), ...(overrides.message !== undefined ? { message: overrides.message } : {}) });
    const { target: _target, message: _message, ...action } = overrides;
    pendingPublish = action;
    const opts = { ...draft(), ...action };
    const version = reset(opts.commitOnly ? 'Commit local changes' : 'Review push');
    message('Checking the destination…');
    if (!opts.commitOnly) await destinationField(version, () => preparePublish(action));
    if (version !== revision) return;
    const plan: PlanResult = await api().collaborationPlan(context.repoDir, opts);
    if (version !== revision) return;
    if (!plan.ok) { message(plan.message, true); return; }
    window.RadialPublish.refresh();
    message('');
    body.append(note(opts.commitOnly ? `Local branch: ${plan.local.branch}` : `${plan.slug || 'origin'} · ${plan.local.branch || 'Detached'} → origin/${plan.branch}${plan.pr ? ' via pull request' : ''}`));
    if (!opts.commitOnly && !plan.local.remote) { body.append(note('Connect an origin remote in Project settings before pushing.')); return; }
    body.append(note(opts.commitOnly ? 'This action saves a local commit. It does not push or deploy.' : plan.deployment.label));
    if (plan.mismatch) { body.append(note(`Project settings name ${plan.branch}, but Vercel reports ${plan.hosting.productionBranch} as production. Update Project settings before publishing to production.`)); return; }
    // behind is null or undefined without a remote branch to compare; that compares as not behind.
    if (!opts.commitOnly && plan.relation?.behind! > 0 && !plan.pr) body.append(button(`Integrate ${plan.relation!.behind} incoming commits first`, () => incoming(plan.branch)));
    if (!opts.commitOnly && plan.capabilities) body.append(note(`GitHub API account: ${plan.capabilities.actor || 'unknown'} · ${plan.capabilities.requiresPr ? 'PR required by repository rules' : plan.capabilities.state === 'known' ? 'No PR requirement found' : 'Some permissions are unknown'}. Git may use a different account.`));
    const scope = el('select');
    for (const [value, label] of [['all', 'Commit all changes'], ['staged', 'Commit staged changes only'], ['none', 'Push existing commits only']]) {
      if (opts.commitOnly && value === 'none') continue;
      const option = el('option', label); option.value = value; scope.append(option);
    }
    scope.value = opts.commit === false ? 'none' : opts.scope === 'none' && opts.commitOnly ? 'all' : opts.scope;
    const messageInput = el('textarea'); messageInput.rows = 2; messageInput.value = draft().message;
    messageInput.oninput = () => saveDraft({ message: messageInput.value });
    const messageField = field('Commit message (optional)', messageInput);
    body.append(field('Commit scope', scope), messageField);
    const files = el('div', undefined, 'collab-file-list');
    for (const file of plan.local.changes) {
      const details = el('details'); details.dataset.index = file.index;
      const content = el('div');
      details.append(el('summary', `${file.status} ${file.originalFile ? file.originalFile + ' → ' : ''}${file.file}`), content);
      let selectedScope: string | undefined;
      details.addEventListener('toggle', async () => {
        if (!details.open || selectedScope === scope.value) return;
        selectedScope = scope.value;
        const currentScope = scope.value;
        window.RadialDiffs.clear(content); content.replaceChildren();
        for (const staged of [true, false]) {
          if (staged && (file.untracked || file.index === ' ')) continue;
          if (!staged && (currentScope === 'staged' || (!file.untracked && file.worktree === ' '))) continue;
          const host = el('div'); content.append(note(staged ? 'Staged changes' : 'Working changes'), host);
          const result: LooseUnion<import('../shared/radialApi').FileDiff> = await api().collaborationDiff(context.repoDir, file.file, staged);
          if (version !== revision || currentScope !== scope.value || !host.isConnected) return;
          // A failure has an error or a message, a binary file its text.
          if (!result.ok || result.binary) host.textContent = (result.error || result.message || result.text)!;
          else await window.RadialDiffs.render(host, result.addedFile ? { kind: 'files', oldFile: null, newFile: result.addedFile } : { kind: 'patch', patch: result.text, name: file.file, previousName: file.originalFile });
        }
      });
      files.append(details);
    }
    body.append(files);
    if (plan.outgoing) body.append(el('h4', 'Existing commits to push'), el('pre', plan.outgoing, 'collab-diff'));
    const submit = button('', node => act(node, () => (opts.commitOnly ? api().publish : api().publishDeploy)(context.repoDir, {
      target: plan.target, branch: plan.branch, pr: plan.pr, push: !opts.commitOnly,
      commit: scope.value !== 'none', scope: scope.value === 'none' ? 'all' : scope.value as 'all' | 'staged',
      message: draft().message, expectedHead: plan.local.head, expectedFingerprint: plan.fingerprint, expectedRemote: plan.local.remote,
    }), async result => {
      pendingPublish = null;
      reset('Git operation complete');
      await showReceipt(result, revision);
      if (result.prNumber) body.append(button(`Review pull request #${result.prNumber}`, () => pull(result.prNumber!)));
      body.append(button('Review local changes', () => { busy = false; return changes(); }));
    }), true);
    const setScope = () => {
      messageField.hidden = scope.value === 'none';
      files.hidden = scope.value === 'none';
      for (const details of files.children as HTMLCollectionOf<HTMLDetailsElement>) { details.open = false; details.hidden = scope.value === 'staged' && [' ', '?'].includes(details.dataset.index!); }
      const commits = scope.value !== 'none' && (scope.value === 'staged' ? plan.local.staged : plan.local.changes.length) > 0;
      submit.textContent = opts.commitOnly ? 'Commit locally' : plan.pr ? 'Push branch and open pull request' : `${commits ? 'Commit and push' : 'Push'} to ${plan.branch}${plan.deployment.production ? ' · production' : ''}`;
    };
    scope.onchange = () => { saveDraft({ scope: scope.value as PublishDraft['scope'] }); setScope(); };
    setScope();
    // As above: a missing behind compares as not behind.
    submit.disabled = !!plan.local.operation || !!plan.local.conflicts.length || (!opts.commitOnly && !plan.pr && plan.relation?.behind! > 0) || (!opts.commitOnly && plan.pr && plan.capabilities?.canPush === false);
    const actions = el('div', undefined, 'collab-publish-actions');
    actions.append(submit, button('Refresh action', () => preparePublish(action))); body.append(actions);
  }

  async function deployments(): Promise<void> {
    const version = reset('Latest publish');
    const state: LooseUnion<CollaborationState> = await api().collaborationState(context.repoDir);
    if (version !== revision) return;
    const receipt = window.RadialPublish.receiptFor(context.repoDir, state);
    if (receipt && (!receipt.remote || receipt.remote === state.remote)) await showReceipt(receipt, version);
    else body.append(note('No publish has been recorded for this repository yet.'));
  }

  async function localDeploy(): Promise<void> {
    const version = reset('Deploy local files');
    await destinationField(version, localDeploy);
    if (version !== revision) return;
    if (draft().target === 'branch') return preparePublish({ commitOnly: true });
    const target = draft().target;
    body.append(note(`Save a local commit, then upload the files on this Mac to ${target === 'production' ? 'the linked Vercel production project' : 'the staging Vercel project'}. Files edited while the upload runs may also be included. Nothing is pushed to GitHub.`));
    const input = el('textarea'); input.value = draft().message; input.oninput = () => saveDraft({ message: input.value });
    body.append(field('Commit message (optional)', input));
    body.append(button(`Commit and deploy local files to ${target}`, node => act(node, async () => {
      const commit = await api().publish(context.repoDir, { target: 'branch', push: false, message: draft().message });
      if (!commit.ok) return commit;
      const deployed = target === 'production' ? await api().vercelDeploy({ repoDir: context.repoDir, prod: true }) : await api().vercelDeployAlt({ repoDir: context.repoDir, kind: 'client-preview', prod: true });
      if (!deployed.ok) return { ...deployed, message: `Saved ${commit.sha?.slice(0, 8)} locally. Deployment failed: ${deployed.error || deployed.reason}. Check Hosting in Project settings.` };
      // A commit that wasn't pushed: with push: false, publish returns the receipt before it pushes (publish.ts).
      return { ...commit, mode: 'vercel', target, url: deployed.url, at: Date.now() } as LocalDeployReceipt;
    }, async result => { reset('Deployment complete'); await showReceipt(result, revision); }), true));
  }

  async function showReceipt(receipt: LooseUnion<PublishSurfaceReceipt>, version: number): Promise<void> {
    const section = el('section', undefined, 'collab-receipt');
    section.append(note(`${receipt.mode === 'merge' ? 'Merged' : receipt.pushed ? 'Pushed' : 'Saved locally'} ${receipt.sha?.slice(0, 8) || ''}${receipt.branch ? ' · ' + receipt.branch : ''}`));
    body.append(section);
    if (receipt.mode === 'vercel') { section.replaceChildren(note(`Deployed local files · ${receipt.target}`), link('Open deployment', receipt.url)); return; }
    if (receipt.prUrl) section.append(link('Open pull request', receipt.prUrl));
    if (receipt.deploy) section.append(note(`Local build check: ${receipt.deploy.gate}${receipt.deploy.reason ? ' (' + receipt.deploy.reason + ')' : ''}.`));
    if (!receipt.pushed) { section.append(note('No deployment was requested by this action.')); return; }
    const status = note('Deployment status: checking…'); section.append(status);
    const refresh = async () => {
      const result: LooseUnion<DeploymentObservation | { state: 'unknown' }> = await api().collaborationDeployment(context.repoDir, receipt).catch(() => ({ state: 'unknown' }));
      if (revision !== version || !section.isConnected) return;
      saveDraft({ receipt, deployment: result });
      status.textContent = `Deployment: ${result.state === 'ready' ? 'ready' : result.state === 'unobserved' ? 'not yet reported for this commit' : result.state === 'unknown' ? 'status unavailable' : result.state}${result.environment ? ' · ' + result.environment : ''}.`;
      const previous = section.querySelector('[data-deployment]'); previous?.remove();
      if (result.url) { const url = link('Open this deployment', result.url); url.dataset.deployment = 'true'; section.append(url); }
      if (['building', 'queued', 'unobserved'].includes(result.state)) timer = setTimeout(refresh, 15000);
    };
    section.append(button('Refresh deployment', refresh));
    await refresh();
  }

  function publish(options: CollaborationContext, opts?: Partial<PublishDraft>): void { if (opts) window.RadialPublish.update(options.repoDir, opts); open(options, 'review'); }
  return { open, publish, close, isBusy: () => busy };
})();
