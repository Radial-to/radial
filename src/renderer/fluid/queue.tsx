import React, { useEffect, useRef, useState } from 'react';
import { Reorder, useReducedMotion } from 'framer-motion';
import { QueuedRow, type QueuedMessage } from './components/ui/input-message';
import { Button } from './components/ui/button';

type QueueItem = { id: string; text: string; displayText?: string; attachments?: unknown[] };
export type QueueProps = {
  items: QueueItem[]; paused: boolean;
  reorder: (ids: string[]) => Promise<boolean>;
  edit: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resume: () => Promise<boolean>;
};
const rows = (items: QueueItem[]): QueuedMessage[] => items.map(item => ({ id: item.id, text: item.displayText || item.text, files: [] }));
export function Queue({ items, paused, reorder, edit, remove, resume }: QueueProps) {
  const [order, setOrder] = useState(() => rows(items));
  const orderRef = useRef(order), latest = useRef(items), dragging = useRef(false), pending = useRef(false);
  latest.current = items;
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  function setRows(next: QueuedMessage[]) { orderRef.current = next; setOrder(next); }
  useEffect(() => { if (!dragging.current) setRows(rows(items)); }, [items]);
  async function run(action: () => Promise<boolean>) {
    if (pending.current) return;
    const focusedId = (document.activeElement?.closest('[data-queue-id]') as HTMLElement)?.dataset.queueId;
    pending.current = true; setBusy(true);
    try { await action(); }
    finally {
      pending.current = false; setBusy(false); setRows(rows(latest.current));
      requestAnimationFrame(() => {
        if (!focusedId || !host.current || (document.activeElement !== document.body && !host.current.contains(document.activeElement))) return;
        const rows = [...host.current.querySelectorAll<HTMLElement>('[data-queue-id]')];
        (rows.find(row => row.dataset.queueId === focusedId) || rows[0])?.focus({ preventScroll: true });
      });
    }
  }
  function commit(next: QueuedMessage[]) {
    dragging.current = false;
    const ids = next.map(item => item.id);
    if (ids.join() === latest.current.map(item => item.id).join()) return;
    void run(() => reorder(ids));
  }
  function move(item: QueuedMessage, direction: -1 | 1) {
    if (pending.current) return;
    const next = [...orderRef.current], index = next.findIndex(row => row.id === item.id), to = index + direction;
    if (index < 0 || to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setRows(next); commit(next);
  }
  return <div ref={host} className="fluid-queue" aria-busy={busy} inert={busy || undefined}>
    <div className="fluid-queue-heading"><span>{paused ? 'Queued messages · paused' : 'Queued for after this response'}</span>
      {paused && <Button type="button" variant="ghost" onClick={() => void run(resume)}>Resume queue</Button>}
    </div>
    <Reorder.Group axis="y" values={order} onReorder={next => { if (!pending.current) setRows(next); }} aria-label="Queued messages" className="fluid-queue-list">
      {order.map((item, index) => <QueuedRow key={item.id} item={item} index={index} total={order.length}
        attachmentCount={items.find(row => row.id === item.id)?.attachments?.length || 0}
        reduceMotion={!!reducedMotion} isTouch={true}
        onEdit={() => void run(() => edit(item.id))} onRemove={() => void run(() => remove(item.id))} onMove={move}
        onDragStart={() => { dragging.current = true; }} onDragEnd={() => commit(orderRef.current)} />)}
    </Reorder.Group>
  </div>;
}
