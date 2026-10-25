(() => {
  function create({ input, form, key, context, changed, menu, icon, commands, previewImage }: ChatComposerOptions): ChatComposer {
    const drafts = new Map<string, ChatAttachment[]>(); let loading = 0, request = 0, timer: TimerId | undefined, picker: HTMLDivElement | null | undefined;
    const chips = document.createElement('div'); chips.className = 'chat-context'; chips.setAttribute('aria-label', 'Attached context'); const contextHost = form.querySelector('#fluidChatContext'); if (contextHost) contextHost.append(chips); else input.before(chips);
    const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true; form.append(fileInput);
    const attach = document.createElement('button'); attach.type = 'button'; attach.id = 'nativeChatAttach'; attach.innerHTML = icon('IconPlusMedium', 16); attach.setAttribute('aria-label', 'Add files and context'); attach.setAttribute('aria-haspopup', 'menu');
    form.querySelector('.native-chat-settings')!.prepend(attach);
    const importStatus = document.createElement('div'); importStatus.className = 'chat-import-status'; importStatus.setAttribute('role', 'status'); form.before(importStatus);
    const files = () => drafts.get(key()) || [];
    function refresh() {
      if (window.RadialFluidChat) {
        const owner = key();
        // The chat panel is only up for a project or Home's folder (nativeChat's refresh()
        // skips a context without one), so its composer's context has a repoDir.
        window.RadialFluidChat.attachments(chips, { items: files(), repoDir: context().repoDir!, preview: previewImage,
          remove: item => { if (key() !== owner) return; drafts.set(owner, files().filter(file => file.path !== item.path)); refresh(); changed(); input.focus(); },
        });
        importStatus.textContent = loading ? 'Adding files…' : '';
        return;
      }
      chips.replaceChildren();
      for (const item of files()) {
        const chip = document.createElement('span'); chip.className = 'chat-context-chip'; chip.title = item.path;
        const label = document.createElement('span'); label.textContent = item.name;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + item.name);
        remove.onclick = () => { drafts.set(key(), files().filter(file => file.path !== item.path)); refresh(); changed(); input.focus(); };
        chip.append(label, remove); chips.append(chip);
      }
      importStatus.textContent = loading ? 'Adding files…' : '';
    }
    function add(item: ChatAttachment, targetKey: string): void { const list = drafts.get(targetKey) || []; if (!list.some(file => file.path === item.path)) { if (list.length >= 10) throw new Error('Attach up to 10 files per message.'); drafts.set(targetKey, [...list, item]); } }
    async function importFiles(list: File[]): Promise<void> {
      const targetKey = key(); loading++; refresh(); changed();
      try {
        for (const file of list) {
          if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Each attachment must be between 1 byte and 20 MB.');
          if ((drafts.get(targetKey) || []).length >= 10) throw new Error('Attach up to 10 files per message.');
          const item = await window.radial.nativeChatAttach({ name: file.name || 'Screenshot.png', bytes: new Uint8Array(await file.arrayBuffer()) });
          add(item, targetKey);
        }
      } catch (error) { changed((error as Error).message); }
      finally { loading--; refresh(); changed(); }
    }
    function closePicker() { clearTimeout(timer); request++; picker?.remove(); picker = null; input.removeAttribute('aria-expanded'); input.removeAttribute('aria-controls'); }
    function showChoices<T extends { name: string }>(items: T[], select: (item: T) => void, title: string): void {
      picker?.remove(); picker = document.createElement('div'); picker.id = 'nativeChatContextPicker'; picker.className = 'chat-context-picker'; picker.setAttribute('role', 'listbox'); picker.setAttribute('aria-label', title);
      input.setAttribute('aria-controls', picker.id); input.setAttribute('aria-expanded', 'true');
      for (const item of items) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = item.name; button.setAttribute('role', 'option'); button.title = item.name;
        button.onclick = () => { select(item); closePicker(); input.focus(); };
        button.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closePicker(); input.focus(); } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); ((event.key === 'ArrowDown' ? button.nextElementSibling : button.previousElementSibling) as HTMLElement | null)?.focus(); } };
        picker.append(button);
      }
      if (!items.length) picker.textContent = 'No matching project files';
      form.append(picker);
    }
    async function showFiles(query = '', mention = false) {
      const seq = ++request, targetKey = key(), repo = context().repoDir;
      try {
        // The picker opens from a showing chat panel, whose context has a repoDir (see refresh()).
        const items = await window.radial.nativeChatFiles(repo!, query);
        if (seq !== request || key() !== targetKey) return;
        showChoices(items, item => { try { add(item, targetKey); if (mention) input.value = input.value.replace(/(^|\s)@[^\n@]*$/, '$1'); refresh(); changed(); } catch (error) { changed((error as Error).message); } }, 'Project files');
      } catch (error) { if (seq === request) changed((error as Error).message); }
    }
    attach.onclick = () => menu(attach, [
      { label: 'Attach files', action: () => fileInput.click() },
      { label: 'Reference project file', action: () => showFiles() },
      ...commands().filter(item => item.name === 'Chat capabilities').map(item => ({ label: item.name, action: item.action })),
    ]);
    fileInput.onchange = () => { importFiles([...fileInput.files!]); fileInput.value = ''; };
    input.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); importFiles(files); } });
    form.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); form.classList.add('chat-dragover'); } });
    form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget as Node | null)) form.classList.remove('chat-dragover'); });
    form.addEventListener('drop', event => { form.classList.remove('chat-dragover'); if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); importFiles([...event.dataTransfer.files]); } });
    input.addEventListener('input', () => {
      clearTimeout(timer); const mention = input.value.match(/(?:^|\s)@([^\n@]*)$/);
      if (mention) { timer = setTimeout(() => showFiles(mention[1], true), 120); return; }
      if (/^\/[\w ]*$/.test(input.value)) { const query = input.value.slice(1).toLowerCase(); showChoices(commands().filter(item => item.name.toLowerCase().includes(query)), item => { input.value = ''; changed(); item.action(); }, 'Chat commands'); return; }
      closePicker();
    });
    input.addEventListener('keydown', event => { if (!picker) return; if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePicker(); } else if (['ArrowDown', 'Enter'].includes(event.key) && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); const first = picker.querySelector('button'); if (event.key === 'Enter') first?.click(); else first?.focus(); } }, true);
    document.addEventListener('pointerdown', event => { if (picker && !picker.contains(event.target as Node | null) && event.target !== input && event.target !== attach) closePicker(); });
    return { files, refresh, closePicker, clear: target => { drafts.delete(target); refresh(); }, busy: () => loading > 0, take: () => { const list = files(); drafts.delete(key()); refresh(); return list; }, restore: (list, target = key()) => { drafts.set(target, list); refresh(); } };
  }
  window.RadialChatComposer = { create };
})();
