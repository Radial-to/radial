/* global window, document */
'use strict';
window.RadialPublishSettings = (() => {
  // A form's unsaved values by field name, seeded from the project's config (whose other fields ride along).
  const drafts = new Map<string, { values: Record<string, unknown>; dirty: boolean }>();
  /** A Vercel project the hosting page lists. */
  type HostingProject = Extract<import('../shared/radialApi').VercelProjects, { ok: true }>['projects'][number];
  /** The fields a form can have: the repository page's, the settings page's, and the hosting page's. */
  type FieldName = 'remote' | 'stagingBranch' | 'productionBranch' | 'productionPublish' | 'stagingUrl' | 'productionUrl' | 'scope' | 'search';
  /** A form's controls by field name: only the fields its page made. */
  type Controls = Partial<Record<FieldName, HTMLInputElement | HTMLSelectElement>>;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  function button(label: string, fn: (event: MouseEvent) => unknown, primary = false): HTMLButtonElement { const n = el('button', label, primary ? 'pm-control pm-save' : 'pm-link'); n.type = 'button'; n.onclick = fn; return n; }
  function field(label: string, control: HTMLElement): HTMLLabelElement { const n = el('label', null, 'pm-field'); control.setAttribute('aria-label', label); n.append(el('span', label), control); return n; }
  function mount(host: HTMLElement, { repoDir, page = 'settings', done, changed, busy, setup }: PublishSettingsOptions): void {
    const key = repoDir + ':' + page;
    let draft = drafts.get(key);
    if (!draft) { draft = { values: {}, dirty: false }; drafts.set(key, draft); }
    const valid = () => host.isConnected && host.firstChild === form;
    const form = el('form', null, 'pm-settings-form');
    const head = el('div', null, 'pm-detail-row');
    const cancel = button('Cancel', () => { if (!saving) { drafts.delete(key); done(); } });
    head.append(el('strong', page === 'repository' ? 'GitHub repository' : page === 'hosting' ? 'Hosting · Vercel' : 'Publish settings'), cancel);
    const fields = el('div', null, 'pm-settings-fields'), status = el('p', '', 'pm-note'); status.setAttribute('role', 'status');
    const save = button(page === 'repository' ? 'Save repository' : page === 'hosting' ? 'Use this project' : 'Save settings', () => {}, true); save.type = 'submit';
    const controls: Controls = {}, actions = el('div', null, 'pm-detail-row'); actions.append(save);
    form.append(head, fields, status, actions); host.replaceChildren(form);
    let saving = false, ready = false, selected: HostingProject | null | undefined, projectRevision = 0, searchTimer: TimerId | undefined;
    const input = (name: FieldName, label: string, options?: [string, string][]): HTMLInputElement | HTMLSelectElement => {
      const control = el(options ? 'select' : 'input'); control.name = name;
      if (options) for (const [value, title] of options) { const o = el('option', title); o.value = value; control.append(o); }
      else { (control as HTMLInputElement).type = 'text'; control.autocomplete = 'off'; control.spellcheck = false; }
      // Every field's draft value is a string: typed in, or a string field of the config.
      control.value = (draft.values[name] || '') as string;
      control.oninput = () => { draft.values[name] = control.value; draft.dirty = true; status.textContent = ''; paint(); };
      controls[name] = control; fields.append(field(label, control)); return control;
    };
    function paint() { for (const control of Object.values(controls)) control.disabled = saving || !ready; save.disabled = saving || !ready || (page === 'hosting' ? !selected : !draft!.dirty); cancel.disabled = saving; save.textContent = saving ? 'Saving…' : page === 'repository' ? 'Save repository' : page === 'hosting' ? 'Use this project' : 'Save settings'; }
    async function init() {
      try {
        if (page === 'hosting') { await hosting(); return; }
        const config = await window.radial.configGet(repoDir); if (!valid()) return;
        if (!draft!.dirty) draft!.values = page === 'repository' ? { remote: config.remote || '' } : { ...config.config, stagingBranch: config.effectiveStaging || config.config.stagingBranch };
        if (page === 'repository') {
          input('remote', 'Repository URL');
          fields.append(el('p', 'Changes origin for future fetches and pushes. Your local files stay in this folder.', 'pm-note'));
        } else {
          input('stagingBranch', 'Staging branch'); input('productionBranch', 'Production branch');
          // The two input() calls just above made both controls, each inside its field's label.
          const branches = el('div', null, 'pm-branch-grid'); branches.append(controls.stagingBranch!.parentElement!, controls.productionBranch!.parentElement!); fields.prepend(branches);
          input('productionPublish', 'Production workflow', [['direct', 'Direct push when permitted'], ['pr', 'Open a pull request']]);
          input('stagingUrl', 'Staging URL'); input('productionUrl', 'Production URL');
          const hostingRow = el('div', null, 'pm-detail-row'); hostingRow.append(el('span', 'Hosting · Vercel'), button('Change', () => { if (!saving) mount(host, { repoDir, page: 'hosting', done: () => mount(host, { repoDir, page, done, changed, busy, setup }), changed, busy, setup }); })); fields.append(hostingRow);
          const info = el('p', 'Checking linked project…', 'pm-note'); fields.append(info);
          window.radial.vercelProjectInfo(repoDir).then(result => { if (valid()) info.textContent = result.linked ? result.project || 'Linked Vercel project' : 'No hosting project linked'; }).catch(() => { if (valid()) info.textContent = 'Hosting status unavailable'; });
          fields.append(el('p', 'GitHub branch rules still apply. Saving settings does not publish.', 'pm-note'));
        }
        // Its keys are the names input() was given.
        ready = true; paint(); controls[Object.keys(controls)[0] as FieldName]?.focus();
      } catch (error) { if (valid()) status.textContent = (error as Error).message; }
    }
    async function hosting() {
      const result = await window.radial.vercelScopes(); if (!valid()) return;
      if (!result.ok) { status.textContent = 'Sign in to the Vercel CLI, then try again.'; actions.prepend(button('Connect Vercel', () => setup?.(result.reason))); return; }
      const scopes = result.scopes.map((s): [string, string] => [s.type === 'personal' ? '' : s.slug, s.name]);
      const scope = input('scope', 'Team', scopes); if (!draft!.dirty) scope.value = scopes[0]?.[0] || '';
      const search = input('search', 'Find a project') as HTMLInputElement; search.placeholder = 'Search projects…';
      const list = el('div', null, 'pm-project-list'), more = button('Load more', () => load(true)); fields.append(list, more); more.hidden = true;
      let next: number | null | undefined;
      async function load(append = false) {
        const version = ++projectRevision; if (!append) selected = null; paint(); status.textContent = 'Loading projects…'; more.disabled = true;
        if (!append) list.replaceChildren();
        try {
          const r = await window.radial.vercelProjects({ scope: scope.value, search: search.value.trim(), until: append ? next : undefined });
          if (!valid() || version !== projectRevision) return;
          if (!r.ok) throw Error(r.error);
          status.textContent = r.projects.length ? '' : 'No matching projects.';
          for (const project of r.projects) {
            const label = el('label', null, 'pm-project-option'), radio = el('input'); radio.type = 'radio'; radio.name = 'hostingProject';
            radio.onchange = () => { selected = project; paint(); };
            label.append(el('span', project.name), radio); list.append(label);
          }
          next = r.next; more.hidden = !next; more.textContent = 'Load more';
        } catch (error) { if (valid() && version === projectRevision) { status.textContent = (error as Error).message; more.hidden = false; more.textContent = 'Retry'; } }
        finally { more.disabled = false; }
      }
      scope.onchange = () => load(); search.oninput = () => { clearTimeout(searchTimer); projectRevision++; selected = null; list.replaceChildren(); more.hidden = true; paint(); searchTimer = setTimeout(() => { if (valid()) load(); }, 250); };
      fields.append(el('p', 'Links this folder to the selected project. It does not deploy or change its Git connection.', 'pm-note'));
      ready = true; paint(); await load();
    }
    form.onsubmit = async event => {
      event.preventDefault(); if (save.disabled) return;
      const values = Object.fromEntries(Object.entries(controls).map(([name, c]) => [name, c.value.trim()]));
      if (page === 'repository') {
        if (/^[\w.-]+\/[\w.-]+$/.test(values.remote)) values.remote = `https://github.com/${values.remote}.git`;
        if (!/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(values.remote)) { status.textContent = 'Enter a repository URL or owner/repository.'; return; }
      } else if (page === 'settings') {
        values.stagingBranch ||= 'staging'; values.productionBranch ||= 'main';
        for (const name of ['stagingUrl', 'productionUrl']) if (values[name]) {
          if (!/^https?:\/\//i.test(values[name])) values[name] = 'https://' + values[name];
          try { const url = new URL(values[name]); if (!['https:', 'http:'].includes(url.protocol)) throw Error(); } catch { status.textContent = 'Enter a valid site URL.'; return; }
        }
      }
      saving = true; busy?.(true); paint(); status.textContent = 'Saving…';
      try {
        const result = page === 'hosting' ? await window.radial.vercelLinkExisting({ repoDir, projectId: selected!.id, orgId: selected!.orgId }) : await window.radial.configSet(repoDir, page === 'settings' ? values : null, page === 'repository' ? values.remote : undefined);
        if (!result.ok) throw Error(result.error || 'Could not save settings.');
        drafts.delete(key); await changed?.(result); saving = false; busy?.(false); if (valid()) done();
      } catch (error) { if (valid()) status.textContent = (error as Error).message; }
      finally { saving = false; busy?.(false); if (valid()) paint(); }
    };
    paint(); init();
  }
  return { mount };
})();
