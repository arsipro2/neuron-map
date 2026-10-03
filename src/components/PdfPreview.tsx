import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfPreview({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false, task: ReturnType<typeof getDocument> | undefined
    setLoading(true); setPage(1); setError('')
    void blob.arrayBuffer().then(data => {
      if (cancelled) return
      task = getDocument({ data: new Uint8Array(data), useWasm: true, wasmUrl: '/pdf/wasm/', cMapUrl: '/pdf/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf/standard_fonts/', maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64 * 1024 * 1024, stopAtErrors: true })
      task.onPassword = () => { if (!cancelled) { setError('Password-protected PDFs must be opened in an external reader.'); setLoading(false) }; void task?.destroy().catch(() => {}) }
      return task.promise.then(pdf => { if (!cancelled) setDocument(pdf) })
    }).catch(e => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true; void task?.destroy().catch(() => {}) }
  }, [blob])
  useEffect(() => {
    if (!document) return
    let cancelled = false, render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    setLoading(true)
    void document.getPage(page).then(pdfPage => {
      if (cancelled || !canvas.current) return
      const raw = pdfPage.getViewport({ scale: 1 }), scale = Math.min(1.7, 1400 / Math.max(raw.width, raw.height))
      const viewport = pdfPage.getViewport({ scale })
      canvas.current.width = Math.ceil(viewport.width); canvas.current.height = Math.ceil(viewport.height)
      render = pdfPage.render({ canvas: canvas.current, viewport })
      return render.promise.then(() => { if (!cancelled) setLoading(false) })
    }).catch(e => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true; render?.cancel() }
  }, [document, page])
  return <div className="pdf-preview">
    {document ? <div className="preview-controls"><button disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>Previous page</button><span>{page} / {document.numPages}</span><button disabled={page >= document.numPages || loading} onClick={() => setPage(p => p + 1)}>Next page</button></div> : null}
    {loading ? <p role="status">Rendering page…</p> : null}{error ? <p role="alert" className="attachment-error">Could not preview this PDF. Save a copy to open it in your PDF reader. {error}</p> : null}
    <canvas ref={canvas} aria-label={`PDF page ${page}`} />
  </div>
}
