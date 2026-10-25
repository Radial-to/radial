/* global window, document */
'use strict';
window.RadialProjectLibrary = (() => {
  const cache = new Map<string, LibraryCacheEntry>(), pending = new Map<string, Promise<LooseUnion<LibraryEntry>>>();
  // context is set by configure(), before anything reads it.
  let context: ProjectLibraryContext, loadingRows = false, githubView: LibraryGithubView | undefined, selection = 0;
  const api = () => window.radial;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text: string, action: (event: MouseEvent) => unknown): HTMLButtonElement => { const b = el('button', text, 'btn'); b.type = 'button'; b.onclick = action; return b; };
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  function label(s: LooseUnion<LibraryEntry> | null | undefined): string {
    if (!s) return 'Reading repository…';
    if (!s.isRepo) return s.reason === 'not-a-repo' ? 'Local folder' : 'Couldn’t check';
    if (s.operation || s.operationRecord || s.conflicts?.length) return 'Integration needs attention';
    if (!s.remote) return 'Local Git repository';
    if (s.detached) return 'Detached HEAD';
    if (s.unborn) return 'No commits yet';
    if (!s.ok) return 'Couldn’t check updates';
    const local = s.changes?.length ? count(s.changes.length, 'local change') : '';
    if (!s.checkedAt || Date.now() - s.checkedAt > 60000) return [local, 'Updates not checked'].filter(Boolean).join(' · ');
    if (!s.exists) return [local, 'No upstream branch'].filter(Boolean).join(' · ');
    const incoming = s.behind ? count(s.behind, 'incoming commit') : '';
    const outgoing = s.ahead ? count(s.ahead, 'unpushed commit') : '';
    return [local, incoming, outgoing].filter(Boolean).join(' · ') || 'Up to date';
  }
  function remember(s: LibraryEntry): void { cache.set(s.dir, { ...s, readAt: Date.now() }); paintRows(); }
  async function check(dir: string, fetch = true): Promise<LooseUnion<LibraryEntry>> {
    const key = dir + ':' + fetch;
    if (pending.has(key)) return pending.get(key)!;
    const request = api().libraryStatus(dir, fetch).catch((error: Error): LibraryEntry => ({ dir, ok: false, reason: 'status-failed', message: error.message })).then(s => { remember(s); return s; }).finally(() => pending.delete(key));
    pending.set(key, request); return request;
  }
  function paintRows(): void {
    for (const row of document.querySelectorAll<HTMLElement>('[data-library-dir]')) {
      const s = cache.get(row.dataset.libraryDir!); if (!s) continue;
      const repo = row.querySelector('.hg-repository'), status = row.querySelector<HTMLElement>('.hg-sync');
      if (repo) repo.textContent = s.slug ? `${s.slug} · ${s.branch || 'Detached HEAD'}` : s.isRepo ? `Local Git · ${s.branch || 'No branch'}` : '';
      if (status) { status.textContent = label(s); status.title = s.message || (s.checkedAt ? `Checked ${new Date(s.checkedAt).toLocaleTimeString()}` : ''); }
    }
  }
  async function observeRows(items: { path: string }[]): Promise<void> {
    paintRows(); if (loadingRows) return;
    const dirs = items.map(i => i.path).filter(dir => !cache.has(dir) || Date.now() - cache.get(dir)!.readAt > 30000);
    if (!dirs.length) return;
    loadingRows = true;
    try { for (const s of await api().libraryStatuses(dirs) as LooseUnion<LibraryEntry>[]) {
      const old = cache.get(s.dir);
      if (old?.checkedAt && (['head', 'branch', 'remote', 'sha'] as const).every(k => old[k] === s[k])) s.checkedAt = old.checkedAt;
      remember(s);
    } } finally { loadingRows = false; }
  }
  /** What opening a repository answers (context.openGithub's answer, which covers openLocal's), read without narrowing. */
  type OpenAnswer = LooseUnion<Awaited<ReturnType<ProjectLibraryContext['openGithub']>>>;
  function openLocal(dir: string, url: string): Promise<OpenAnswer> { return url ? context.openGithub(url, dir) : context.openLocal(dir); }
  async function choose(url: string, supplied?: LibraryEntry[] | null, localDir?: string): Promise<void> {
    const version = ++selection, host = document.getElementById('hgCheckout')!;
    context.home(); host.hidden = false; context.render(); host.replaceChildren(el('h2', localDir ? 'Open local copy' : url.replace(/^https:\/\/github.com\//, '')), el('p', 'Finding local copies…', 'hg-library-note'));
    try {
      const copies: LooseUnion<LibraryEntry>[] = supplied || (localDir ? [await check(localDir, false)] : await api().libraryCopies(url));
      if (version !== selection) return;
      host.replaceChildren();
      const head = el('div', null, 'hg-library-tools'); head.append(el('h2', localDir ? 'Open local copy' : url.replace(/^https:\/\/github.com\//, '')), button('Close', () => { selection++; host.hidden = true; context.render(); })); host.append(head);
      if (!copies.length) {
        host.append(el('p', 'No local copy found in your recent projects or common project folders.', 'hg-library-note'), button('Clone and open', async event => {
          const trigger = event.currentTarget as HTMLButtonElement; trigger.disabled = true;
          try {
            const result: OpenAnswer = await context.openGithub(url);
            if (version !== selection) return;
            if (result?.ok) host.hidden = true;
            else host.querySelector('.hg-library-note')!.textContent = result?.error || 'Couldn’t open this repository. Try again.';
          } finally { trigger.disabled = false; }
        }));
        return;
      }
      host.append(el('p', copies.length > 1 ? 'Choose a local copy. Each folder can have its own branch and edits.' : 'Open immediately, or check and update this branch first.', 'hg-library-note'));
      for (const initial of copies) {
        const dir = initial.dir; remember(initial);
        const card = el('article', null, 'hg-copy'), name = el('strong'), path = el('code', dir), status = el('p', 'Checking updates…', 'hg-library-note'), actions = el('div', null, 'hg-library-tools');
        const openCopy = async (): Promise<boolean> => {
          open.disabled = true;
          try {
            const result = await openLocal(dir, url);
            if (result?.ok && version === selection) host.hidden = true;
            else if (version === selection) status.textContent = result?.error || 'Couldn’t open this local copy. Try again.';
            return result?.ok;
          } catch (error) { status.textContent = (error as Error).message; return false; }
          finally { open.disabled = false; }
        };
        const open = button('Open local copy', openCopy);
        const action = button('Checking…', () => {}); action.disabled = true;
        actions.append(open, action); card.append(name, path, status, actions); host.append(card);
        const paint = (s: LooseUnion<LibraryEntry>): void => {
          name.textContent = `${s.slug || 'Local copy'} · ${s.branch || 'No branch'}`;
          status.textContent = label(s); action.disabled = false;
          if (s.canUpdate) {
            action.textContent = 'Update and open'; action.onclick = async () => {
              action.disabled = open.disabled = true; status.textContent = 'Updating this branch…';
              try {
                const result: LooseUnion<import('../shared/radialApi').LibraryUpdateResult> = await api().libraryUpdate(dir, s);
                if (!result.ok) { if (result.state) remember(result.state); status.textContent = result.message; action.textContent = 'Check again'; action.onclick = refresh; return; }
                if (await openCopy()) context.notify(`Updated ${result.branch} with ${count(result.pulled!, 'incoming commit')}.`); // pulled is set: main answers ok only after canUpdate, which needs behind > 0
              } catch (error) { status.textContent = (error as Error).message; }
              finally { action.disabled = open.disabled = false; }
            };
          } else if ((s.behind ?? 0) > 0 || s.operation || s.operationRecord || s.conflicts?.length) {
            action.textContent = 'Review updates'; action.onclick = async () => { if (await openCopy()) context.review(dir); };
          } else { action.textContent = 'Check updates'; action.onclick = refresh; }
        };
        const refresh = async (): Promise<void> => { action.disabled = true; status.textContent = 'Checking updates…'; const s = await check(dir); if (version === selection && card.isConnected) paint(s); };
        name.textContent = `${initial.slug || 'Local copy'} · ${initial.branch || 'No branch'}`; refresh();
      }
    } catch (error) { if (version === selection) host.replaceChildren(el('p', (error as Error).message, 'hg-library-note'), button('Try again', () => choose(url, null, localDir))); }
  }
  function renderGithub(host: HTMLElement, query = ''): void {
    if (!githubView || githubView.host !== host) {
      const tools = el('div', null, 'hg-github-toolbar');
      let selectedOwner = '';
      const owners = [{ value: '', label: 'All accounts' }];
      const owner = button('', () => showOwners()); owner.className = 'hg-github-owner';
      owner.setAttribute('aria-label', 'GitHub account or organization'); owner.setAttribute('aria-haspopup', 'menu'); owner.setAttribute('aria-expanded', 'false');
      const ownerLabel = el('span', 'All accounts'), chevron = el('span'); chevron.innerHTML = context.icon('IconChevronDownSmall', 14); owner.append(ownerLabel, chevron);
      const showOwners = (last = false) => context.openMenu(owner, owners.map(item => ({
        label: item.label, checked: item.value === selectedOwner,
        action: () => { selectedOwner = item.value; ownerLabel.textContent = item.label; load(); },
      })), last);
      owner.onkeydown = event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); showOwners(event.key === 'ArrowUp'); } };
      const refresh = button('', () => load()); refresh.className = 'hg-github-refresh'; refresh.innerHTML = context.icon('IconArrowRotateClockwise', 16); refresh.setAttribute('aria-label', 'Refresh repositories'); refresh.title = 'Refresh repositories';
      const linkRow = el('form', null, 'hg-github-link'), input = el('input'); linkRow.id = 'hgGithubLink'; linkRow.hidden = true;
      input.placeholder = 'owner/repository or GitHub URL'; input.setAttribute('aria-label', 'Open a GitHub repository URL'); input.autocomplete = 'off'; input.spellcheck = false;
      const submit = button('', () => {}); submit.type = 'submit'; submit.innerHTML = context.icon('IconChevronRight', 16); submit.setAttribute('aria-label', 'Open repository'); submit.disabled = true;
      const linkError = el('p', '', 'hg-library-note hg-github-link-error'); linkError.id = 'hgGithubLinkError'; linkError.hidden = true; linkError.setAttribute('role', 'alert'); input.setAttribute('aria-describedby', linkError.id);
      input.oninput = () => { submit.disabled = !input.value.trim(); linkError.hidden = true; input.removeAttribute('aria-invalid'); };
      linkRow.append(input, submit);
      const openLink = button('Open link', () => {
        linkRow.hidden = !linkRow.hidden; linkError.hidden = true; openLink.setAttribute('aria-expanded', String(!linkRow.hidden));
        if (!linkRow.hidden) input.focus();
      });
      openLink.className = 'hg-github-open-link'; openLink.setAttribute('aria-controls', linkRow.id); openLink.setAttribute('aria-expanded', 'false');
      linkRow.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); linkRow.hidden = true; linkError.hidden = true; openLink.setAttribute('aria-expanded', 'false'); openLink.focus(); } };
      const actions = el('div', null, 'hg-github-actions'); actions.append(refresh, openLink); tools.append(owner, actions);
      const note = el('p', '', 'hg-library-note hg-github-note'); note.setAttribute('role', 'status'); const list = el('div', null, 'hg-repository-list'); list.setAttribute('role', 'list');
      host.replaceChildren(tools, linkRow, linkError, list, note);
      const view: LibraryGithubView = githubView = { host, list, note, query, repos: [], version: 0 };
      linkRow.onsubmit = event => { event.preventDefault(); let url = input.value.trim(); if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = 'https://github.com/' + url; if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(url)) { linkError.textContent = 'Enter a GitHub URL or owner/repository.'; linkError.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; } linkError.hidden = true; input.removeAttribute('aria-invalid'); choose(url); };
      async function load(): Promise<void> {
        const revision = ++view.version; view.loading = true; note.textContent = 'Loading repositories…'; refresh.disabled = true;
        try {
          const result: LooseUnion<import('../shared/radialApi').GitHubRepoList> = await api().libraryRepos(selectedOwner); if (revision !== view.version) return;
          view.repos = result.repos || []; view.error = !result.ok; view.truncated = result.truncated;
          note.textContent = result.ok ? '' : 'Couldn’t load repositories. Connect GitHub in Settings, then refresh.';
          view.loading = false; drawGithub();
        } catch (error) { if (revision === view.version) { view.error = true; note.textContent = (error as Error).message; } }
        finally { if (revision === view.version) { view.loading = false; refresh.disabled = false; } }
      }
      api().githubOwners().then(result => {
        if (!result?.ok || githubView !== view) return;
        for (const value of new Set([result.user, ...(result.orgs || [])].filter(Boolean))) owners.push({ value, label: value });
      }).catch(() => {});
      load();
    }
    githubView.query = query; drawGithub();
  }
  function drawGithub(): void {
    const view = githubView; if (!view) return;
    const repos = view.repos.filter(r => `${r.nameWithOwner} ${r.description}`.toLowerCase().includes(view.query.toLowerCase()));
    view.list.replaceChildren();
    for (const repo of repos) {
      const row = el('article', null, 'hg-repository-row'); row.setAttribute('role', 'listitem');
      const info = el('div'), name = el('strong', repo.nameWithOwner); info.append(name, el('p', repo.description || (repo.isPrivate ? 'Private repository' : 'GitHub repository'), 'hg-library-note'));
      const known = [...cache.values()].some(s => s.slug?.toLowerCase() === repo.nameWithOwner.toLowerCase());
      row.append(info, button(known ? 'Open local copy' : 'Open…', () => choose(repo.url))); view.list.append(row);
    }
    if (!view.error && !view.loading) view.note.textContent = view.truncated ? `Showing ${view.repos.length} repositories. Use Open link for another repository.` : view.repos.length && !repos.length ? 'No matching repositories.' : !view.repos.length ? 'No repositories found.' : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`;
  }
  setInterval(() => {
    if (!document.getElementById('homeGrid')?.getClientRects().length || document.hidden) return;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-library-dir]')].map(row => ({ path: row.dataset.libraryDir! }));
    observeRows(rows).catch(() => {});
  }, 30000);
  return { configure: (value: ProjectLibraryContext) => { context = value; }, observeRows, paintRows, renderGithub, choose, check, label,
    metadata: dir => cache.get(dir), inspect: dir => choose('', null, dir),
    opened: async dir => { const s = await check(dir); if (s.remote && context.isCurrent(dir)) context.notify(`${s.branch || 'Repository'} · ${label(s)}`); },
    openMessage: result => ({ 'reused-local': 'Opened your existing local copy', 'opened-local': 'Opened your existing local copy', cloned: 'Cloned from GitHub', 'kept-dirty': 'Opened local copy; local edits kept', 'kept-detached': 'Opened local copy; detached HEAD kept', 'kept-local': 'Opened local copy; branch was not updated', pulled: 'Updated local branch from GitHub' }[result.action] || 'Opened local copy'),
  };
})();
