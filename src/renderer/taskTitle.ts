
/** Where a terminal's label came from: typed by the person, or derived from its task. */
export type LabelSource = 'manual' | 'auto';
/** The label fields of a terminal's meta or a slept agent's record (shared/radialApi.ts PtyMeta, SleptAgent). */
export interface TaskLabel { label?: string | null; labelSource?: LabelSource }

function summarize(text: string | null | undefined): string {
  let s = String(text || '').trim();
  // Visual-selection bridges put the actual request after this preamble.
  s = s.split(/Find (?:this|these) in the source and act on the request below\.\s*/i).pop()!;
  s = s.replace(/\n\s*Reference images? \(read for visual context\):[\s\S]*$/i, '').trim();
  s = s.replace(/^(please\s+)?address (this|these)[^:]*:\s*/i, '');
  s = s.replace(/^here is a screenshot[^.]*\.?\s*/i, 'Screenshot: ');
  s = s.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|["'“”])/, '').trim();
  if (!s || s.startsWith('/') || /^(?:yes|no|ok(?:ay)?|sure|thanks?(?: you)?|continue|go ahead|do it|try again|looks good)[.!\s]*$/i.test(s)) return '';
  s = s.split(/\n|[.!?](?:\s|$)/)[0].replace(/\s+/g, ' ').trim();
  // Remove conversational openings without changing the substance of the request.
  s = s.replace(/^(?:(?:can|could|would|will) (?:you|we)\s+|(?:i(?:'d| would) like (?:you )?to|i want (?:you )?to|we need to|let[’']s)\s+|(?:please|also|just)\s+)+/i, '');
  s = s.replace(/["'“”]+$/g, '').trim();
  if (!s) return '';
  const words = s.split(' ');
  let title = '';
  for (const word of words.slice(0, 6)) {
    const next = title ? title + ' ' + word : word;
    if (Array.from(next).length > 32) break;
    title = next;
  }
  // A single long identifier still needs a bounded label; never add an ellipsis.
  if (!title) title = Array.from(words[0]).slice(0, 32).join('');
  title = title.replace(/\s+(?:a|an|the|to|for|with|and|or|of|in|on)$/i, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}
function isManual(meta: TaskLabel | null | undefined = {}): boolean {
  meta = meta || {};
  if (meta.labelSource) return meta.labelSource === 'manual';
  // Preserve unknown legacy custom names, but model placeholders are not renames.
  return !!meta.label && !/^(?:Claude Code|Codex|Cursor|Shell)(?: \d+)?$/i.test(meta.label);
}
export { summarize, isManual };
