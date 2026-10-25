import React, { useEffect, useState } from 'react';
import { FileThumbnail } from './components/ui/file-thumbnail';
import { Button } from './components/ui/button';
import { Tooltip } from './components/ui/tooltip';
import { useIcon } from './lib/icon-context';
import type { ChatFile, ChatFileMatch, RadialApi } from '../../shared/radialApi';

declare global {
  // The preload's API (contextBridge), the global src/renderer/globals.d.ts
  // declares for the window; this project doesn't include that file.
  // TODO: move into a src/renderer/fluid/globals.d.ts beside RADIAL_ICONS
  // (bridge.tsx) when that file exists.
  var radial: RadialApi;
}

/** A chip: an attached file (nativeChatAttach) or an @-menu pick (nativeChatFiles). */
export type Attachment = ChatFile | ChatFileMatch;
type Props = {
  items: Attachment[];
  repoDir: string;
  remove?: (item: Attachment) => void;
  open?: (item: Attachment) => void;
  preview: (item: { name: string; src: string }) => void;
};
function AttachmentTile({ item, repoDir, remove, open, preview }: Omit<Props, 'items'> & { item: Attachment }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const FileIcon = useIcon('square-library'), CloseIcon = useIcon('x');
  const visual = /\.(png|jpe?g|gif|webp|pdf)$/i.test(item.name);
  useEffect(() => {
    let canceled = false;
    setFile(null); setUrl(null);
    if (visual) window.radial.nativeChatPreview(repoDir, item.path).then((result) => {
      // IPC structured-clones the bytes into a Uint8Array over a plain ArrayBuffer.
      // TODO: narrow ChatFilePreview.bytes to that in radialApi.ts and drop the cast.
      if (!canceled) setFile(new File([result.bytes as Uint8Array<ArrayBuffer>], result.name, { type: result.type }));
    }).catch(() => { /* A missing or unsupported file keeps its name and remove control. */ });
    return () => { canceled = true; };
  }, [repoDir, item.path, visual]);
  const label = /\.pdf$/i.test(item.name) ? `Preview first page of ${item.name}` : `Preview ${item.name}`;
  return <div className={`chat-attachment ${remove ? 'chat-context-chip' : 'chat-sent-attachment'} ${visual ? 'chat-attachment-visual' : 'chat-attachment-file'}`} title={item.name}>
    {visual ? <>
      <Tooltip content={label}><Button type="button" variant="ghost" className="chat-attachment-preview" disabled={!url} aria-label={label}
        onClick={() => url && preview({ name: item.name, src: url })}>
        {file ? <FileThumbnail file={file} size={64} onPreviewReady={setUrl} /> : <span className="chat-attachment-placeholder"><FileIcon size={20} /></span>}
      </Button></Tooltip>
      <span className="chat-attachment-name">{item.name}</span>
    </> : <><FileIcon size={14} />{open ? <Button type="button" variant="ghost" onClick={() => open(item)}>{item.name}</Button> : <span className="chat-attachment-name">{item.name}</span>}</>}
    {remove && <Tooltip content={`Remove ${item.name}`}><Button type="button" variant="ghost" size="icon-compact" className="chat-attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => remove(item)}><CloseIcon size={12} /></Button></Tooltip>}
  </div>;
}
export function Attachments({ items, ...props }: Props) {
  return <>{items.map(item => <AttachmentTile key={`${props.repoDir}:${item.path}`} item={item} {...props} />)}</>;
}
