/* Rich content is sanitized before Radial adds its own interactive controls. */
(() => {
  const { Marked, DOMPurify, hljs } = window.RadialChatContent;
  const tags: string[] = ['p','strong','em','del','code','pre','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','hr','br','a','table','thead','tbody','tr','th','td','input'];
  const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string, string>)[c]);
  const markdown = new Marked({ gfm: true, breaks: false, renderer: { html({ text }: { text: string }) { return escape(text); }, image({ href, text }: { href: string; text: string }) { return `<a href="${escape(href)}">${escape(text || href.split('/').pop() || 'Image')}</a>`; } } });
  function button(text: string, action: (event: MouseEvent) => unknown): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action; return b; }
  async function copy(text: string, target: CopyButton, copiedIcon?: string): Promise<void> {
    target._copyOriginal ||= { html: target.innerHTML, label: target.getAttribute('aria-label'), tip: target.dataset.tip };
    clearTimeout(target._copyTimer);
    let label;
    try { await navigator.clipboard.writeText(text); label = 'Copied'; if (copiedIcon) target.innerHTML = copiedIcon; else if (!target.classList.contains('chat-icon-action')) target.textContent = label; }
    catch { label = 'Could not copy'; if (!target.classList.contains('chat-icon-action')) target.textContent = label; }
    target.setAttribute('aria-label', label); target.dataset.tip = label;
    target._copyTimer = setTimeout(() => {
      if (!target.isConnected) return;
      const original = target._copyOriginal!; target.innerHTML = original.html;
      if (original.label) target.setAttribute('aria-label', original.label); else target.removeAttribute('aria-label');
      if (original.tip) target.dataset.tip = original.tip; else delete target.dataset.tip;
    }, 1500);
  }
  function render(body: HTMLElement, text: string, actions: ChatResponseActions): void {
    body.innerHTML = DOMPurify.sanitize(markdown.parse(text || '') as string, { ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href','class','type','checked','disabled','start','align'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
    body.querySelectorAll('input').forEach(input => { input.type = 'checkbox'; input.disabled = true; input.tabIndex = -1; });
    body.querySelectorAll('table').forEach(table => { const wrap = document.createElement('div'); wrap.className = 'chat-table'; wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Response table'); table.replaceWith(wrap); wrap.append(table); });
    body.querySelectorAll('pre > code').forEach(code => {
      const raw = code.textContent, lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'text';
      if (!actions.streaming && raw.length < 50000 && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
      const header = document.createElement('div'); header.className = 'chat-code-head';
      const label = document.createElement('span'); label.textContent = lang;
      const copyButton = button('Copy', () => copy(raw, copyButton)); copyButton.setAttribute('aria-label', 'Copy code');
      header.append(label, copyButton); code.parentNode!.prepend(header);
    });
    const local = new Map(), sources = new Map();
    body.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href') || ''; link.removeAttribute('href');
      if (/^https?:\/\//i.test(href)) {
        // A caller that passes canPreview passes preview with it (nativeChat does).
        try { const url = new URL(href); if (url.username || url.password) return; link.href = url.href; if (actions.canPreview?.(url.href)) { const preview = button('Open in preview', () => actions.preview!(url.href)); preview.className = 'chat-preview-link'; link.after(preview); } link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.set(url.href, link.textContent || url.hostname); } catch {}
      } else if (href && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#')) {
        link.href = '#'; link.className = 'chat-file-link'; link.onclick = event => { event.preventDefault(); actions.file(href, 'open'); };
        local.set(href, link.textContent || href);
      }
    });
    if (local.size) {
      const files = document.createElement('div'); files.className = 'chat-files';
      for (const [href, label] of local) {
        const card = document.createElement('div'); card.className = 'chat-file';
        const name = button(label, () => actions.file(href, 'open')); name.className = 'chat-file-name'; name.title = href;
        const controls = document.createElement('div');
        controls.append(button('Open', () => actions.file(href, 'open')), button('Reveal', () => actions.file(href, 'reveal')), button('Save as', () => actions.file(href, 'save')));
        card.append(name, controls); files.append(card);
        if (!actions.streaming && /\.(png|jpe?g|gif|webp)(?::\d+)?$/i.test(href)) {
          // An answer with a src is the image file (ChatFile has its name).
          actions.describe(href).then(item => { if (!card.isConnected || !item.src) return; const img = document.createElement('img'); img.src = item.src; img.alt = label; img.loading = 'lazy'; const preview = button('', () => actions.previewImage(item as ChatImagePreview)); preview.className = 'chat-image'; preview.setAttribute('aria-label', 'Preview ' + label); preview.append(img); card.prepend(preview); }).catch(() => {});
        }
      }
      body.append(files);
    }
    if (sources.size > 1) {
      const details = document.createElement('details'); details.className = 'chat-sources';
      const summary = document.createElement('summary'); summary.textContent = `${sources.size} linked sources`; details.append(summary);
      for (const [href, label] of sources) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label; details.append(a); }
      body.append(details);
    }
  }
  window.RadialChatResponses = { render, copy, button };
})();
