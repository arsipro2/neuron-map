import { useEffect, useRef, useState } from 'react'
import { graphAttachments } from '../types'
import { AttachmentPreview } from './AttachmentPreview'
import type { Attachment, NoteNode } from '../types'
import { useGraphStore } from '../store/useGraphStore'
import { getActiveWorkspaceId } from '../services/persistence'
import { downloadAttachment, isDesktop, openAttachment, MAX_ATTACHMENT_BYTES, MAX_WORKSPACE_ATTACHMENT_BYTES, readAttachment, storeAttachment } from '../services/attachments'

type Props = { node: Pick<NoteNode, 'id' | 'attachments'>; onBusyChange: (busy: boolean, message?: string) => void }
export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`

function AttachmentRow({ file, onRemove, onError }: { file: Attachment; onRemove: () => void; onError: (message: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [action, setAction] = useState<'opening' | 'saving' | null>(null)
  const busy = useRef(false)
  const desktop = isDesktop()
  const workspaceId = getActiveWorkspaceId()
  const act = async (next: 'opening' | 'saving') => {
    if (!workspaceId || busy.current) return
    busy.current = true; setAction(next); onError('')
    try {
      await (next === 'opening' ? openAttachment : downloadAttachment)(workspaceId, file)
    } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; setAction(null) }
  }
  useEffect(() => {
    if (!workspaceId || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(file.mime) || file.size > 5 * 1024 * 1024) return
    let cancelled = false, url: string | null = null
    void readAttachment(workspaceId, file).then((blob) => {
      if (cancelled) return
      url = URL.createObjectURL(blob); setPreview(url)
    }).catch(() => { /* Download reports missing file errors explicitly. */ })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [workspaceId, file.id, file.mime, file.size])
  return <li className="attachment-row">
    {preview ? <img src={preview} alt="" className="attachment-thumb" /> : <span className="attachment-icon" aria-hidden="true">↧</span>}
    <button className="attachment-name" disabled={action !== null} title={`${desktop ? 'Open' : 'Save'} ${file.name}`} onClick={() => void act(desktop ? 'opening' : 'saving')}>
      <strong>{file.name}</strong><small>{formatBytes(file.size)} · {action === 'opening' ? 'Opening…' : action === 'saving' ? 'Saving…' : desktop ? 'Open in default app' : 'Save a copy'}</small>
    </button>
    <button className="icon-btn danger" disabled={action !== null} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`} onClick={onRemove}>×</button>
    <div className="attachment-actions">
      {desktop ? <button disabled={action !== null} aria-label={`Save a copy of ${file.name}`} onClick={() => void act('saving')}>Save a copy</button> : null}
      {['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'].includes(file.mime) || /\.pdf$/i.test(file.name) ? <button aria-label={`Preview ${file.name}`} onClick={() => setExpanded(true)}>Preview</button> : null}
    </div>
    {expanded && workspaceId ? <AttachmentPreview file={file} workspaceId={workspaceId} onClose={() => setExpanded(false)} /> : null}
  </li>
}

export function AttachmentPanel({ node, onBusyChange }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const addFiles = async (files: File[]) => {
    const workspaceId = getActiveWorkspaceId()
    if (!workspaceId || !files.length || busy.current) return
    busy.current = true; onBusyChange(true); setError(null)
    try {
      const total = graphAttachments(useGraphStore.getState()).reduce((sum, file) => sum + file.size, 0)
      if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) throw new Error('Each attachment must be at most 20 MiB.')
      if (total + files.reduce((sum, file) => sum + file.size, 0) > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('Attachments in one workspace are limited to 64 MiB, including Trash.')
      let processed = 0
      for (const file of files) {
        onBusyChange(true, `Attaching ${++processed} of ${files.length}: ${file.name}`)
        const attachment = await storeAttachment(workspaceId, file)
        const current = useGraphStore.getState().nodes.find((n) => n.id === node.id)
        if (getActiveWorkspaceId() !== workspaceId || !current) throw new Error('The note was closed before the file could be attached.')
        useGraphStore.getState().updateNode(node.id, { attachments: [...(current.attachments ?? []), attachment] })
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; onBusyChange(false) }
  }
  return <section className={`attachments-block ${dragOver ? 'drag-over' : ''}`}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true) } }}
    onDragLeave={() => setDragOver(false)}
    onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(Array.from(event.dataTransfer.files)) }}>
    <div className="content-head-row"><span className="field-label">ATTACHMENTS · {node.attachments?.length ?? 0}</span>
      <button type="button" className="attach-button" onClick={() => input.current?.click()}>+ Attach files</button></div>
    <input ref={input} aria-label="Attach files" type="file" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addFiles(files) }} />
    {node.attachments?.length ? <ul className="attachment-list">{node.attachments.map((file) => <AttachmentRow key={file.id} file={file} onError={setError} onRemove={() => {
      if (window.confirm(`Remove “${file.name}” from this note?`)) useGraphStore.getState().updateNode(node.id, { attachments: node.attachments?.filter((item) => item.id !== file.id) })
    }} />)}</ul> : <p className="attachment-hint">Drop files here or choose them above. Any file type, up to 20 MiB each.</p>}
    {isDesktop() && node.attachments?.length ? <p className="attachment-hint">Click a filename to open a copy in your default app. To keep external edits in this note, attach the edited file again.</p> : null}
    {error ? <p className="attachment-error" role="alert">{error}</p> : null}
  </section>
}
