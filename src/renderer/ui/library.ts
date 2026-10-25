import { catalog, surfaces } from './catalog.js';
import type { UiAudit } from './catalog.js';

/** The elements $ looks up: index.html's, and the census slots only the inventory page renders. */
interface PageElements {
  uiAnnouncement: HTMLElement;
  uiSearch: HTMLInputElement;
  uiNav: HTMLElement;
  uiMain: HTMLElement;
  uiCensus: HTMLElement | null;
  uiPanels: HTMLElement | null;
}
const $ = <K extends keyof PageElements>(id: K) => document.getElementById(id) as PageElements[K];
const escape = (value: string) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c as '&' | '<' | '>' | '"' | "'"]));
const announce = (message: string) => { $('uiAnnouncement').textContent = message; };
let theme = 'dark';
try { theme = localStorage.getItem('radial.ui.appearance') || 'dark'; } catch {}
function setTheme(value: string) {
  theme = value;
  document.documentElement.classList.toggle('light', theme === 'light');
  document.querySelectorAll<HTMLButtonElement>('[data-ui-theme]').forEach((b) => { const active = b.dataset.uiTheme === theme; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  try { localStorage.setItem('radial.ui.appearance', value); } catch {}
  if (location.hash === '#foundations') render(false);
}
const pageId = () => location.hash.slice(1) || 'overview';
function renderNav() {
  const query = $('uiSearch').value.toLowerCase().trim();
  const pages = catalog.filter((p) => `${p.name} ${p.description} ${p.usage}`.toLowerCase().includes(query));
  let group = '';
  $('uiNav').innerHTML = pages.map((p) => {
    const heading = group !== p.group ? `<div class="ui-nav-group">${escape(p.group)}</div>` : '';
    group = p.group;
    return `${heading}<a href="#${p.id}"${p.id === pageId() ? ' aria-current="page"' : ''}>${escape(p.name)}</a>`;
  }).join('') || '<p class="ui-note">No matching components. Try “button” or “surface”.</p>';
}
function foundations() {
  const tokens = ['--bg', '--bg-2', '--bg-3', '--btn', '--text', '--muted', '--border', '--border-strong', '--success', '--warning', '--danger', '--canvas-surface'];
  const styles = getComputedStyle(document.documentElement);
  return `<section class="ui-section"><h2>Semantic colors</h2><div class="ui-grid">${tokens.map((token) => `<div class="ui-swatch"><div class="ui-swatch-color" style="background:var(${token})"></div><div class="ui-swatch-body"><code>${token}</code><small>${escape(styles.getPropertyValue(token).trim())}</small></div></div>`).join('')}</div></section>`
    + `<section class="ui-section"><h2>Type scale</h2>${['sm', 'md', 'lg', 'xl', '2xl', '3xl'].map((size) => `<div class="ui-type-row"><span style="font-size:var(--fs-${size})">A place for your work.</span><code>--fs-${size} · ${styles.getPropertyValue(`--fs-${size}`).trim()}</code></div>`).join('')}</section>`
    + `<section class="ui-section"><h2>Radii & elevation</h2><p class="ui-usage">Controls use --r-sm / --r-md. Grouped content uses --r-xl. Menus use --shadow-panel; blocking dialogs use --shadow-dialog. Canvas pills keep --r-float. Adjust the token, not a screenshot-specific copy.</p></section>`;
}
function overview() {
  return `<div class="ui-grid">${['foundations', 'buttons', 'settings', 'publish', 'surfaces', 'inventory'].map((id) => { const p = catalog.find((item) => item.id === id)!; return `<a class="ui-overview-card" href="#${id}"><h2>${p.name} ↗</h2><p>${p.description}</p></a>`; }).join('')}</div>`
    + '<section class="ui-section"><h2>How to use this library</h2><ol><li>Find the closest existing component or product pattern.</li><li>Try its states, then copy its markup and reuse its CSS classes.</li><li>Check keyboard behavior, both appearances, and empty/error states.</li><li>When a shared pattern changes, update its example and guidance together.</li></ol><p class="ui-note">This page does not load the app renderer or Electron bridge. Its sample actions cannot touch your projects.</p></section>';
}
function inventory() {
  return `<p id="uiCensus" class="ui-note" role="status">Reading the current source inventory…</p><div class="ui-table-wrap"><table><thead><tr><th>Surface</th><th>Implementation</th><th>Contract</th></tr></thead><tbody>${surfaces.map(([name, classes, source, family, note]) => `<tr><td>${escape(name)}<small>${family}</small></td><td><code>${escape(classes)}</code><small>${source}</small></td><td>${escape(note)}</td></tr>`).join('')}</tbody></table></div><section class="ui-section"><h2>Registered panels</h2><div id="uiPanels" class="ui-grid"></div></section><p class="ui-note">See the <a href="/docs/design/audit.md">audit and verification record</a> and <a href="/ui-audit.json">live source census</a> for remaining work. “Shelved” does not mean approved or ready to ship.</p>`;
}
function render(moveFocus = true) {
  const page = catalog.find((p) => p.id === pageId()) || catalog[0];
  document.title = `${page.name} · Radial UI`;
  renderNav();
  $('uiMain').innerHTML = `<header><p class="ui-eyebrow">${escape(page.group)}</p><h1>${escape(page.name)}</h1><p class="ui-description">${escape(page.description)}</p><p class="ui-usage">${escape(page.usage)}</p><div class="ui-source-links">${page.sources.map((s) => `<a href="/${s}" target="_blank" rel="noopener">${escape(s)} ↗</a>`).join('')}</div></header>`
    + (page.id === 'overview' ? overview() : page.id === 'foundations' ? foundations() : page.id === 'inventory' ? inventory() : '')
    + page.examples.map((ex, i) => `<section class="ui-example"><h2>${escape(ex.title)}</h2><div class="ui-preview">${ex.html}</div><div class="ui-code"><div class="ui-code-head"><span>HTML · existing app classes</span><button class="btn-mini" data-copy="${i}">Copy markup</button></div><pre><code>${escape(ex.html.replace(/></g, '>\n<'))}</code></pre></div>${ex.note ? `<p class="ui-note">${escape(ex.note)}</p>` : ''}</section>`).join('');
  if (page.id === 'inventory') fetch('/ui-audit.json').then((response) => { if (!response.ok) throw new Error('Inventory unavailable'); return response.json() as Promise<UiAudit>; }).then((report) => {
    if (!$('uiCensus')) return;
    $('uiCensus')!.textContent = `${report.tokenCount} tokens · ${report.selectorCount} selector groups · ${report.panels.length} registered panels · ${report.rawDeclarationCount} raw color declarations for contextual review. Generated from the current source, not a frozen checklist.`;
    $('uiPanels')!.innerHTML = report.panels.map((panel) => `<div class="ui-overview-card"><h3>${escape(panel.title)}</h3><p>${panel.experimental ? 'Experimental' : 'Current'} · <code>${escape(panel.id)}</code></p></div>`).join('');
  }).catch(() => { if ($('uiCensus')) $('uiCensus')!.textContent = 'Live census unavailable. Run npm run ui:audit from the project folder.'; });
  $('uiMain').querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => { button.onclick = async () => {
    try { await navigator.clipboard.writeText(page.examples[Number(button.dataset.copy)].html); button.textContent = 'Copied'; announce('Markup copied'); }
    catch { announce('Clipboard unavailable. Select the markup below to copy it.'); }
  }; });
  $('uiMain').querySelectorAll('[data-demo-segment]').forEach((group) => {
    group.querySelectorAll('button').forEach((button) => { button.onclick = () => { group.querySelectorAll('button').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); }); }; });
  });
  $('uiMain').querySelectorAll<HTMLButtonElement>('[data-demo-nav] button').forEach((button) => { button.onclick = () => { button.parentElement!.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-current')); button.setAttribute('aria-current', 'page'); announce(`Example section: ${button.textContent}`); }; });
  $('uiMain').querySelectorAll<HTMLButtonElement>('[data-demo-publish]').forEach((button) => {
    const preview = button.closest('.ui-preview')!;
    const update = () => { const choices = [...preview.querySelectorAll('input:checked')].map((el) => el.closest('label')!.querySelector('.pm-target-main')!.firstChild!.textContent!.trim().toLowerCase()); button.textContent = choices.length ? `Publish to ${choices.join(' + ')}` : 'Choose a destination'; button.disabled = !choices.length; };
    preview.querySelectorAll('input').forEach((input) => input.onchange = update);
    button.onclick = () => { preview.querySelector('[data-demo-publish-status]')!.textContent = 'Demo complete. No changes were published.'; };
  });
  const open = $('uiMain').querySelector<HTMLButtonElement>('[data-demo-dialog]');
  if (open) open.onclick = () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'demo-dialog-title');
    dialog.innerHTML = '<h2 id="demo-dialog-title">Remove from recents?</h2><p>This is a safe example. Your projects will not change.</p><form method="dialog" class="modal-actions"><button class="btn" autofocus>Cancel</button><button class="btn btn-danger">Remove from recents</button></form>';
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); open.focus(); }, { once: true });
    dialog.showModal();
  };
  if (moveFocus) { $('uiMain').focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
$('uiSearch').addEventListener('input', renderNav);
document.querySelectorAll<HTMLButtonElement>('[data-ui-theme]').forEach((b) => b.onclick = () => setTheme(b.dataset.uiTheme!));
window.addEventListener('hashchange', () => render());
setTheme(theme);
render(false);
