import { lazy, Suspense, useEffect, useState } from 'react'
import { useGraphStore } from '../store/useGraphStore'
import { getActiveWorkspaceId } from '../services/persistence'
import { readAttachment } from '../services/attachments'
import { annotatedPreview } from '../services/imageAnnotations'
const ImageAnnotationDialog = lazy(() => import('./ImageAnnotationDialog'))
export function NoteImage({ nodeId, attachmentId, annotationId, alt }: { nodeId: string; attachmentId: string; annotationId?: string | null; alt?: string }) {
  const node = useGraphStore(state => state.nodes.find(n => n.id === nodeId))
  const workspaceId = getActiveWorkspaceId(), file = node?.attachments?.find(a => a.id === attachmentId), annotation = node?.attachments?.find(a => a.id === annotationId)
  const [src, setSrc] = useState(''), [error, setError] = useState(''), [viewer, setViewer] = useState<{ annotationId?: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false, objectUrl = ''
    setSrc(''); setError('')
    if (!workspaceId || !file) { setError('This image is no longer attached to the note.'); return }
    void (async () => {
      const blob = await readAttachment(workspaceId, file)
      if (annotationId && !annotation) throw new Error('The annotation layer is missing.')
      let preview = blob
      if (annotation) {
        const { parseAnnotations } = await import('../services/imageAnnotations')
        const data = parseAnnotations(JSON.parse(await (await readAttachment(workspaceId, annotation)).text()), file.id)
        preview = await annotatedPreview(blob, data.marks)
      }
      if (!cancelled) { objectUrl = URL.createObjectURL(preview); setSrc(objectUrl) }
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [workspaceId, file?.id, annotationId, annotation?.id])
  return <span className="inline-note-image" contentEditable={false}>
    {error ? <span className="attachment-error" role="alert">{error}</span> : <button type="button" aria-label={`Open image ${alt || file?.name || 'Image'}`} onClick={() => setViewer({ annotationId })} disabled={!src}>
      {src ? <img src={src} alt={alt || file?.name || 'Image'} loading="lazy" onError={() => setError('This image could not be decoded.')} /> : <span>Loading image…</span>}
    </button>}
    {viewer && workspaceId && file ? <Suspense fallback={<span>Opening image…</span>}><ImageAnnotationDialog nodeId={nodeId} workspaceId={workspaceId} file={file} annotationId={viewer.annotationId} onClose={() => setViewer(null)} /></Suspense> : null}
  </span>
}
