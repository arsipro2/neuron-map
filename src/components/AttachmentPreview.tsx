import { lazy, Suspense, useEffect, useState } from 'react'
import type { Attachment } from '../types'
import { readAttachment } from '../services/attachments'
import { Modal } from './Modal'
import { useGraphStore } from '../store/useGraphStore'
import { annotationForImage } from '../services/noteContent'
const ImageAnnotationDialog = lazy(() => import('./ImageAnnotationDialog'))
const PdfPreview = lazy(() => import('./PdfPreview'))
export function AttachmentPreview({ nodeId, file, workspaceId, onClose }: { nodeId?: string; file: Attachment; workspaceId: string; onClose: () => void }) {
  const content = useGraphStore(state => state.nodes.find(node => node.id === nodeId)?.content ?? '')
  const initialAnnotationId = useState(() => annotationForImage(content, file.id))[0]
  const [blob, setBlob] = useState<Blob | null>(null), [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (nodeId && file.mime.startsWith('image/')) return
    let cancelled = false, objectUrl = ''
    void readAttachment(workspaceId, file).then(value => { if (!cancelled) { setBlob(value); objectUrl = URL.createObjectURL(value); setUrl(objectUrl) } }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file, workspaceId, nodeId])
  if (nodeId && file.mime.startsWith('image/')) return <Suspense fallback={<p>Opening image editor…</p>}><ImageAnnotationDialog nodeId={nodeId} workspaceId={workspaceId} file={file} annotationId={initialAnnotationId} onClose={onClose} /></Suspense>
  return <Modal title={file.name} onClose={onClose} wide><div className="modal-body attachment-preview">
    {error ? <p role="alert" className="attachment-error">{error}</p> : !blob ? <p role="status">Opening file…</p> : file.mime === 'application/pdf' || /\.pdf$/i.test(file.name)
      ? <Suspense fallback={<p>Loading PDF reader…</p>}><PdfPreview blob={blob} /></Suspense>
      : <img src={url} alt={file.name} onError={() => setError('This image could not be decoded. Save a copy to open it in another application.')} />}
  </div></Modal>
}
