(() => {
  type ChatMessage = import('../shared/radialApi').ChatMessage;
  type ChatEvent = import('../shared/radialApi').ChatEvent;
  /**
   * A question the agent asked: a ChatQuestion as the CLI sent it. Codex can
   * mark one secret (its answer is a password field), which ChatQuestion
   * doesn't list yet. Main passes Codex's questions through untouched, so the
   * field belongs on ChatQuestion in shared/radialApi.ts; this alias goes once
   * that file's owner adds it there.
   */
  type ApprovalQuestion = import('../shared/radialApi').ChatQuestion & { isSecret?: boolean };
  const $ = <K extends string>(id: K): ElementById<K> => document.getElementById(id) as ElementById<K>;
  const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  // hooks is set by configure(), before anything reads it. The composer is made
  // later in configure(), after its awaits and only when chat is enabled, so
  // code that can run without it checks for it (send() answers false).
  let hooks: NativeChatHooks, enabled = false, current: ChatSession | null = null, contextKey = '', loading = false, sending = false, mode: ChatView = 'chat', uiError = '', configuring = false, switching = false, stopping = false, terminalChatId: string | null = null;
  let composer: ChatComposer | undefined, editing = false;
  // Project chats open in Terminal (the CLI handles its own permissions); the
  // Home workspace agent opens as Chat. Each side remembers its last explicit
  // choice; each session still owns its CLI handoff.
  const viewDefaults: Record<'project' | 'home', ChatView> = { project: 'terminal', home: 'chat' };
  function preferredView(home: boolean): ChatView {
    const side = home ? 'home' : 'project';
    try { const view = localStorage.getItem('radial.chatView.' + side); if (view === 'chat' || view === 'terminal') return view; } catch {}
    return viewDefaults[side];
  }
  function rememberView(view: ChatView, home: boolean): void {
    try { localStorage.setItem('radial.chatView.' + (home ? 'home' : 'project'), view); } catch {}
  }
  function sameContext(context: Pick<NativeChatContext, 'repoDir' | 'home'>): boolean {
    const active = hooks.context();
    return active.repoDir === context.repoDir && !!active.home === !!context.home;
  }
  /** A project's (or Home's) key in the panel's maps: its folder, marked for Home. */
  const keyOf = (c: { repoDir?: string | null; home?: boolean }): string => `${c.home ? 'home:' : ''}${c.repoDir}`;
  // What was last put on screen on purpose, per project (or Home): a chat picked
  // or created (select), or a terminal someone chose (terminal). A refresh, and
  // the first chat it starts for a project, that began before that pick don't
  // take the screen back from it.
  let pickSeq = 0;
  const picks = new Map<string, { seq: number; id: string | null; chat: boolean }>();
  function pick(key: string, id: string | null, chat: boolean): void { picks.set(key, { seq: ++pickSeq, id, chat }); }
  /** The project's latest pick when it came after `since` and isn't `own`, the chat the caller is showing. */
  function pickedSince(key: string, since: number, own?: string | null): { id: string | null; chat: boolean } | null {
    const latest = picks.get(key);
    return latest && latest.seq > since && latest.id !== own ? latest : null;
  }
  // The first chat the panel started for each project (or Home) when it showed
  // it (switchView): an API caller's task goes there while it is unused (firstChat).
  const booted = new Map<string, string>();
  // Nobody has used this chat: nothing sent, typed, queued or waiting, and no
  // name, pin or keep-awake of its own (main's discard asks the same).
  const unused = (s: ChatSession): boolean => !s.archived && !s.messages.length && !s.lastSubmittedAt && !s.queue?.length && !s.terminalHasInput && !s.nativePendingPrompt && !s.providerPersisted && !s.initialPrompt
    && s.titleAuto === true && !s.recentPinnedAt && !s.keepAwake && !['working', 'approval'].includes(s.state);
  const errorText = (error: unknown): string => String((error as Error | null | undefined)?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const providerLabels: Record<ChatEngine, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
  const modelCatalogs = new Map<string, ChatModel[]>(), pendingSettings = new Map<string, PendingChatSettings>();
  let settingsRequest = 0;
  const selected = new Map<string, string>(), drafts = new Map<string, string>(), cache = new Map<string, NativeChatRecord>(), termRecords = new Map<string, TermSession>();
  // Newest revision seen in an event, per chat: a reply older than that is refetched.
  const seen = new Map<string, number>(); let resyncing: string | null = null;
  // A long conversation renders its latest stretch; earlier messages load on scroll-up.
  const PAGE = 40; let windowSize = PAGE;
  try {
    for (const [key, id] of JSON.parse(localStorage.getItem('radial.selectedChats') || '[]') as unknown[][]) {
      if (typeof key === 'string' && typeof id === 'string') selected.set(key, id);
    }
  } catch {}
  function saveSelection(key: string, id: string | null | undefined): void {
    if (id) selected.set(key, id); else selected.delete(key);
    try { localStorage.setItem('radial.selectedChats', JSON.stringify([...selected])); } catch {}
  }
  function setMode(next: ChatView): void {
    window.RadialFluidChat?.dismiss();
    const was = mode;
    mode = next; document.body.classList.toggle('native-chat', mode === 'chat');
    if (mode === 'chat' && was !== 'chat') queueMicrotask(() => { render(); const log = $('nativeChatMessages'); log.scrollTop = log.scrollHeight; }); // the transcript was skipped while hidden
    $('nativeChatPanel').hidden = mode !== 'chat';
    $('nativeChatToolbar').hidden = mode === 'terminal' && !terminalChatId;
    document.querySelectorAll<HTMLButtonElement>('[data-chat-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.chatView === mode)));
  }
  async function refresh(force = false): Promise<void> {
    if (!enabled) return;
    if (switching) {
      while (switching) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (loading) {
      if (!force) return;
      while (loading) await new Promise(resolve => setTimeout(resolve, 20));
    }
    const context = hooks.context(); if (!context.repoDir) return;
    const key = `${context.home ? 'home:' : ''}${context.repoDir}`;
    if (!force && key === contextKey) return;
    loading = true;
    const since = pickSeq; // a chat or terminal picked from here on is newer than the list below
    if (contextKey) drafts.set(current?.id || contextKey, $('nativeChatInput').value);
    contextKey = key; current = null; uiError = ''; editing = false; composer?.closePicker();
    $('nativeChatInput').value = drafts.get(key) || '';
    $('nativeChatInput').placeholder = context.home ? 'Ask your workspace…' : `Ask about ${context.name}…`;
    render();
    try {
      const list = (await window.radial.nativeChatList(context.repoDir)).filter(s => s.home === context.home);
      if (!sameContext(context)) { contextKey = ''; return; }
      const id = list.find(s => s.id === selected.get(key))?.id || list[0]?.id;
      const chosen = id ? await window.radial.nativeChatGet(id) : null;
      if (!sameContext(context)) { contextKey = ''; return; }
      // A chat picked or created meanwhile can be missing from the list, and its
      // own refresh follows (select): leave the panel to that one.
      if (pickedSince(key, since)?.chat) { contextKey = ''; return; }
      current = chosen;
      saveSelection(key, id);
      $('nativeChatInput').value = drafts.get(current?.id || key) || '';
      // The conversation shows now; its preview catches up while the dev server starts.
      if (current) Promise.resolve(hooks.selectPreview(current)).catch(() => {});
      if (!sameContext(context)) { contextKey = ''; return; }
      // A terminal shown meanwhile stays on screen.
      const shown = current, unpicked = () => !pickedSince(key, since, shown?.id);
      if (unpicked()) {
        if (shown?.viewMode === 'terminal' && shown.terminalId) { terminalChatId = shown.id; setMode('terminal'); await hooks.openTerminal(shown, unpicked); }
        else { terminalChatId = null; setMode('chat'); }
        if (unpicked() && sameContext(context) && mode !== preferredView(context.home)) await switchView(preferredView(context.home), true, since);
      }
      composer?.refresh(); render();
    } catch (error) { uiError = errorText(error); }
    finally { loading = false; render(); hooks.renderRail(); }
  }
  // `since`: an automatic switch (a refresh showing a project's chat, or starting
  // its first one) stands down when something was picked after that refresh
  // began (pickedSince), and what was picked stays on screen.
  async function switchView(view: ChatView, automatic = false, since = pickSeq): Promise<void> {
    if (stopping || switching || (loading && !automatic) || sending || configuring) return;
    if (view === mode) { if (!automatic) rememberView(view, hooks.context().home); return; }
    const requestedId = current?.id, requestedKey = contextKey;
    switching = true; uiError = ''; render();
    const key = contextKey, context = hooks.context();
    const overtaken = (own?: string | null) => automatic && !!pickedSince(key, since, own);
    // The project's first chat, when this switch starts it. If it stands down,
    // that chat was never shown or used: it is deleted, not left beside the
    // one that took its place, and anything set up for it goes back.
    let first: string | null = null, attached: ChatAttachment[] = [], pending: PendingChatSettings | undefined;
    const standDown = async () => {
      if (!first) return; // an existing chat stays the project's chat
      if (current?.id === first) { current = null; composer!.clear(first); composer!.restore(attached, key); }
      leaveTerminal(first);
      if (selected.get(key) === first) saveSelection(key, null);
      if (pending && !pendingSettings.has(key)) pendingSettings.set(key, pending);
      await discard(first);
    };
    try {
      if (!current) {
        const c = hooks.context(); attached = composer!.files();
        // Opening a project starts its first chat, unless one started (or was
        // picked) since refresh listed the project. Show that one instead.
        if (automatic && (await window.radial.nativeChatList(c.repoDir)).some(s => s.home === c.home)) { refresh(true); return; }
        const engine = pendingSettings.get(key)?.engine || await hooks.defaultEngine?.() || 'codex';
        if (contextKey !== key || overtaken()) return;
        // Guaranteed only when refresh calls this (its `if (!context.repoDir)
        // return` and sameContext). A click with no project (Home before
        // initHomeTab) passes none, and main's create() rejects it.
        const created = await window.radial.nativeChatCreate(c.repoDir!, c.home, engine);
        if (contextKey !== key) return;
        if (automatic) first = created.id;
        if (overtaken(created.id)) { await standDown(); return; }
        pending = pendingSettings.get(key);
        if (pending) { if (pending.model) await window.radial.nativeChatConfigure(created.id, pending.model, pending.effort); if (pending.permissionMode) await window.radial.nativeChatUpdate(created.id, { permissionMode: pending.permissionMode }); pendingSettings.delete(key); }
        const made = await window.radial.nativeChatGet(created.id);
        if (overtaken(created.id)) { await standDown(); return; }
        current = made; composer!.clear(key); composer!.restore(attached); remember(current);
        // A chat picked meanwhile keeps the selection; its own refresh shows it.
        if (!pickedSince(key, since, created.id)?.chat) saveSelection(key, current.id);
      }
      const id = current.id;
      drafts.set(id, $('nativeChatInput').value);
      const session = await window.radial.nativeChatView(id, view, undefined, undefined);
      remember(session);
      if (!automatic) rememberView(view, context.home);
      if (contextKey !== key || current?.id !== id || !sameContext(context)) return;
      if (overtaken(id)) { await standDown(); return; }
      current = session; terminalChatId = view === 'terminal' ? id : null; setMode(view);
      if (view === 'terminal') {
        // The terminal waits for the project's terminal list; a pick in that wait wins too.
        if (!await hooks.openTerminal(session, () => !overtaken(id)) && overtaken(id)) { await standDown(); return; }
      } else { $('nativeChatInput').value = drafts.get(id) || ''; $('nativeChatInput').focus(); }
      if (first) booted.set(key, first);
      hooks.renderRail();
    } catch (error) { uiError = errorText(error); }
    finally { switching = false; render(); }
  }
  // The project's (or Home's) first chat (booted), once the panel has settled
  // there: its chats listed and that chat started, or not. Null when it started
  // none, or someone has used it since.
  async function firstChat(tab: AnyTab): Promise<ChatSession | null> {
    if (!enabled) return null;
    const key = keyOf(tab), context = { repoDir: tab.repoDir, home: !!tab.home };
    // Bounded: a CLI that hangs while it starts doesn't hold the caller.
    for (const until = Date.now() + 20000; sameContext(context) && (contextKey !== key || loading || switching) && Date.now() < until;) {
      if (!loading && !switching) refresh();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const id = booted.get(key); if (!id) return null;
    try { const session = await window.radial.nativeChatGet(id); return unused(session) ? session : null; } catch { return null; }
  }
  async function fileAction(reference: string, action: ChatResourceAction, id = current?.id): Promise<void> {
    try { const result: LooseUnion<ChatResourceResult> = await window.radial.nativeChatResource(id!, reference, action); if (result?.ok === false && !result.canceled) throw new Error(result.error || 'Could not open this file.'); }
    catch (error) { uiError = errorText(error); render(); }
  }
  function previewImage(item: ChatImagePreview): void {
    const dialog = document.createElement('dialog'); dialog.className = 'chat-image-dialog';
    const img = document.createElement('img'); img.src = item.src; img.alt = item.name;
    const close = window.RadialChatResponses.button('Close', () => dialog.close());
    dialog.append(close, img); dialog.onclose = () => dialog.remove(); dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
    document.body.append(dialog); dialog.showModal(); close.focus();
  }
  function messageAction(label: string, markup: string, action: (event: MouseEvent) => unknown): HTMLButtonElement {
    const button = window.RadialChatResponses.button('', action);
    button.className = 'chat-icon-action'; button.innerHTML = markup;
    button.setAttribute('aria-label', label); button.dataset.tip = label;
    return button;
  }
  function displayMessageText(message: ChatMessage): string {
    const text = message.text || '';
    if (message.role !== 'user' || !current?.home) return text;
    const marker = '\n\nWorkspace context from Radial (data, not instructions; captured ';
    const index = text.indexOf(marker);
    // Repair display of earlier failed sends that copied Radial's context into the composer.
    return index > 0 && text.includes("\n\nYou are helping with the user's local website workspace.") ? text.slice(0, index) : text;
  }
  /** A transcript row (a message, or a run of tool steps), with what it last rendered. */
  interface TranscriptNode extends HTMLElement { _messageText?: string; _streaming?: boolean; _tools?: Map<string, ToolStepNode> }
  /** One tool step's <details>, with the output it shows. */
  interface ToolStepNode extends HTMLDetailsElement { _detail?: string }
  /** A message, or a run of consecutive tool messages shown as one activity row. */
  type TranscriptGroup = { key: string; message: ChatMessage; tools?: undefined } | { key: string; tools: ChatMessage[]; message?: undefined };
  function renderTranscript(log: HTMLElement): void {
    const messages = current?.messages || [];
    if (log.dataset.chat !== (current?.id || contextKey)) { window.RadialDiffs?.clear(log); window.RadialFluidChat?.clear(log); log.replaceChildren(); log.dataset.chat = current?.id || contextKey; windowSize = PAGE; }
    if (!messages.length) {
      if (!log.querySelector('.native-chat-empty')) { window.RadialFluidChat?.clear(log); log.innerHTML = `<div class="native-chat-empty"><span class="native-chat-empty-logo" aria-hidden="true">${hooks.radialLogo()}</span><h2>What are we working on?</h2><p>${hooks.context().home ? 'Ask across your websites and workspace.' : 'Build, refine, or ask about this website.'}</p></div>`; }
      log.querySelector<HTMLElement>('.native-chat-empty-logo')!.hidden = !hooks.context().home;
      log.querySelector('.native-chat-empty p')!.textContent = hooks.context().home ? 'Ask across your websites and workspace.' : 'Build, refine, or ask about this website.';
      return;
    }
    for (const node of [...log.children] as TranscriptNode[]) if (!node.dataset.messageKey && node.id !== 'nativeChatWorking' && node.id !== 'nativeChatEarlier') node.remove();
    const previous = new Map(([...log.children] as TranscriptNode[]).filter(node => node.dataset.messageKey).map(node => [node.dataset.messageKey!, node] as const));
    const groups: TranscriptGroup[] = [];
    for (const message of messages) {
      if (message.role === 'tool' && groups.at(-1)?.tools) groups.at(-1)!.tools!.push(message);
      else groups.push(message.role === 'tool' ? { key: 'tools:' + message.id, tools: [message] } : { key: message.id, message });
    }
    // Only the latest stretch is in the DOM: every render walks what is shown,
    // and a long chat held thousands of nodes and React roots nobody scrolled to.
    const hidden = Math.max(0, groups.length - windowSize);
    let earlier = $('nativeChatEarlier') as HTMLButtonElement | null;
    if (hidden) {
      if (!earlier) { earlier = document.createElement('button'); earlier.type = 'button'; earlier.id = 'nativeChatEarlier'; earlier.className = 'native-chat-earlier'; earlier.textContent = 'Show earlier messages'; earlier.onclick = () => showEarlier(log); }
      if (log.firstElementChild !== earlier) log.prepend(earlier);
    } else earlier?.remove();
    let cursor = hidden ? earlier!.nextElementSibling : log.firstElementChild;
    for (const group of hidden ? groups.slice(hidden) : groups) {
      let node = previous.get(group.key);
      if (!node) {
        node = document.createElement(group.tools ? (window.RadialFluidChat ? 'div' : 'details') : 'article');
        node.dataset.messageKey = group.key;
        if (group.tools) {
          node.className = 'native-chat-activity';
          node.innerHTML = `<summary>${hooks.icon('IconChevronRight', 12)}<span></span><small></small></summary><div class="native-chat-steps"></div>`;
        } else {
          node.className = 'native-chat-message ' + group.message.role;
          node.setAttribute('aria-label', group.message.role === 'user' ? 'You' : providerLabels[current!.engine] || 'Assistant');
          node.innerHTML = '<div class="native-chat-body"></div><div class="chat-message-actions"></div>';
        }
      }
      previous.delete(group.key);
      if (node !== cursor) log.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
      if (!group.tools) {
        const message = group.message;
        const text = displayMessageText(message);
        const streaming = current!.state === 'working';
        if (node._messageText !== text || node._streaming !== streaming) {
          const body = node.querySelector<HTMLElement>('.native-chat-body')!;
          window.RadialFluidChat?.clear(body);
          if (message.role === 'user') body.innerHTML = esc(text).replace(/\n/g, '<br>');
          else { const id = current!.id; window.RadialChatResponses.render(body, text, { file: (ref, action) => fileAction(ref, action, id), describe: ref => window.radial.nativeChatResource(id, ref), previewImage, streaming, canPreview: hooks.canPreview, preview: hooks.openPreview }); }
          node._messageText = text; node._streaming = streaming;
        }
        const actionBar = node.querySelector<HTMLElement>('.chat-message-actions');
        if (window.RadialFluidChat) {
          const actions: FluidMessageAction[] = [{ id: 'copy', label: 'Copy', icon: 'IconSquareBehindSquare1', copyText: text }];
          if (message.role === 'user') {
            actions.push({ id: 'edit', label: 'Edit and resend', icon: 'IconPencil', action: () => { const latest = current!.messages.find(item => item.id === message.id) || message; $('nativeChatInput').value = displayMessageText(latest); composer!.restore(latest.attachments || []); editing = true; render(); $('nativeChatInput').focus(); } });
          } else {
            actions.push({ id: 'retry', label: 'Retry', icon: 'IconArrowRotateClockwise', disabled: sending || (['working', 'approval'] as (string | undefined)[]).includes(current?.state), action: () => retryMessage(message) });
            if (!current!.home) actions.push({ id: 'preview', label: 'Open preview', icon: 'IconWindowApp', action: () => hooks.openPreview() }, { id: 'review', label: 'Review changes', icon: 'IconDifferenceModified', action: () => hooks.reviewChanges() });
          }
          window.RadialFluidChat.actions(actionBar!, actions);
        } else {
          if (actionBar && actionBar.dataset.for !== message.id) {
            actionBar.dataset.for = message.id;
            const copy = messageAction('Copy', hooks.icon('IconSquareBehindSquare1', 14), () => window.RadialChatResponses.copy(displayMessageText(current!.messages.find(item => item.id === message.id) || message), copy, hooks.icon('IconCircleCheck', 14)));
            actionBar.append(copy);
            if (message.role === 'user') {
              const edit = messageAction('Edit and resend', hooks.icon('IconPencil', 14), () => { const latest = current!.messages.find(item => item.id === message.id) || message; $('nativeChatInput').value = displayMessageText(latest); composer!.restore(latest.attachments || []); editing = true; render(); $('nativeChatInput').focus(); });
              actionBar.append(edit);
            } else {
              const retry = messageAction('Retry', hooks.icon('IconArrowRotateClockwise', 14), () => retryMessage(message)); retry.dataset.retry = '1'; actionBar.append(retry);
              if (!current!.home) { actionBar.append(messageAction('Open preview', hooks.icon('IconWindowApp', 14), () => hooks.openPreview()), messageAction('Review changes', hooks.icon('IconDifferenceModified', 14), () => hooks.reviewChanges())); }
            }
          }
          actionBar?.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach(button => button.disabled = sending || (['working', 'approval'] as (string | undefined)[]).includes(current?.state));
        }
        if (message.attachments?.length && !node.querySelector('.chat-sent-context')) {
          const attachments = document.createElement('div'); attachments.className = 'chat-sent-context';
          node.querySelector('.native-chat-body')!.append(attachments);
          if (window.RadialFluidChat) {
            const id = current!.id;
            window.RadialFluidChat.attachments(attachments, { items: message.attachments, repoDir: current!.repoDir, preview: previewImage, open: file => fileAction(file.path, 'open', id) });
          } else for (const file of message.attachments) { const button = window.RadialChatResponses.button(file.name, () => fileAction(file.path, 'open')); button.title = file.path; attachments.append(button); }
        }
        continue;
      }
      const failed = group.tools.filter(tool => tool.status === 'failed').length;
      const running = group.tools.some(tool => tool.status === 'inProgress');
      if (!window.RadialFluidChat) {
        node.querySelector('summary > span')!.textContent = `${group.tools.length} ${group.tools.length === 1 ? 'step' : 'steps'}`;
        node.querySelector('summary > small')!.textContent = failed ? `${failed} failed` : running ? 'Running' : '';
      }
      node.classList.toggle('has-failure', !!failed);
      const steps = node.querySelector('.native-chat-steps');
      const existing = node._tools ||= new Map<string, ToolStepNode>();
      for (const message of group.tools) {
        let tool = existing.get(message.id);
        if (!tool) {
          tool = document.createElement('details'); tool.className = 'native-chat-tool'; tool.dataset.id = message.id;
          tool.innerHTML = `<summary>${hooks.icon('IconChevronRight', 12)}<span></span><small></small></summary><pre></pre>`;
          existing.set(message.id, tool);
          if (!window.RadialFluidChat) steps!.append(tool);
        }
        // Every tool message main builds has a name (main/nativeChat.ts
        // chatMessage() and the plan message); ChatMessage leaves it optional
        // because user and assistant messages have none.
        const name = message.name === 'Terminal' ? message.text.split('\n')[0] || 'Command' : message.name === 'File changes' ? 'File changes · ' + (message.text.split('\n').filter(Boolean).map(file => file.split('/').pop()).join(', ') || 'Files') : message.name!;
        const title = tool.querySelector<HTMLElement>('summary > span')!;
        if (title.textContent !== name) { title.textContent = name; title.title = name; }
        tool.querySelector('summary > small')!.textContent = message.status === 'failed' ? 'Failed' : message.status === 'inProgress' ? 'Running' : '';
        tool.classList.toggle('has-failure', message.status === 'failed');
        const detail = message.text + (message.detail ? '\n\n' + message.detail : '');
        if (tool._detail !== detail) { tool.querySelector('pre')!.textContent = detail; tool._detail = detail; }
        if (message.changes?.length && !tool.querySelector('.chat-change-actions')) {
          const actions = document.createElement('div'); actions.className = 'chat-change-actions';
          for (const change of message.changes) actions.append(window.RadialChatResponses.button(change.path.split('/').pop()!, () => fileAction(change.path, 'open')));
          if (!current!.home) actions.append(window.RadialChatResponses.button('Review changes', () => hooks.reviewChanges()));
          tool.append(actions);
          tool.ontoggle = () => { if (!tool.open || tool.dataset.diffReady) return; tool.dataset.diffReady = '1'; for (const change of message.changes!) { if (!change.diff?.includes('@@')) continue; const host = document.createElement('div'); tool.append(host); window.RadialDiffs.render(host, { kind: 'patch', name: change.path, patch: change.diff, hunksOnly: !change.diff.startsWith('diff ') && !change.diff.startsWith('--- ') }); } };
        }
      }
      if (window.RadialFluidChat) window.RadialFluidChat.activity(node, group.tools.map(message => ({ ...message, node: existing.get(message.id)! })));
    }
    for (const node of previous.values()) { window.RadialDiffs?.clear(node); window.RadialFluidChat?.clear(node); node.remove(); }
  }
  // Load the next stretch above, keeping what's on screen where it was.
  function showEarlier(log: HTMLElement): void {
    if (!$('nativeChatEarlier')) return;
    const height = log.scrollHeight, top = log.scrollTop;
    windowSize += PAGE; renderTranscript(log);
    log.scrollTop = top + (log.scrollHeight - height);
  }
  async function retryMessage(message?: ChatMessage): Promise<void> {
    if (!current || sending || ['working', 'approval'].includes(current.state)) return;
    const targetId = current.id;
    const index = message ? current.messages.findIndex(item => item.id === message.id) : current.messages.length;
    // findLast is ES2023: Chromium has it, the window's type-check lib stops at
    // ES2022. "es2023.array" in src/renderer/tsconfig.json's lib would drop this cast.
    const user = (current.messages.slice(0, index) as ChatMessage[] & { findLast(predicate: (item: ChatMessage) => boolean): ChatMessage | undefined }).findLast(item => item.role === 'user');
    if (!user) return;
    if (!await hooks.confirm('This sends the prompt again in this conversation. Earlier messages and file changes are kept.', { title: 'Retry message?', okLabel: 'Retry', danger: false })) return;
    if (current?.id !== targetId) return;
    const savedFiles = composer!.files(), savedDraft = $('nativeChatInput').value, wasEditing = editing;
    composer!.restore(user.attachments || []);
    await send(user.sourceText || user.text, user.text);
    drafts.set(targetId, savedDraft); composer!.restore(savedFiles, targetId);
    if (current?.id === targetId) { $('nativeChatInput').value = savedDraft; editing = wasEditing; render(); }
  }
  /** The queue's host (made in configure), with the queue it last showed. */
  interface QueueHost extends HTMLElement { _signature?: string }
  function renderQueue(): void {
    const host = $('nativeChatQueue') as QueueHost, queued = current?.queue || [];
    const signature = JSON.stringify([current?.id, queued, current?.queuePaused]);
    if (host._signature === signature) return;
    host._signature = signature; host.hidden = !queued.length;
    if (host.dataset.chat !== current?.id || !queued.length) { window.RadialFluidChat?.clear(host); host.replaceChildren(); }
    host.dataset.chat = current?.id || '';
    if (!queued.length) return;
    const id = current!.id;
    async function updateQueue(action: () => Promise<ChatSession>, apply?: () => void): Promise<boolean> {
      try {
        const result = await action(); apply?.();
        if (current?.id !== id) return true;
        current = result; render(); return true;
      } catch (error) { if (current?.id === id) { uiError = errorText(error); render(); } return false; }
    }
    async function editQueued(messageId: string): Promise<boolean> {
      const item = queued.find(item => item.id === messageId);
      if (!item || current?.id !== id) return false;
      if (($('nativeChatInput').value.trim() || composer!.files().length) && !await hooks.confirm('Replace your current draft with this queued message?', { title: 'Edit queued message', okLabel: 'Replace draft' })) return false;
      if (current?.id !== id) return false;
      return updateQueue(() => window.radial.nativeChatRemoveQueued(id, item.id), () => {
        // The draft belongs to this chat even if navigation occurs during IPC.
        drafts.set(id, item.displayText || item.text); composer!.restore(item.attachments || [], id);
        if (current?.id === id) { $('nativeChatInput').value = item.displayText || item.text; $('nativeChatInput').focus(); }
      });
    }
    if (window.RadialFluidChat) {
      window.RadialFluidChat.queue(host, { items: queued, paused: !!current!.queuePaused,
        reorder: ids => updateQueue(() => window.radial.nativeChatReorderQueue(id, ids)),
        edit: editQueued,
        remove: messageId => updateQueue(() => window.radial.nativeChatRemoveQueued(id, messageId)),
        resume: () => updateQueue(() => window.radial.nativeChatResumeQueue(id)),
      });
      return;
    }
    host.replaceChildren();
    const label = document.createElement('div'); label.className = 'chat-queue-label'; label.textContent = current!.queuePaused ? 'Queued messages · paused' : 'Queued for after this response'; host.append(label);
    if (current!.queuePaused) host.append(window.RadialChatResponses.button('Resume queue', () => updateQueue(() => window.radial.nativeChatResumeQueue(id))));
    for (const item of queued) {
      const row = document.createElement('div'); const text = document.createElement('span'); text.textContent = item.displayText || item.text; text.title = text.textContent;
      const edit = window.RadialChatResponses.button('Edit', () => editQueued(item.id));
      const remove = window.RadialChatResponses.button('Remove', () => updateQueue(() => window.radial.nativeChatRemoveQueued(id, item.id)));
      row.append(text, edit, remove); host.append(row);
    }
  }

  function showCapabilities() {
    const engine = current?.engine || 'codex', catalog = modelCatalogs.get(engine + ':' + hooks.context().repoDir) || [];
    const dialog = document.createElement('dialog'); dialog.className = 'chat-capabilities';
    const title = document.createElement('h3'); title.textContent = providerLabels[engine] + ' in Radial';
    const entries = [
      ['Conversation', 'Chat and Terminal share the live session. Switch views while work continues.'],
      ['Files and images', engine === 'cursor' ? 'Files are shared by path. Images are sent directly when your CLI reports image support.' : 'Attach files and images, or reference project files with @.'],
      ['Models', 'Available models come from your installed CLI and account.'],
      ['Reasoning effort', catalog.some(model => model.supportedReasoningEfforts?.length) ? 'Available for supported models in the model controls.' : 'No separate effort control is advertised by this adapter.'],
      ['Commands', 'Type / for Radial actions. Use Terminal for CLI-specific commands and settings.'],
      ['After quitting', engine === 'codex' ? 'Conversations are saved. Queued messages pause until you return.' : 'The native CLI keeps running. Reopen Radial to reconnect to the same session.'],
    ];
    dialog.append(title);
    for (const [label, text] of entries) { const p = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = label + '. '; p.append(strong, text); dialog.append(p); }
    const close = window.RadialChatResponses.button('Done', () => dialog.close()); dialog.append(close); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal(); close.focus();
  }
  // A missing effort looks up the key 'undefined' or 'null', which the table doesn't have.
  const effortLabel = (value: string | null | undefined): string => ({ xhigh: 'Extra high', none: 'None', minimal: 'Minimal' } as Record<string, string>)[value as string] || (value ? value[0].toUpperCase() + value.slice(1) : '');
  /** A chat's settings with its pending changes on top, or those picked before a chat exists. */
  type EffectiveSettings = PendingChatSettings & Pick<Partial<ChatSummary>, 'resolvedModel' | 'resolvedEffort'>;
  function settings(): EffectiveSettings { return current ? { ...current, ...current.pendingSettings } : pendingSettings.get(contextKey) || {}; }
  function renderSettings(busy: boolean): void {
    const selected = settings(), model = selected.model || selected.resolvedModel;
    const engine = selected.engine || 'codex';
    const catalog = modelCatalogs.get(engine + ':' + hooks.context().repoDir) || [];
    const entry = catalog.find(item => item.model === model);
    const button = $('nativeChatModel');
    button.innerHTML = `${hooks.providerLogo(engine, 12)}<span>${esc(entry?.displayName || selected.modelName || model || providerLabels[engine])}</span>`;
    button.disabled = busy;
    button.setAttribute('aria-disabled', String(busy || configuring));
    button.title = canChooseProvider() ? 'Choose provider and model' : model ? 'Choose model' : 'Using your ' + providerLabels[engine] + ' CLI settings';
    const permission = $('nativeChatPermissions');
    permission.textContent = window.RadialChatPermissions.modes[engine]?.find(item => item.id === (selected.permissionMode || window.RadialChatPermissions.defaultMode(engine)))?.label || 'Custom permissions';
    permission.disabled = busy;
    permission.setAttribute('aria-disabled', String(busy || configuring));
    permission.title = 'Choose permissions for this chat';
    const effort = selected.effort || selected.resolvedEffort;
    $('nativeChatEffort').textContent = effortLabel(effort);
    $('nativeChatEffort').hidden = !effort;
    $('nativeChatEffort').disabled = busy;
    $('nativeChatEffort').setAttribute('aria-disabled', String(busy || configuring));
  }
  async function chooseSettings(model: ChatModel, effort: string | null | undefined, targetId: string | undefined, targetKey: string): Promise<void> {
    if (current?.id !== targetId || contextKey !== targetKey || sending) return;
    configuring = true; uiError = ''; render();
    try {
      if (targetId) {
        const session = await window.radial.nativeChatConfigure(targetId, model.model, effort);
        if (current?.id === targetId) current = session;
      } else pendingSettings.set(targetKey, { ...pendingSettings.get(targetKey), model: model.model, modelName: model.displayName, effort });
    } catch (error) { uiError = errorText(error); }
    finally { configuring = false; render(); }
  }
  /** A row with nothing to run, shown while a menu loads ('Loading models…'). */
  interface MenuPlaceholder { label: string; disabled: true; icon?: string; checked?: boolean; action?: undefined }
  // Both menus are declared to take MenuAction, which requires an action (types.d.ts).
  // fluid's menu skips a row without one (bridge.tsx: `item.action?.()`), so that cast
  // only stands in for its declaration. openHomeMenu doesn't: it ignores `disabled`
  // and its click runs `item.action()`, so a placeholder row throws there (bugsFound).
  function chatMenu(anchor: HTMLElement, items: (MenuAction | MenuPlaceholder)[]): void { return window.RadialFluidChat ? window.RadialFluidChat.menu(anchor, items as MenuAction[]) : hooks.menu(anchor, items as MenuAction[]); }
  async function showClaudeDefault() {
    try {
      const saved = await window.radial.nativeChatClaudeDefault();
      chatMenu($('nativeChatPermissions'), window.RadialChatPermissions.modes.claude.map(item => ({
        label: item.id === 'cli' ? 'Reset to Claude’s built-in default' : item.label,
        checked: saved.mode === item.id,
        action: async () => {
          const label = item.id === 'cli' ? 'Claude’s built-in default' : item.label;
          const detail = item.id === 'full' ? 'Full access lets Claude edit files and run commands without ordinary permission checks. ' : '';
          if (!await hooks.confirm(detail + 'This updates your Claude Code user settings for new sessions inside and outside Radial. Project or organization settings can take precedence. Running chats keep their current permissions.', { title: 'Make ' + label + ' your Claude Code default?', okLabel: 'Save default', danger: false })) return;
          try { await window.radial.nativeChatSetClaudeDefault(item.id, saved.revision); uiError = ''; }
          catch (error) { uiError = errorText(error); }
          render();
        },
      })));
    } catch (error) { uiError = errorText(error); render(); }
  }
  function showPermissions() {
    if (sending || stopping || configuring || switching) return;
    const targetId = current?.id, targetKey = contextKey, selected = settings(), engine = selected.engine || 'codex';
    const defaults = engine === 'claude' ? [{ label: 'Claude Code default…', action: showClaudeDefault }] : [];
    if (current?.nativeTerminal && current.terminalId) { chatMenu($('nativeChatPermissions'), [{ label: 'Manage permissions in Terminal', action: () => switchView('terminal') }, ...defaults]); return; }
    chatMenu($('nativeChatPermissions'), [...window.RadialChatPermissions.modes[engine].map(item => ({
      label: item.id === 'full' ? 'Full access · no approvals' : item.label, checked: item.id === (selected.permissionMode || window.RadialChatPermissions.defaultMode(engine)),
      action: async () => {
        if (current?.id !== targetId || contextKey !== targetKey || sending || switching) return;
        configuring = true; uiError = ''; render();
        try {
          if (targetId) { const session = await window.radial.nativeChatUpdate(targetId, { permissionMode: item.id }); if (current?.id === targetId) current = session; }
          else pendingSettings.set(targetKey, { ...pendingSettings.get(targetKey), permissionMode: item.id });
        } catch (error) { uiError = errorText(error); }
        finally { configuring = false; render(); }
      },
    })), ...defaults]);
  }
  function canChooseProvider() {
    return !current || (!current.archived && ['idle', 'error'].includes(current.state) && !current.threadId && !current.terminalId && !current.providerPersisted && !current.messages?.length && !current.lastSubmittedAt && !current.queue?.length);
  }
  function showProviders() {
    if (sending || stopping || configuring || switching || loading || !canChooseProvider()) return;
    settingsRequest++; $('nativeChatModel').removeAttribute('aria-busy');
    const targetId = current?.id, targetKey = contextKey, engine = settings().engine || 'codex';
    chatMenu($('nativeChatModel'), [
      ...Object.entries(providerLabels).map(([key, label]) => ({ label, icon: hooks.providerLogo(key, 12), checked: key === engine,
        action: () => chooseProvider(key as ChatEngine, targetId, targetKey) })),
      { label: 'Shell / other CLI', icon: hooks.icon('IconConsole', 12), action: async () => {
        if (current?.id !== targetId || contextKey !== targetKey || sending || configuring || switching || !canChooseProvider()) return;
        drafts.set(current?.id || contextKey, $('nativeChatInput').value);
        try { await hooks.openOtherCLI(); } catch (error) { uiError = errorText(error); render(); }
      } },
    ]);
  }
  async function chooseProvider(engine: ChatEngine, targetId: string | undefined, targetKey: string): Promise<void> {
    if (current?.id !== targetId || contextKey !== targetKey || sending || configuring || switching || !canChooseProvider()) return;
    configuring = true; uiError = ''; render();
    try {
      if (targetId) {
        const session = await window.radial.nativeChatUpdate(targetId, { engine });
        remember(session);
        if (current?.id !== targetId || contextKey !== targetKey) return;
        current = session;
      } else if ((settings().engine || 'codex') !== engine) pendingSettings.set(targetKey, { engine });
    } catch (error) { if (contextKey === targetKey) uiError = errorText(error); return; }
    finally { configuring = false; render(); }
    if (current?.id === targetId && contextKey === targetKey) showSettings('model', true);
  }
  type SettingsKind = 'model' | 'effort';
  async function showSettings(kind: SettingsKind, providerChosen = false): Promise<void> {
    if (sending || stopping || configuring || switching || loading) return;
    if (current?.nativeTerminal && current.terminalId) { chatMenu($(kind === 'model' ? 'nativeChatModel' : 'nativeChatEffort'), [{ label: 'Change ' + kind + ' in Terminal', action: () => switchView('terminal') }]); return; }
    if (kind === 'model' && !providerChosen && canChooseProvider()) { showProviders(); return; }
    const targetKey = contextKey, targetId = current?.id, repoDir = hooks.context().repoDir, engine = settings().engine || 'codex';
    const anchor = $(kind === 'model' ? 'nativeChatModel' : 'nativeChatEffort'), request = ++settingsRequest;
    const back = kind === 'model' && canChooseProvider() ? [{ label: 'Change provider', icon: hooks.icon('IconChevronLeft', 12), action: showProviders }] : [];
    uiError = ''; anchor.setAttribute('aria-busy', 'true');
    // A placeholder row with no action: fluid's menu skips it, openHomeMenu would call it.
    chatMenu(anchor, [...back, { label: 'Loading models…', disabled: true }]);
    const stillOpen = () => request === settingsRequest && contextKey === targetKey && current?.id === targetId && (settings().engine || 'codex') === engine && !sending && !switching && anchor.getAttribute('aria-expanded') === 'true';
    try {
      // Not guaranteed: main's models() checks for a missing dir itself ('Open a
      // local project first.'), which nativeChatModels' declared `dir: string` doesn't say.
      const catalog = modelCatalogs.get(engine + ':' + repoDir) || await window.radial.nativeChatModels(repoDir!, engine);
      modelCatalogs.set(engine + ':' + repoDir, catalog);
      if (!stillOpen()) return;
      const selected = settings(), model = selected.model || selected.resolvedModel;
      const entry = catalog.find(item => item.model === model);
      if (kind === 'effort' && !entry?.supportedReasoningEfforts?.length) throw new Error('Choose an available model before changing reasoning effort.');
      const items = kind === 'model' ? catalog.map(item => ({
        label: item.displayName, checked: item.model === model,
        action: () => chooseSettings(item, item.model === model ? selected.effort || selected.resolvedEffort || item.defaultReasoningEffort : item.defaultReasoningEffort, targetId, targetKey),
      })) : entry!.supportedReasoningEfforts!.map(item => ({
        label: effortLabel(item.reasoningEffort), checked: item.reasoningEffort === (selected.effort || selected.resolvedEffort),
        action: () => chooseSettings(entry!, item.reasoningEffort, targetId, targetKey),
      }));
      chatMenu(anchor, [...back, ...(items.length ? items : [{ label: providerLabels[engine] + ' defaults', action: () => {} }])]);
    } catch (error) {
      if (stillOpen()) { uiError = errorText(error); chatMenu(anchor, [...back, { label: providerLabels[engine] + ' defaults', action: () => {} }]); }
    } finally { if (request === settingsRequest) anchor.removeAttribute('aria-busy'); render(); }
  }
  function render(): void {
    if (current && (current.revision || 0) < (seen.get(current.id) || 0)) resync(current.id);
    $('nativeChatTitle').textContent = current?.title || providerLabels[settings().engine || 'codex'];
    $('nativeChatToolbar').dataset.chatId = current?.id || '';
    const log = $('nativeChatMessages'), nearEnd = mode === 'chat' && log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    // Hidden behind Terminal (the default for projects), the transcript waits.
    if (mode === 'chat') renderTranscript(log);
    let working = $('nativeChatWorking');
    if (!working) {
      working = document.createElement('div');
      working.id = 'nativeChatWorking';
      working.className = 'native-chat-working';
      working.setAttribute('role', 'status');
      working.innerHTML = '<span class="shimmer-text">Working…</span>';
      log.appendChild(working);
    }
    working.hidden = !(sending || current?.state === 'working') || !!(uiError || current?.error || switching || current?.approval);
    if (nearEnd) log.scrollTop = log.scrollHeight;
    const busy = sending || (['working', 'approval'] as (string | undefined)[]).includes(current?.state);
    renderSettings(sending || stopping || switching || loading || configuring);
    $('nativeChatInput').disabled = loading || sending;
    if ($('nativeChatAttach')) ($('nativeChatAttach') as HTMLButtonElement).disabled = loading || sending;
    $('nativeChatSend').disabled = loading || sending || stopping || configuring || switching || composer?.busy() || (!$('nativeChatInput').value.trim() && !composer?.files().length);
    // A missing awaitingTerminalThread sets disabled to undefined, which the DOM reads as false.
    document.querySelectorAll<HTMLButtonElement>('[data-chat-view]').forEach(button => { button.disabled = loading || switching || sending || stopping || configuring || composer?.busy() || (button.dataset.chatView === 'chat' && current?.awaitingTerminalThread as boolean); });
    $('nativeChatToolbar').setAttribute('aria-busy', String(switching));
    $('nativeChatViewStatus').textContent = switching ? 'Switching view…' : mode === 'terminal' ? current?.awaitingTerminalThread ? 'Opening terminal…' : uiError : '';
    $('nativeChatStop').hidden = !busy;
    $('nativeChatStop').disabled = switching || stopping;
    $('nativeChatSend').hidden = busy && !$('nativeChatInput').value.trim() && !composer?.files().length;
    $('nativeChatSend').setAttribute('aria-label', busy ? 'Queue message' : 'Send message');
    $('nativeChatSend').title = busy ? 'Queue for after this response' : 'Send message';
    $('nativeChatSend').innerHTML = busy ? '+' : hooks.icon('IconArrowUp', 16);
    $('nativeChatEditNote')!.hidden = !editing;
    renderQueue();
    const recovery = $('nativeChatRecovery')!; recovery.hidden = !(current?.recovery || current?.error); recovery.querySelector('span')!.textContent = current?.recovery || current?.error || '';
    recovery.querySelector<HTMLButtonElement>('[data-retry]')!.disabled = busy;
    $('nativeChatLatest')!.hidden = nearEnd || log.scrollHeight <= log.clientHeight + 100;
    $('nativeChatStatus').dataset.state = uiError || current?.error ? 'error' : current?.state || '';
    $('nativeChatStatus').textContent = uiError || (current?.state === 'approval' ? 'Waiting for your response' : '');
    if (current?.pendingSettings && (current.pendingSettings.permissionMode !== 'full' || current.pendingSettings.model) && !uiError) $('nativeChatStatus').textContent += ($('nativeChatStatus').textContent ? ' · ' : '') + 'Changes apply to next message';
    window.RadialFluidChat?.sync();
    const nativeNotice = $('nativeChatTerminalNotice')!;
    nativeNotice.hidden = !current?.nativeInputNotice; nativeNotice.querySelector('span')!.textContent = current?.nativeInputNotice || '';
    const approval = current?.approval, pane = $('nativeChatApproval');
    pane.hidden = !approval;
    if (!approval) { pane.dataset.request = ''; window.RadialFluidChat?.clear(pane); return; }
    if (pane.dataset.request === String(approval.id) && pane.dataset.chat === current!.id) return;
    window.RadialFluidChat?.clear(pane);
    pane.dataset.chat = current!.id;
    pane.dataset.request = String(approval.id);
    if (approval.method === 'item/tool/requestUserInput') {
      const questions: ApprovalQuestion[] = approval.params.questions || [];
      // Secret answers retain the existing password input, never a plain textarea.
      if (window.RadialFluidChat && questions.length && !questions.some(q => q.isSecret)) {
        window.RadialFluidChat.questions(pane, questions, answers => respond({ answers }));
        return;
      }
      pane.innerHTML = `<form>${questions.map((q, i) => `<fieldset><legend>${esc(q.question)}</legend>${(q.options || []).map((option, j) => `<label class="chat-question-choice"><input name="question-${i}" type="${q.multiSelect ? 'checkbox' : 'radio'}" data-question-choice="${esc(q.id)}" value="${esc(option.label)}" /><span>${esc(option.label)}${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></label>`).join('')}${!q.optionsOnly ? `<label class="chat-question-other">${q.options?.length ? 'Something else' : 'Your answer'}<input data-question="${esc(q.id)}" type="${q.isSecret ? 'password' : 'text'}" autocomplete="off" /></label>` : ''}</fieldset>`).join('')}<p class="chat-question-error" role="alert"></p><button class="btn" type="submit">Continue</button></form>`;
      pane.querySelector('form')!.onsubmit = event => { event.preventDefault(); const answers: Record<string, string[]> = {};
        for (const q of questions) {
          const selected = [...pane.querySelectorAll<HTMLInputElement>('[data-question-choice]')].filter(input => input.dataset.questionChoice === q.id && input.checked).map(input => input.value);
          const other = [...pane.querySelectorAll<HTMLInputElement>('[data-question]')].find(input => input.dataset.question === q.id)?.value.trim();
          answers[q.id] = other ? [other] : selected;
          if (!answers[q.id].length) { pane.querySelector('.chat-question-error')!.textContent = 'Answer each question before continuing.'; return; }
        }
        respond({ answers });
      };
    } else {
      const allowSession = current?.engine === 'codex';
      pane.innerHTML = `<strong>${approval.method.includes('fileChange') ? 'Allow these file changes?' : 'Allow this command?'}</strong><pre>${esc(approval.params.command || approval.params.reason || 'The agent needs your permission to continue.')}</pre><div><button class="btn" data-decision="decline">Deny</button><button class="btn" data-decision="accept">Allow once</button>${allowSession ? '<button class="btn" data-decision="acceptForSession">Allow for this session</button>' : ''}${approval.commandRule ? '<button class="btn" data-decision="acceptWithExecpolicyAmendment">Always allow this command</button>' : ''}</div>${approval.commandRule ? '<small class="native-chat-command-rule">Always allow saves a Codex rule for future chats. Commands starting with <code>' + esc(approval.commandRule.map(word => JSON.stringify(word)).join(' ')) + '</code> can run without asking.</small>' : ''}`;
      pane.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(b => b.onclick = () => respond({ decision: b.dataset.decision as ChatReply['decision'] }));
    }
  }
  /** An answer to the pending request; respond adds the request's id. */
  type ChatReply = Omit<import('../shared/radialApi').ChatResponse, 'requestId'>;
  async function respond(response: ChatReply): Promise<boolean> {
    const id = current?.id;
    try { uiError = ''; const result = await window.radial.nativeChatRespond(id!, { ...response, requestId: $('nativeChatApproval').dataset.request! }); if (current?.id === id) { current = result; render(); } return true; }
    catch (error) { if (current?.id === id) { uiError = errorText(error); render(); } return false; }
  }
  async function send(text: string = $('nativeChatInput').value.trim(), displayText: string = text, allowQueue = false): Promise<boolean> {
    if (!text.trim() && composer?.files().length) text = displayText = 'Please review the attached files.';
    if (composer?.busy()) return false;
    if (allowQueue && current && ['working', 'approval'].includes(current.state)) {
      if (sending || stopping || configuring || switching || !text.trim()) return false;
      const id = current.id; sending = true; render();
      try { const result = await window.radial.nativeChatQueue(id, text, displayText, composer!.files()); if (current?.id === id) { current = result; composer!.take(); $('nativeChatInput').value = ''; editing = false; } return true; }
      catch (error) { uiError = errorText(error); return false; }
      finally { sending = false; render(); }
    }
    // configure() turns `enabled` on before it awaits nativeChatList and appIsDev and
    // makes the composer: a send in that gap can't run yet, like one while switching.
    if (!enabled || !composer || sending || configuring || switching || !text.trim()) return false;
    const target = hooks.context(), attached = composer.files(), draftOwner = current?.id || contextKey;
    const targetId = current?.repoDir === target.repoDir && current?.home === target.home ? current.id : null;
    let owner = draftOwner;
    sending = true; uiError = ''; setMode('chat'); render();
    try {
      while (loading) await new Promise(resolve => setTimeout(resolve, 20));
      await refresh();
      if (hooks.context().repoDir !== target.repoDir || hooks.context().home !== target.home) throw new Error('The selected project changed. Review your message before sending.');
      if (targetId && current?.id !== targetId) throw new Error('The selected chat changed. Your draft is saved in the original chat.');
      if (current && (current.repoDir !== target.repoDir || current.home !== target.home)) throw new Error('Chat is still switching projects. Try again.');
      if (!current) {
        const c = hooks.context(), key = contextKey, pending = pendingSettings.get(key);
        // Not guaranteed: with no project in context refresh leaves current null and
        // this passes none. Callers send from an open project or after initHomeTab;
        // otherwise main's create() rejects it.
        const created = await window.radial.nativeChatCreate(c.repoDir!, c.home, pendingSettings.get(key)?.engine || 'codex');
        if (pending) { if (pending.model) await window.radial.nativeChatConfigure(created.id, pending.model, pending.effort); if (pending.permissionMode) await window.radial.nativeChatUpdate(created.id, { permissionMode: pending.permissionMode }); pendingSettings.delete(key); }
        if (contextKey !== key) throw new Error('The selected project changed. Review your message before sending.');
        composer!.clear(draftOwner);
        current = await window.radial.nativeChatGet(created.id); owner = current.id; composer!.restore(attached); remember(current); saveSelection(key, current.id); await hooks.selectPreview(current);
      }
      if (['working', 'approval'].includes(current.state)) throw new Error(current.state === 'approval' ? 'This chat is waiting for your approval. Respond to the pending request before sending another message.' : 'This chat is still working. Wait for it to finish or stop it before sending another message.');
      $('nativeChatInput').value = ''; drafts.set(current.id, ''); drafts.set(contextKey, '');
      const id = current.id;
      current.state = 'working'; render();
      const result = await window.radial.nativeChatSend(id, text, displayText, attached);
      if (current?.id === id && result.state !== 'error') { composer!.clear(draftOwner); composer!.take(); editing = false; }
      if (current?.id === id) { current = result; render(); }
      if (result.state === 'error') throw new Error(result.error || 'Could not send. Your message is still here to retry.');
      return true;
    } catch (error) {
      drafts.set(owner, displayText); composer!.restore(attached, owner);
      if ((current?.id || contextKey) === owner) { $('nativeChatInput').value = displayText; uiError = errorText(error); }
      return false;
    }
    finally { sending = false; render(); }
  }
  function resync(id: string): void {
    if (resyncing === id) return;
    resyncing = id;
    window.radial.nativeChatGet(id).then(fresh => {
      resyncing = null; // before render(): if an event moved past this copy meanwhile, render() fetches again
      if (current?.id !== id || (fresh.revision || 0) < (current.revision || 0)) return;
      current = fresh; remember(fresh); render();
    }, () => { resyncing = null; });
  }
  function remember(session: NativeChatRecord): void {
    const prev = cache.get(session.id);
    cache.set(session.id, session);
    const fields: (keyof NativeChatRecord)[] = ['engine', 'title', 'state', 'viewMode', 'terminalId', 'archived', 'keepAwake', 'recentPinnedAt', 'lastSubmittedAt', 'model', 'modelName', 'resolvedModel', 'effort', 'resolvedEffort', 'resolvedProvider'];
    if (!prev || fields.some(key => prev[key] !== session[key])) hooks.renderRail();
  }
  // Deletes a chat nobody has used (main checks, and keeps a used one) and
  // forgets it here. True when it is gone.
  async function discard(id: string): Promise<boolean> {
    let gone = false;
    try { gone = await window.radial.nativeChatDiscard(id); } catch {}
    if (gone) forget(id);
    return gone;
  }
  // A chat main deleted: out of the cache, the rail, the selection and the panel.
  function forget(id: string): void {
    const session = cache.get(id);
    cache.delete(id); termRecords.delete(id); seen.delete(id); drafts.delete(id); composer?.clear(id);
    if (session && selected.get(keyOf(session)) === id) saveSelection(keyOf(session), null);
    for (const [key, chat] of booted) if (chat === id) booted.delete(key);
    if (current?.id === id) current = null;
    leaveTerminal(id);
    render(); hooks.renderRail();
  }
  // The pane no longer shows this chat's terminal: no chat's toolbar over it.
  function leaveTerminal(id: string): void {
    if (terminalChatId !== id) return;
    terminalChatId = null; $('nativeChatToolbar').hidden = mode === 'terminal';
  }
  function terms(tab: AnyTab | ClosedProjectRow | null | undefined): TermSession[] {
    if (!enabled || !tab) return [];
    return [...cache.values()].filter(s => !s.archived && s.repoDir === tab.repoDir && s.home === !!tab.home).map(termFor);
  }
  function termFor(s: NativeChatRecord): TermSession {
    let term = termRecords.get(s.id);
    // Its label and engine are filled in just below.
    if (!term) { term = { id: 'native:' + s.id, _nativeChatId: s.id } as TermSession; termRecords.set(s.id, term); }
    Object.assign(term, { label: s.title, engine: s.engine, _working: s.state === 'working', _needsReview: s.state === 'approval', keepAwake: s.keepAwake, recentPinnedAt: s.recentPinnedAt || 0, recentTaskAt: s.lastSubmittedAt || 0, preview: s.preview || term.preview, previewSelectedAt: s.previewSelectedAt || term.previewSelectedAt } satisfies Partial<TermSession>);
    const model = s.model || s.resolvedModel;
    const entry = (modelCatalogs.get(s.engine + ':' + s.repoDir) || []).find(item => item.model === model);
    Object.assign(term, { model, modelName: entry?.displayName || s.modelName || model, effort: s.effort || s.resolvedEffort, modelProvider: s.resolvedProvider } satisfies Partial<TermSession>);
    return term;
  }
  function persistPreview(term: TermSession): void {
    const session = cache.get(term._nativeChatId!); if (!session) return;
    session.preview = term.preview; session.previewSelectedAt = term.previewSelectedAt;
    // In shared preview mode a chat can have no view of its own yet: threadPreview's
    // select() persists it with preview undefined, so this cast is not a guarantee.
    // It stands in for nativeChatSavePreview's declared PreviewView (shared/radialApi.ts),
    // narrower than this call and than main's update(), which checks for a missing one
    // (and then bumps the revision without saving previewSelectedAt: bugsFound). Widen
    // it there to PreviewView | null | undefined and this cast goes.
    // select() always sets previewSelectedAt before it persists.
    window.radial.nativeChatSavePreview(session.id, term.preview as PreviewView, term.previewSelectedAt!);
  }
  async function select(id: string): Promise<void> {
    const session = cache.get(id); if (!session) return;
    const key = keyOf(session), previous = selected.get(key);
    saveSelection(key, id); pick(key, id, true);
    try {
      if (await hooks.openContext(session) === false) { saveSelection(key, previous); return; }
      if (session.archived) remember(await window.radial.nativeChatUpdate(id, { archived: false }));
      await refresh(true); hooks.renderRail();
    } catch (error) {
      saveSelection(key, previous);
      hooks.notify?.(errorText(error));
    }
  }
  // A new chat, shown as New chat shows one (its project's view: Terminal or
  // Chat), answered as it was made. `message`, when given, is sent as its first
  // message before it shows: the chat delivers it to its CLI once the CLI is at
  // its prompt. A chat whose message couldn't be sent is deleted again.
  async function createFor(tab: AnyTab, engine: ChatEngine = 'codex', message?: string): Promise<ChatSession> {
    // The callers pass a project tab, or Home from agentTab()/agentTabs(), which
    // return it only once initHomeTab has given it a repoDir.
    const session = await window.radial.nativeChatCreate(tab.repoDir!, !!tab.home, engine);
    remember(session);
    if (message) {
      try { remember(await window.radial.nativeChatSend(session.id, message, message, [])); }
      catch (error) { await discard(session.id); throw error; }
    }
    await select(session.id); $('nativeChatInput').focus();
    return session;
  }
  function wireRow(row: HTMLElement): void {
    const id = row.dataset.tid!.slice('native:'.length);
    const rename = () => {
      const name = row.querySelector('.rail-term-name')!;
      const input = document.createElement('input'); input.className = 'rail-term-rename'; input.value = cache.get(id)!.title;
      name.replaceWith(input); input.focus(); input.select(); let done = false;
      const finish = async (save: boolean) => { if (done) return; done = true; input.replaceWith(name); if (save && input.value.trim()) await window.radial.nativeChatUpdate(id, { title: input.value }); hooks.renderRail(); };
      input.onclick = e => e.stopPropagation(); input.onblur = () => finish(true);
      input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    };
    row.onclick = () => select(id);
    const menu = () => hooks.menu(row.querySelector<HTMLElement>('.rail-more')!, [
      {label:'Rename',action:rename},
      {label:cache.get(id)!.recentPinnedAt ? 'Unpin chat' : 'Pin chat',action:()=>window.radial.nativeChatUpdate(id,{pinned:!cache.get(id)!.recentPinnedAt})},
      {label:cache.get(id)!.keepAwake ? 'Let it sleep' : 'Keep awake',action:()=>window.radial.nativeChatUpdate(id,{keepAwake:!cache.get(id)!.keepAwake})},
      ...(cache.get(id)!.archived ? [] : [{label:'Close chat',action:async()=> { await window.radial.nativeChatArchive(id); const session = cache.get(id)!; const key = `${session.home ? 'home:' : ''}${session.repoDir}`; if (selected.get(key) === id) saveSelection(key, null); if (current?.id === id) await refresh(true); }}]),
    ]);
    row.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); menu(); };
    row.querySelector<HTMLElement>('.rail-more')!.onclick = event => { event.stopPropagation(); menu(); };
    row.querySelector<HTMLElement>('.rail-term-name')!.ondblclick = event => { event.stopPropagation(); rename(); };
  }
  async function configure(options: NativeChatHooks): Promise<void> {
    hooks = options; enabled = await window.radial.nativeChatEnabled(); if (!enabled) return;
    for (const session of await window.radial.nativeChatList(undefined, true)) cache.set(session.id, session);
    hooks.renderRail();
    if (!await window.radial.appIsDev()) document.title = 'Radial';
    const panel = $('nativeChatPanel'), form = $('nativeChatForm');
    form.before($('nativeChatStatus'));
    window.RadialFluidChat?.mount(form);
    const latest = window.RadialChatResponses.button('Jump to latest', () => { const log = $('nativeChatMessages'); log.scrollTop = log.scrollHeight; latest.hidden = true; }); latest.id = 'nativeChatLatest'; latest.hidden = true; $('nativeChatMessages').after(latest);
    $('nativeChatMessages').addEventListener('scroll', () => { const log = $('nativeChatMessages'); latest.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 100; if (log.scrollTop < 120) showEarlier(log); }, { passive: true });
    const nativeNotice = document.createElement('div'); nativeNotice.id = 'nativeChatTerminalNotice'; nativeNotice.className = 'chat-recovery'; nativeNotice.hidden = true; nativeNotice.append(document.createElement('span'), window.RadialChatResponses.button('Open Terminal', () => switchView('terminal'))); form.before(nativeNotice);
    const queue = document.createElement('div'); queue.id = 'nativeChatQueue'; queue.className = 'chat-queue'; queue.hidden = true; form.before(queue);
    const recovery = document.createElement('div'); recovery.id = 'nativeChatRecovery'; recovery.className = 'chat-recovery'; recovery.hidden = true; recovery.innerHTML = '<span></span>';
    const retry = window.RadialChatResponses.button('Retry last message', () => retryMessage()); retry.dataset.retry = '1';
    const terminal = window.RadialChatResponses.button('Open Terminal', () => switchView('terminal')); recovery.append(retry, terminal); form.before(recovery);
    const editNote = document.createElement('div'); editNote.id = 'nativeChatEditNote'; editNote.className = 'chat-edit-note'; editNote.hidden = true; editNote.textContent = 'Sending as a follow-up. Earlier messages and changes are kept.'; form.before(editNote);
    composer = window.RadialChatComposer.create({ input: $('nativeChatInput'), form, key: () => current?.id || contextKey, context: hooks.context, changed: error => { if (error) uiError = error; render(); }, menu: chatMenu, icon: hooks.icon, previewImage, commands: () => [
      { name: 'Model', action: () => showSettings('model') }, { name: 'Permissions', action: showPermissions },
      { name: 'Terminal', action: () => switchView('terminal') }, { name: 'Chat capabilities', action: showCapabilities },
    ] });
    $('nativeChatToolbar').hidden = false;
    for (const kind of ['Model', 'Effort']) {
      const button = $('nativeChat' + kind)!;
      button.onclick = () => showSettings(kind.toLowerCase() as SettingsKind);
      button.onkeydown = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); showSettings(kind.toLowerCase() as SettingsKind); } };
    }
    $('nativeChatPermissions').onclick = showPermissions;
    $('nativeChatPermissions').onkeydown = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); showPermissions(); } };
    $('nativeChatSend').innerHTML = hooks.icon('IconArrowUp', 16);
    document.querySelectorAll<HTMLButtonElement>('[data-chat-view]').forEach(button => {
      button.innerHTML = hooks.icon(button.dataset.chatView === 'chat' ? 'IconBubbleText' : 'IconConsole', 14);
      button.onclick = () => switchView(button.dataset.chatView as ChatView);
    });
    $('nativeChatForm').onsubmit = event => { event.preventDefault(); send($('nativeChatInput').value.trim(), $('nativeChatInput').value.trim(), true); };
    $('nativeChatInput').oninput = () => render();
    $('nativeChatInput').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($('nativeChatInput').value.trim(), $('nativeChatInput').value.trim(), true); } };
    $('nativeChatStop').onclick = async () => {
      const id = current?.id; if (!id || switching || stopping) return;
      stopping = true; render();
      try { await window.radial.nativeChatStop(id); }
      catch (error) { if (current?.id === id) uiError = errorText(error); }
      finally { stopping = false; render(); }
    };
    window.radial.onNativeChatEvent(event => {
      if (event.discarded) { forget(event.id); return; }
      // Events and invoke replies travel separately, so a snapshot taken during
      // a handoff can land after the newer reply. It must not undo that state.
      const known = Math.max(cache.get(event.id)?.revision || 0, current?.id === event.id ? current.revision || 0 : 0);
      seen.set(event.id, Math.max(seen.get(event.id) || 0, event.revision || 0));
      if ((event.revision || 0) < known) return;
      // An event carries only the messages this window lacks: the list from
      // `from` on (main/nativeChat.js payload). Only the chat on screen keeps
      // its list; any other refetches it whole when opened.
      const { messagePatch: patch, ...session }: ChatEvent & { messages?: ChatMessage[] } = event;
      if (session.id === current?.id) {
        const base = current.messages;
        if (patch && patch.from === 0) session.messages = patch.messages;
        else if (patch && Array.isArray(base) && base.length >= patch.from) session.messages = base.slice(0, patch.from).concat(patch.messages);
        else { session.messages = base || []; resync(session.id); }
      }
      remember(session);
      if (session.id === current?.id) { current = session as ChatSession; if (terminalChatId === session.id && session.viewMode !== 'terminal' && !switching) { terminalChatId = null; setMode('chat'); } render(); }
    });
    setMode('chat'); refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 400);
  }
  window.RadialNativeChat = { configure, refresh: () => composer && refresh(), send, history: () => enabled ? [...cache.values()].map(session => ({ session, term: termFor(session) })) : [], sendError: () => uiError || current?.error || (current?.state === 'approval' ? 'This chat is waiting for your approval. Respond to the pending request before sending another message.' : current?.state === 'working' ? 'This chat is still working. Wait for it to finish or stop it before sending another message.' : 'Could not send. Your message is still here to retry.'), terms, wireRow, createFor, select, firstChat, discard, persistPreview, selected: id => current?.id === id && (mode === 'chat' || terminalChatId === id), visibleId: () => enabled ? (mode === 'terminal' ? terminalChatId : current?.id) || null : null, enabled: () => enabled, active: () => enabled && mode === 'chat', terminal: (id, pickedIn) => { if (enabled) { if (pickedIn) pick(keyOf(pickedIn), id || null, false); terminalChatId = id || null; setMode('terminal'); } }, stage: text => { $('nativeChatInput').value = text; if (current?.viewMode === 'terminal') switchView('chat'); else setMode('chat'); $('nativeChatInput').dispatchEvent(new Event('input')); $('nativeChatInput').focus(); return true; } };
})();
