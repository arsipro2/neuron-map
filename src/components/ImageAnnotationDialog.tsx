import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Modal } from './Modal'
import type { Attachment } from '../types'
import { useGraphStore } from '../store/useGraphStore'
import { readAttachment } from '../services/attachments'
import { loadImageAnnotations, saveImageAnnotations } from '../services/noteImages'
import { decodeImage, drawAnnotations, type ImageMark, type ImagePoint } from '../services/imageAnnotations'

export default function ImageAnnotationDialog({ nodeId, workspaceId, file, annotationId, onClose }: { nodeId: string; workspaceId: string; file: Attachment; annotationId?: string | null; onClose: () => void }) {
  const base = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null)
  const [fitWidth, setFitWidth] = useState(1)
  const [dimensions, setDimensions] = useState<[number, number] | null>(null)
  const [history, setHistory] = useState<ImageMark[][]>([[]]), [index, setIndex] = useState(0)
  const [tool, setTool] = useState<'pen' | 'eraser' | 'text'>('pen'), [color, setColor] = useState('#ff4444'), [width, setWidth] = useState(8), [fontSize, setFontSize] = useState(40), [text, setText] = useState('')
  const [zoom, setZoom] = useState(100), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false)
  const savedMarks = useRef<ImageMark[]>([]), stroke = useRef<Extract<ImageMark, { kind: 'stroke' }> | null>(null), frame = useRef<number | null>(null), saving = useRef(false)
  const marks = history[index], dirty = JSON.stringify(marks) !== JSON.stringify(savedMarks.current)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const blob = await readAttachment(workspaceId, file)
      const annotation = useGraphStore.getState().nodes.find(n => n.id === nodeId)?.attachments?.find(a => a.id === annotationId)
      if (annotationId && !annotation) throw new Error('The annotation layer is missing.')
      const initial = annotation ? (await loadImageAnnotations(workspaceId, annotation, file.id)).marks : []
      const decoded = await decodeImage(blob)
      try {
        if (cancelled) return
        const canvas = base.current!, overlay = layer.current!
        canvas.width = overlay.width = decoded.width; canvas.height = overlay.height = decoded.height
        canvas.getContext('2d')!.drawImage(decoded.image, 0, 0, decoded.width, decoded.height)
        drawAnnotations(overlay, initial); setDimensions([decoded.width, decoded.height])
        savedMarks.current = initial; setHistory([initial]); setIndex(0); setLoaded(true)
      } finally { decoded.dispose() }
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true; if (frame.current !== null) cancelAnimationFrame(frame.current) }
  }, [nodeId, workspaceId, file.id, annotationId])
  useEffect(() => {
    const element = viewport.current
    if (!element || !dimensions) return
    const fit = () => setFitWidth(Math.min(element.clientWidth, window.innerHeight * .5 * dimensions[0] / dimensions[1], dimensions[0]))
    fit(); const observer = new ResizeObserver(fit); observer.observe(element); window.addEventListener('resize', fit)
    return () => { observer.disconnect(); window.removeEventListener('resize', fit) }
  }, [dimensions])
  useEffect(() => { if (loaded && layer.current) drawAnnotations(layer.current, marks) }, [marks, loaded])
  const commit = (next: ImageMark[]) => { setHistory(previous => [...previous.slice(0, index + 1), next].slice(-51)); setIndex(Math.min(index + 1, 50)); setSaved(false) }
  const point = (event: PointerEvent<HTMLCanvasElement>): ImagePoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!stroke.current) return
    const completed = stroke.current; stroke.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    commit([...marks, completed])
  }
  const save = async () => {
    if (!loaded || saving.current || stroke.current) return
    saving.current = true; setBusy(true); setError('')
    try { await saveImageAnnotations(nodeId, workspaceId, file.id, marks); savedMarks.current = marks; setSaved(true) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { saving.current = false; setBusy(false) }
  }
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved image annotations?'))) onClose() }
  return <Modal title={file.name} onClose={close} busy={busy} wide>
    <div className="modal-body image-annotation-editor" onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement) && !busy) { event.preventDefault(); setIndex(i => Math.max(0, Math.min(history.length - 1, i + (event.shiftKey ? 1 : -1)))) }
    }}>
      <div className="annotation-toolbar" role="toolbar" aria-label="Image annotation tools">
        {(['pen', 'eraser', 'text'] as const).map(t => <button key={t} aria-pressed={tool === t} disabled={!loaded || busy} onClick={() => setTool(t)}>{t === 'pen' ? 'Brush' : t === 'eraser' ? 'Eraser' : 'Text'}</button>)}
        <label>Color <input aria-label="Annotation color" type="color" value={color} disabled={busy} onChange={e => setColor(e.target.value)} /></label>
        {['#ff4444', '#ffd34d', '#46c976', '#4287ff', '#ffffff', '#000000'].map(c => <button key={c} className="color-swatch" style={{ background: c }} aria-label={`Use color ${c}`} disabled={busy} onClick={() => setColor(c)} />)}
        <label>Thickness <input aria-label="Brush thickness" type="range" min="1" max="40" value={width} disabled={busy} onChange={e => setWidth(Number(e.target.value))} /><output>{width}</output></label>
        <button aria-label="Undo annotation" disabled={index === 0 || busy} onClick={() => setIndex(i => i - 1)}>Undo</button>
        <button aria-label="Redo annotation" disabled={index === history.length - 1 || busy} onClick={() => setIndex(i => i + 1)}>Redo</button>
        <button disabled={!marks.length || busy} onClick={() => commit([])}>Clear annotations</button>
      </div>
      {tool === 'text' ? <div className="annotation-text-controls"><input aria-label="Text to place on image" placeholder="Write text, then click the image…" maxLength={1000} value={text} disabled={busy} onChange={e => setText(e.target.value)} /><label>Size <input aria-label="Annotation text size" type="number" min="8" max="100" value={fontSize} disabled={busy} onChange={e => setFontSize(Math.max(8, Math.min(100, Number(e.target.value) || 8)))} /></label></div> : null}
      <div className="annotation-zoom"><label>Zoom <input aria-label="Image zoom" type="range" min="50" max="200" step="10" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label><output>{zoom}%</output><span>Drawings are saved separately. Eraser removes annotations.</span></div>
      {!loaded && !error ? <p role="status">Opening image…</p> : null}
      <div className="annotation-viewport" ref={viewport}><div className="annotation-stage" style={{ width: `${fitWidth * zoom / 100}px`, aspectRatio: dimensions ? `${dimensions[0]} / ${dimensions[1]}` : '1', display: loaded ? 'block' : 'none' }}>
        <canvas ref={base} aria-label="Original image" />
        <canvas ref={layer} className={`annotation-layer tool-${tool}`} aria-label="Draw on image" onPointerDown={event => {
          if (!loaded || busy || event.button !== 0 || stroke.current) return
          event.preventDefault(); setError('')
          if (tool === 'text') { if (!text.trim()) { setError('Enter text, then click where it should appear.'); return }; commit([...marks, { kind: 'text', text, color, size: fontSize, ...point(event) }]); return }
          stroke.current = { kind: 'stroke', color, width, erase: tool === 'eraser', points: [point(event)] }; event.currentTarget.setPointerCapture(event.pointerId)
          drawAnnotations(event.currentTarget, [...marks, stroke.current])
        }} onPointerMove={event => {
          if (!stroke.current) return
          if (stroke.current.points.length >= 10000) return
          stroke.current.points.push(point(event))
          if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (layer.current && stroke.current) drawAnnotations(layer.current, [...marks, stroke.current]) })
        }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
      </div></div>
      {error ? <p className="attachment-error" role="alert">{error}</p> : null}
      <footer className="annotation-footer"><span role="status">{saved ? 'Annotations saved to this note.' : dirty ? 'Unsaved annotations' : 'Original image kept intact'}</span><button disabled={!loaded || busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save annotations'}</button></footer>
    </div>
  </Modal>
}
