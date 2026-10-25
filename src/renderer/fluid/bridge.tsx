import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MotionConfig } from 'framer-motion';
import { InputMessage } from './components/ui/input-message';
import { DropdownMenu, DropdownContent } from './components/ui/dropdown';
import { MenuItem } from './components/ui/menu-item';
import { IconProvider } from './lib/icon-context';
import { SizeProvider } from './lib/size-context';
import { ThinkingSteps, ThinkingStepsHeader, ThinkingStepsContent, ThinkingStep } from './components/ui/thinking-steps';
import { Button } from './components/ui/button';
import { Tooltip, TooltipPortalContainer, TooltipProvider } from './components/ui/tooltip';
import { AskUserQuestions, type AskUserAnswer } from './components/ui/ask-user-questions';
import { Attachments } from './attachments';
import { Queue, type QueueProps } from './queue';

// These are app-owned nodes: their handlers, IDs and draft lifecycle stay with
// nativeChat.js. React owns only the surrounding Fluid presentation.
function DomSlot({ nodes, className }: { nodes: HTMLElement[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { for (const node of nodes) if (node.parentNode !== ref.current) ref.current!.append(node); }, [nodes]);
  return <div ref={ref} className={className} />;
}
/** What an icon component gets from Fluid's IconProvider. */
interface IconProps { size?: number; className?: string }
/** The window's icon set: SVG markup by name (icons.gen.js sets it). */
type IconWindow = Window & { RADIAL_ICONS?: Record<string, string> };
const central = (name: string) => ({ size = 16, className = '' }: IconProps) => {
  const svg = (window as IconWindow).RADIAL_ICONS?.[name] || '';
  return <span aria-hidden="true" className={`fluid-central-icon ${className}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
};
const icons = { 'arrow-up': central('IconArrowUp'), 'arrow-down': central('IconChevronDownSmall'), 'x': central('IconCrossSmall'), 'search': central('IconMagnifyingGlass'), 'image': central('IconPageText'), 'corner-down-left': central('IconChevronLeft'), 'chevron-right': central('IconChevronRight'), 'arrow-left': central('IconChevronLeft'), 'arrow-right': central('IconChevronRight'), 'check': central('IconCircleCheck'), 'square-library': central('IconPageText'), 'monitor': central('IconConsole'), 'pencil': central('IconPencil') };
function Providers({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user"><IconProvider icons={icons}><SizeProvider size="compact">{children}</SizeProvider></IconProvider></MotionConfig>;
}
function applyTheme(node: HTMLElement) { node.classList.toggle('dark', !document.documentElement.classList.contains('light')); }
const islands = new Map<HTMLElement, ReturnType<typeof createRoot>>();
const renderKeys = new WeakMap<HTMLElement, string>();
function renderIsland(host: HTMLElement, content: React.ReactNode) {
  host.classList.add('fluid-chat'); applyTheme(host);
  let root = islands.get(host);
  if (!root) { root = createRoot(host); islands.set(host, root); }
  flushSync(() => root!.render(<Providers>{content}</Providers>));
}
export function clear(container: HTMLElement) {
  for (const [host, root] of islands) if (host === container || container.contains(host)) {
    root.unmount(); islands.delete(host); renderKeys.delete(host); host.classList.remove('fluid-chat');
  }
}
export function activity(host: HTMLElement, tools: { id: string; name: string; status: string; node: HTMLElement }[]) {
  const key = JSON.stringify(tools.map(({ id, name, status }) => [id, name, status]));
  if (renderKeys.get(host) === key) return;
  renderKeys.set(host, key);
  const failed = tools.filter(tool => tool.status === 'failed').length;
  const running = tools.some(tool => tool.status === 'inProgress');
  renderIsland(host, <ThinkingSteps defaultOpen={false} className="w-full">
    <ThinkingStepsHeader aria-label={`${tools.length} ${tools.length === 1 ? 'step' : 'steps'}${failed ? `, ${failed} failed` : ''}`}>
      <span className={running ? 'shimmer-text' : undefined}>{tools.length} {tools.length === 1 ? 'step' : 'steps'}</span>
      {failed > 0 && <span className="fluid-activity-failure"> · {failed} failed</span>}
    </ThinkingStepsHeader>
    <ThinkingStepsContent>{tools.map((tool, index) => <ThinkingStep key={tool.id}
      label={tool.name || 'Tool'} icon={tool.status === 'failed' ? 'x' : tool.name === 'Terminal' ? 'monitor' : 'square-library'}
      status={tool.status === 'inProgress' ? 'active' : 'complete'} isLast={index === tools.length - 1} delay={0}>
      <DomSlot nodes={[tool.node]} />
    </ThinkingStep>)}</ThinkingStepsContent>
  </ThinkingSteps>);
}
type MessageAction = { id: string; label: string; icon: string; disabled?: boolean; action?: () => void; copyText?: string };
function ResponseAction({ item }: { item: MessageAction }) {
  const [feedback, setFeedback] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);
  const Icon = central(feedback === 'Copied' ? 'IconCircleCheck' : item.icon);
  async function activate() {
    if (item.copyText === undefined) { item.action?.(); return; }
    let result = 'Copied';
    try { await navigator.clipboard.writeText(item.copyText); } catch { result = 'Could not copy'; }
    if (!alive.current) return;
    setFeedback(result); clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(''), 1500);
  }
  return <Tooltip content={feedback || item.label}><Button type="button" variant="ghost" size="icon-compact"
    aria-label={feedback || item.label} disabled={item.disabled} onClick={activate}><Icon size={14} /></Button></Tooltip>;
}
export function actions(host: HTMLElement, items: MessageAction[]) {
  // Whether to re-render. The whole message text in this key made every render
  // stringify the whole conversation; length plus its ending tells a change apart.
  const key = JSON.stringify(items.map(({ id, label, icon, disabled, copyText }) => [id, label, icon, disabled, copyText?.length, copyText?.slice(-64)]));
  if (renderKeys.get(host) === key) return;
  renderKeys.set(host, key);
  renderIsland(host, <TooltipPortalContainer value={host}><TooltipProvider>
    {items.map(item => <ResponseAction key={item.id} item={item} />)}
  </TooltipProvider></TooltipPortalContainer>);
}
export function attachments(host: HTMLElement, props: React.ComponentProps<typeof Attachments>) {
  if (!props.items.length) { clear(host); host.replaceChildren(); return; }
  renderIsland(host, <TooltipPortalContainer value={host}><TooltipProvider><Attachments {...props} /></TooltipProvider></TooltipPortalContainer>);
}
export function queue(host: HTMLElement, props: QueueProps) {
  renderIsland(host, <TooltipPortalContainer value={host}><TooltipProvider><Queue {...props} /></TooltipProvider></TooltipPortalContainer>);
}
type AgentQuestion = { id: string; question: string; multiSelect?: boolean; optionsOnly?: boolean; options?: { label: string; description?: string }[] };
function QuestionFlow({ questions, submit }: { questions: AgentQuestion[]; submit: (answers: Record<string, string[]>) => Promise<boolean> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [index, setIndex] = useState(0);
  async function complete(snapshot: Record<string, AskUserAnswer>) {
    if (submitting.current) return;
    const answers: Record<string, string[]> = {};
    for (const [i, question] of questions.entries()) {
      const answer = snapshot[question.id];
      const other = answer?.otherText?.trim();
      answers[question.id] = other ? [other] : (answer?.selectedIds || []).map(id => question.options?.[Number(id)]?.label).filter((value): value is string => !!value);
      if (!answers[question.id].length) { setIndex(i); setError('Answer this question before continuing.'); return; }
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      if (!await submit(answers)) setError('Could not send your answers. Please try again.');
    } catch { setError('Could not send your answers. Please try again.'); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <div className="fluid-question-flow" aria-busy={busy} inert={busy || undefined}>
    <AskUserQuestions className="max-w-none" currentIndex={index} onCurrentIndexChange={setIndex}
      onAnswersChange={() => setError('')} onComplete={complete}
      questions={questions.map(question => ({ id: question.id, title: question.question,
        options: question.options?.map((option, i) => ({ id: String(i), title: option.label, description: option.description })),
        multiSelect: question.multiSelect, allowOther: !question.optionsOnly,
        freeText: !question.options?.length, freeTextMultiline: false,
        skippable: false, nextLabel: 'Continue', layout: 'stacked',
      }))} />
    {error && <p className="fluid-question-error" role="alert">{error}</p>}
  </div>;
}
export function questions(host: HTMLElement, items: AgentQuestion[], submit: (answers: Record<string, string[]>) => Promise<boolean>) {
  renderIsland(host, <QuestionFlow questions={items} submit={submit} />);
}
let syncComposer: (() => void) | undefined;
let closeMenu: (() => void) | undefined;

export function mount(form: HTMLFormElement) {
  if (form.classList.contains('fluid-chat')) return;
  const previous = form.querySelector<HTMLTextAreaElement>('#nativeChatInput')!;
  const initial = { value: previous.value, placeholder: previous.placeholder, disabled: previous.disabled };
  const settings = [form.querySelector<HTMLElement>('.native-chat-settings')!];
  const actions = [form.querySelector<HTMLElement>('#nativeChatStop')!, form.querySelector<HTMLElement>('#nativeChatSend')!];
  const context = document.createElement('div'); context.id = 'fluidChatContext';
  const contextNodes = [context];
  form.classList.add('fluid-chat'); applyTheme(form);
  const host = document.createElement('div'); form.replaceChildren(host);
  function Composer() {
    const [state, setState] = useState(initial);
    syncComposer = () => {
      const input = document.getElementById('nativeChatInput') as HTMLTextAreaElement;
      if (!input) return;
      const next = { value: input.value, placeholder: input.placeholder, disabled: input.disabled };
      flushSync(() => setState(old => old.value === next.value && old.placeholder === next.placeholder && old.disabled === next.disabled ? old : next));
    };
    return <Providers><InputMessage size="compact" value={state.value} onValueChange={value => setState(old => ({ ...old, value }))}
      placeholder={state.placeholder} disabled={state.disabled} minRows={3} maxRows={8}
      textareaProps={{ id: 'nativeChatInput', 'aria-label': 'Message' }}
      contextSlot={<DomSlot nodes={contextNodes} />}
      leftSlot={<DomSlot nodes={settings} className="fluid-settings-slot" />}
      sendControl={<DomSlot nodes={actions} className="fluid-send-slot" />}
      onSend={() => form.requestSubmit()} />
    </Providers>;
  }
  flushSync(() => createRoot(host).render(<Composer />));
  const observer = new MutationObserver(() => { document.querySelectorAll<HTMLElement>('.fluid-chat').forEach(applyTheme); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

export function sync() { syncComposer?.(); }
export function dismiss() { closeMenu?.(); }
/** A row of the menu: its label, optional icon (SVG markup), checked and disabled states, and what choosing it does. */
export interface FluidMenuItem { label: string; icon?: string; checked?: boolean; disabled?: boolean; action?: () => void }
export function menu(anchor: HTMLElement, items: FluidMenuItem[]) {
  closeMenu?.();
  const host = document.createElement('div'); host.className = 'fluid-chat fluid-menu-host'; applyTheme(host); document.body.append(host);
  const root = createRoot(host);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', `${anchor.id}-fluid-menu`);
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    // Let Base UI finish event dispatch before tearing down its portal.
    queueMicrotask(() => { root.unmount(); host.remove(); if (closeMenu === close) closeMenu = undefined; });
  }
  closeMenu = close;
  const checkedIndex = items.findIndex(item => item.checked);
  flushSync(() => root.render(<Providers><DropdownMenu open onOpenChange={open => { if (!open) close(); }} size="compact">
    <DropdownContent anchor={anchor} portalContainer={host} side="top" align="start" checkedIndex={checkedIndex < 0 ? undefined : checkedIndex}>
      {items.map((item, index) => <MenuItem key={index} index={index} label={item.label} checked={item.checked} disabled={item.disabled}
        icon={item.icon ? ({ size = 12, className = '' }: IconProps) => <span aria-hidden="true" className={`fluid-central-icon ${className}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: item.icon! }} /> : undefined}
        onSelect={() => { close(); item.action?.(); }} />)}
    </DropdownContent>
  </DropdownMenu></Providers>));
}
