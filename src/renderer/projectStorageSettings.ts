'use strict';

window.RadialProjectStorageSettings = {
  async mount(host: HTMLElement, repoDir: string | null = null): Promise<void> {
    host.innerHTML = '<div class="set-section-head">Radial project data</div><p class="set-desc" role="status">Loading storage preference…</p>';
    let state: ProjectStorageStatus;
    try { state = await window.radial.projectDataGet(repoDir); }
    catch (error) { host.querySelector('[role="status"]')!.textContent = (error as Error).message; return; }
    if (!host.isConnected) return;
    const project = !!repoDir;
    host.innerHTML = `<div class="set-section-head">Radial project data</div>
      <div class="set-card"><div class="set-item">
        <div class="set-item-main"><label class="set-item-title" for="radialStorageMode">${project ? 'Storage for this project' : 'Keep Radial data local'}</label>
        <div class="set-item-desc" id="radialStorageHelp">${project ? 'Use the machine default or choose where this project keeps its Radial data.' : 'Store Radial settings, notes, and comments outside project folders. Projects can override this default.'}</div></div>
        <div class="set-item-act">${project ? `<select id="radialStorageMode" class="project-storage-select" aria-describedby="radialStorageHelp">
          <option value="default">Machine default (${state.defaultLocal ? 'local' : 'project folder'})</option>
          <option value="local">Local only</option><option value="project">In project folder</option></select>`
        : '<input id="radialStorageMode" class="setting-switch" type="checkbox" role="switch" aria-describedby="radialStorageHelp" />'}</div>
      </div></div>
      <p class="set-desc" id="radialStorageDetail"></p>
      <p class="set-desc" id="radialStorageStatus" role="status" aria-live="polite"></p>
      <button type="button" class="btn-mini" id="radialStorageReveal">Show data folder</button>`;
    // A <select> for a project, else a checkbox: checked is read and set only on the checkbox.
    const input = host.querySelector<HTMLInputElement | HTMLSelectElement>('#radialStorageMode')!;
    const status = host.querySelector('#radialStorageStatus')!;
    const detail = host.querySelector('#radialStorageDetail')!;
    const paint = () => {
      if (project) input.value = state.preference;
      else (input as HTMLInputElement).checked = state.defaultLocal;
      detail.textContent = project
        ? (state.local ? 'Radial data is stored on this computer. Native agents can read it with radial context.' : 'Radial data is stored in the project folder. Some files can be committed to Git.')
        : 'Local mode also stops Radial from adding agent instructions or metadata ignore rules to your repositories.';
      status.textContent = state.pending
        ? 'Saved. Close the affected project’s terminals and reopen the project to switch storage.'
        : project && state.local && state.existingFiles!.length
          ? 'Existing files in the project folder were preserved. This setting does not remove files or rewrite Git history.' : '';
    };
    paint();
    input.onchange = async () => {
      input.disabled = true;
      status.textContent = 'Saving…';
      try {
        const result = await window.radial.projectDataSet(project ? { repoDir, preference: input.value } : { defaultLocal: (input as HTMLInputElement).checked });
        if (!result.ok) throw new Error(result.error);
        state = result;
        paint();
        if (!status.textContent) status.textContent = 'Saved.';
      } catch (error) { paint(); status.textContent = (error as Error).message; }
      finally { input.disabled = false; }
    };
    host.querySelector<HTMLButtonElement>('#radialStorageReveal')!.onclick = () => window.radial.projectDataReveal(repoDir);
  },
};
