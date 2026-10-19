import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Modal } from './Modal'
import { DiagramArtwork } from './DiagramArtwork'
import { useGraphStore } from '../store/useGraphStore'
import { downloadBlob } from '../services/attachments'
import { getActiveWorkspaceId } from '../services/persistence'
import { diagramAttachment, loadNoteDiagram, saveNoteDiagram } from '../services/noteDiagrams'
import { copyItems, DEFAULT_STYLE, diagramBounds, diagramSvg, duplicateItems, emptyDiagram, newShape, parseDiagram, removeItems, SHAPE_KINDS, snap, type Diagram, type Point, type ShapeKind } from '../services/diagrams'

type Tool = 'select' | 'pan' | 'connect' | ShapeKind
type View = { x: number; y: number; zoom: number }
type Gesture = { pointer: number; start: Point; document: Diagram; ids: Set<string>; kind: 'move' | 'resize' | 'pan'; view: View; latest?: Diagram }
const names: Record<Tool, string> = { select: 'Select', pan: 'Pan', connect: 'Connector', rectangle: 'Rectangle', rounded: 'Rounded', ellipse: 'Ellipse', diamond: 'Diamond', text: 'Text' }
export default function DiagramEditor({ nodeId, workspaceId, onClose }: { nodeId: string; workspaceId: string; onClose: () => void }) {
  const node = useGraphStore(s => s.nodes.find(n => n.id === nodeId))
  const [history, setHistory] = useState<Diagram[]>([emptyDiagram()]), [index, setIndex] = useState(0), [preview, setPreview] = useState<Diagram | null>(null)
  const doc = preview ?? history[index]
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set()), [tool, setTool] = useState<Tool>('select'), [connecting, setConnecting] = useState<string | null>(null)
  const [defaults, setDefaults] = useState(DEFAULT_STYLE), [grid, setGrid] = useState(true), [view, setView] = useState<View>({ x: 60, y: 60, zoom: 1 })
  const [size, setSize] = useState({ width: 1000, height: 600 })
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<SVGSVGElement>(null), labelInput = useRef<HTMLTextAreaElement>(null)
  const gesture = useRef<Gesture | null>(null), clipboard = useRef<Diagram | null>(null), expectedId = useRef<string | null>(null), savedDocument = useRef(''), saving = useRef(false), space = useRef(false)
  const dirty = loaded && JSON.stringify(doc) !== savedDocument.current
  const selectedShape = doc.shapes.find(s => selected.has(s.id)), selectedEdge = doc.edges.find(e => selected.has(e.id))
  const selection = selectedShape ?? selectedEdge
  useEffect(() => {
    let cancelled = false
    const current = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    if (!current) { setError('This note no longer exists.'); return }
    expectedId.current = diagramAttachment(current)?.id ?? null
    void loadNoteDiagram(workspaceId, current).then(value => {
      if (cancelled) return
      const initial = value ?? emptyDiagram()
      savedDocument.current = JSON.stringify(initial); setHistory([initial]); setIndex(0); setLoaded(true)
      if (value?.shapes.length) {
        const bounds = diagramBounds(value), width = stage.current?.clientWidth ?? 1000, height = stage.current?.clientHeight ?? 600
        const zoom = Math.max(.15, Math.min(1, width * .9 / bounds.width, height * .9 / bounds.height))
        setView({ x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom, zoom })
      }
    }).catch(e => { if (!cancelled) setError(String(e instanceof Error ? e.message : e)) })
    return () => { cancelled = true }
  }, [nodeId, workspaceId])
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage.current); return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const svg = canvas.current; if (!svg) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); if (saving.current) return
      const rect = svg.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
      setView(old => {
        const zoom = Math.max(.15, Math.min(3, old.zoom * Math.exp(-event.deltaY * .0015)))
        return { x: x - (x - old.x) * zoom / old.zoom, y: y - (y - old.y) * zoom / old.zoom, zoom }
      })
    }
    svg.addEventListener('wheel', wheel, { passive: false }); return () => svg.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    const desktopClose = (e: Event) => { if (saving.current || (dirty && !window.confirm('Close Neuron Map without saving this diagram?'))) e.preventDefault() }
    window.addEventListener('beforeunload', prevent); window.addEventListener('neuron-map:before-close', desktopClose)
    return () => { window.removeEventListener('beforeunload', prevent); window.removeEventListener('neuron-map:before-close', desktopClose) }
  }, [dirty])
  const commit = (next: Diagram) => {
    try {
      const valid = parseDiagram(next)
      if (JSON.stringify(valid) === JSON.stringify(history[index])) return
      setHistory([...history.slice(0, index + 1), valid].slice(-51)); setIndex(Math.min(index + 1, 50)); setSaved(false); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const close = () => { if (!saving.current && (!dirty || window.confirm('Discard unsaved diagram changes?'))) onClose() }
  const changeTool = (value: Tool) => { setTool(value); setConnecting(null); canvas.current?.focus() }
  const save = async () => {
    if (!loaded || saving.current || gesture.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      expectedId.current = await saveNoteDiagram(nodeId, workspaceId, doc, expectedId.current, id => { expectedId.current = id })
      savedDocument.current = JSON.stringify(doc); setSaved(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { saving.current = false; setBusy(false) }
  }
  const point = (e: { clientX: number; clientY: number }): Point => {
    const rect = canvas.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left - view.x) / view.zoom, y: (e.clientY - rect.top - view.y) / view.zoom }
  }
  const pointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!loaded || busy || gesture.current || (e.button !== 0 && e.button !== 1)) return
    e.preventDefault(); canvas.current?.focus()
    if (e.button === 1 || tool === 'pan' || space.current) {
      gesture.current = { pointer: e.pointerId, kind: 'pan', start: { x: e.clientX, y: e.clientY }, document: doc, ids: selected, view }
    } else {
      const target = e.target as Element, p = point(e), shapeId = target.closest('[data-shape-id]')?.getAttribute('data-shape-id'), edgeId = target.closest('[data-edge-id]')?.getAttribute('data-edge-id')
      if (SHAPE_KINDS.includes(tool as ShapeKind)) {
        const s = newShape(tool as ShapeKind, 0, 0, defaults)
        s.x = snap(p.x - s.width / 2, grid); s.y = snap(p.y - s.height / 2, grid)
        commit({ ...doc, shapes: [...doc.shapes, s] }); setSelected(new Set([s.id])); setTool('select'); return
      }
      if (tool === 'connect') {
        if (!shapeId) { setConnecting(null); return }
        if (!connecting) { setConnecting(shapeId); setSelected(new Set([shapeId])); return }
        if (shapeId !== connecting) {
          const id = crypto.randomUUID()
          commit({ ...doc, edges: [...doc.edges, { id, source: connecting, target: shapeId, text: '', stroke: defaults.stroke, strokeWidth: defaults.strokeWidth, arrow: true, route: 'orthogonal' }] })
          setSelected(new Set([id])); setConnecting(null); setTool('select')
        }
        return
      }
      const resize = target.getAttribute('data-resize')
      if (resize && selectedShape) gesture.current = { pointer: e.pointerId, kind: 'resize', start: p, document: doc, ids: new Set([selectedShape.id]), view }
      else if (shapeId) {
        const ids = e.shiftKey ? new Set(selected) : selected.has(shapeId) ? new Set(selected) : new Set<string>()
        if (e.shiftKey && ids.has(shapeId)) { ids.delete(shapeId); setSelected(ids); return }
        ids.add(shapeId); setSelected(ids)
        gesture.current = { pointer: e.pointerId, kind: 'move', start: p, document: doc, ids, view }
      } else setSelected(edgeId ? new Set([edgeId]) : new Set())
    }
    if (gesture.current) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current; if (!g || g.pointer !== e.pointerId) return
    if (g.kind === 'pan') { setView({ ...g.view, x: g.view.x + e.clientX - g.start.x, y: g.view.y + e.clientY - g.start.y }); return }
    const p = point(e), dx = p.x - g.start.x, dy = p.y - g.start.y
    g.latest = { ...g.document, shapes: g.document.shapes.map(s => !g.ids.has(s.id) ? s : g.kind === 'resize'
      ? { ...s, width: Math.max(40, Math.min(5000, snap(s.width + dx, grid))), height: Math.max(40, Math.min(5000, snap(s.height + dy, grid))) }
      : { ...s, x: snap(s.x + snap(dx, grid), false), y: snap(s.y + snap(dy, grid), false) }) }
    setPreview(g.latest)
  }
  const finish = (e: ReactPointerEvent<SVGSVGElement>, cancel = false) => {
    const g = gesture.current; if (!g || g.pointer !== e.pointerId) return
    gesture.current = null; setPreview(null)
    if (!cancel && g.latest) commit(g.latest)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const patchSelected = (patch: Record<string, unknown>) => {
    if (!selected.size) { setDefaults(d => ({ ...d, ...patch })); return }
    commit({ ...doc, shapes: doc.shapes.map(s => selected.has(s.id) ? { ...s, ...patch } : s), edges: doc.edges.map(e => selected.has(e.id) ? { ...e, ...patch } : e) })
  }
  const duplicate = (copied: Diagram | null) => {
    if (!copied?.shapes.length) return
    try { const result = duplicateItems(doc, copied); commit(result.document); setSelected(new Set(result.ids)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const fit = () => {
    const b = diagramBounds(doc), zoom = Math.max(.15, Math.min(2, size.width * .9 / b.width, size.height * .9 / b.height))
    setView({ x: (size.width - b.width * zoom) / 2 - b.x * zoom, y: (size.height - b.height * zoom) / 2 - b.y * zoom, zoom })
  }
  const exportDiagram = async (png: boolean) => {
    try {
      const bounds = diagramBounds(doc), scale = Math.min(2, 4096 / Math.max(bounds.width, bounds.height))
      const width = Math.ceil(bounds.width * scale), height = Math.ceil(bounds.height * scale)
      const markup = diagramSvg(doc)
      // Bound raster dimensions before decoding the SVG, even for very distant shapes.
      const svg = new Blob([png ? markup.replace(/width="[^"]+" height="[^"]+"/, `width="${width}" height="${height}"`) : markup], { type: 'image/svg+xml' })
      const name = (node?.title || 'diagram').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80)
      if (!png) { downloadBlob(svg, `${name}.svg`); return }
      const url = URL.createObjectURL(svg)
      try {
        const image = new Image(); image.src = url; await image.decode()
        const output = document.createElement('canvas'); output.width = width; output.height = height
        output.getContext('2d')!.drawImage(image, 0, 0, output.width, output.height)
        const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(new Error('PNG export failed.')), 'image/png'))
        downloadBlob(blob, `${name}.png`)
      } finally { URL.revokeObjectURL(url) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <Modal title={`Diagram · ${node?.title || 'Untitled'}`} onClose={close} busy={busy} wide isolateKeys>
    <div className="diagram-editor" onKeyUp={e => { if (e.code === 'Space') space.current = false }} onKeyDown={e => {
      e.stopPropagation()
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      const modifier = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
      if (modifier && key === 's') { e.preventDefault(); void save(); return }
      if (typing || busy || !loaded || gesture.current) return
      if (modifier && (key === 'z' || key === 'y')) { e.preventDefault(); setIndex(i => Math.max(0, Math.min(history.length - 1, i + (key === 'y' || e.shiftKey ? 1 : -1)))); setSelected(new Set()); return }
      if (modifier && key === 'a') { e.preventDefault(); setSelected(new Set(doc.shapes.map(s => s.id))); return }
      if (modifier && key === 'c') { e.preventDefault(); clipboard.current = copyItems(doc, selected); return }
      if (modifier && key === 'v') { e.preventDefault(); duplicate(clipboard.current); return }
      if (modifier && key === 'd') { e.preventDefault(); duplicate(copyItems(doc, selected)); return }
      if (key === 'delete' || key === 'backspace') { e.preventDefault(); commit(removeItems(doc, selected)); setSelected(new Set()); return }
      if (e.code === 'Space') { e.preventDefault(); space.current = true; return }
      if (e.key.startsWith('Arrow') && selected.size) {
        e.preventDefault(); const step = e.shiftKey ? 20 : 1, dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        commit({ ...doc, shapes: doc.shapes.map(s => selected.has(s.id) ? { ...s, x: snap(s.x + dx, false), y: snap(s.y + dy, false) } : s) })
      }
    }}>
      <div className="diagram-toolbar" role="toolbar" aria-label="Diagram tools"><fieldset disabled={!loaded || busy}>
        {(['select', 'pan', 'connect', ...SHAPE_KINDS] as Tool[]).map(t => <button key={t} aria-pressed={tool === t} onClick={() => changeTool(t)}>{names[t]}</button>)}
        <span className="diagram-divider" />
        <button aria-label="Undo diagram" disabled={index === 0} onClick={() => { setIndex(index - 1); setSelected(new Set()) }}>Undo</button>
        <button aria-label="Redo diagram" disabled={index === history.length - 1} onClick={() => { setIndex(index + 1); setSelected(new Set()) }}>Redo</button>
        <button disabled={!selectedShape} onClick={() => duplicate(copyItems(doc, selected))}>Duplicate</button>
        <button disabled={!selected.size} onClick={() => { commit(removeItems(doc, selected)); setSelected(new Set()) }}>Delete</button>
      </fieldset></div>
      <div className="diagram-workspace"><div className="diagram-stage" ref={stage}>
        <svg ref={canvas} role="application" aria-label="Diagram canvas" tabIndex={0} width="100%" height="100%" onPointerDown={pointerDown} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)} onLostPointerCapture={e => finish(e, true)} onBlur={() => { space.current = false }} onDoubleClick={e => {
          const id = (e.target as Element).closest('[data-shape-id]')?.getAttribute('data-shape-id')
          if (id) { setSelected(new Set([id])); labelInput.current?.focus() }
        }} style={{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}>
          <defs><pattern id="diagram-grid" width={20 * view.zoom} height={20 * view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}><circle cx="1" cy="1" r="1" fill="#c8c4ba" /></pattern></defs>
          <rect width="100%" height="100%" fill="#fffdf8" />{grid ? <rect width="100%" height="100%" fill="url(#diagram-grid)" pointerEvents="none" /> : null}
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            <DiagramArtwork document={doc} selected={selected} connecting={connecting} />
            {selected.size === 1 && selectedShape && tool === 'select' ? <rect data-resize="true" aria-label="Resize shape" x={selectedShape.x + selectedShape.width - 6 / view.zoom} y={selectedShape.y + selectedShape.height - 6 / view.zoom} width={12 / view.zoom} height={12 / view.zoom} fill="#4287ff" stroke="white" strokeWidth={1 / view.zoom} style={{ cursor: 'nwse-resize' }} /> : null}
          </g>
        </svg>
        {!loaded ? <div className="diagram-loading" role="status">{error || 'Opening diagram…'}</div> : null}
        {loaded && !doc.shapes.length ? <div className="diagram-empty">Choose a shape above, then click the canvas.<br />Connect shapes with the Connector tool.</div> : null}
      </div><aside className="diagram-properties"><fieldset disabled={!loaded || busy}>
        <strong>{selected.size > 1 ? `${selected.size} selected` : selectedShape ? 'Shape' : selectedEdge ? 'Connector' : 'New shape style'}</strong>
        <label>Label<textarea ref={labelInput} aria-label="Diagram label" maxLength={selectedEdge ? 1000 : 10000} disabled={!selection} value={selection?.text ?? ''} onChange={e => patchSelected({ text: e.target.value })} placeholder="Select a shape or connector…" /></label>
        {!selectedEdge ? <><label>Fill<input aria-label="Shape fill" type="color" value={selectedShape?.fill ?? defaults.fill} onChange={e => patchSelected({ fill: e.target.value })} /></label><label>Text color<input aria-label="Shape text color" type="color" value={selectedShape?.color ?? defaults.color} onChange={e => patchSelected({ color: e.target.value })} /></label><label>Text size<input aria-label="Shape text size" type="number" min="8" max="64" value={selectedShape?.fontSize ?? defaults.fontSize} onChange={e => patchSelected({ fontSize: Math.max(8, Math.min(64, Number(e.target.value) || 8)) })} /></label></> : null}
        <label>Line color<input aria-label="Diagram line color" type="color" value={selection?.stroke ?? defaults.stroke} onChange={e => patchSelected({ stroke: e.target.value })} /></label>
        <label>Line width<input aria-label="Diagram line width" type="number" min="1" max="8" value={selection?.strokeWidth ?? defaults.strokeWidth} onChange={e => patchSelected({ strokeWidth: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} /></label>
        {selectedEdge ? <><label>Routing<select aria-label="Connector routing" value={selectedEdge.route} onChange={e => patchSelected({ route: e.target.value })}><option value="orthogonal">Orthogonal</option><option value="straight">Straight</option></select></label><label><input type="checkbox" checked={selectedEdge.arrow} onChange={e => patchSelected({ arrow: e.target.checked })} /> Arrow</label></> : null}
        {selectedShape ? <div className="diagram-size">{(['width', 'height'] as const).map(key => <label key={key}>{key}<input aria-label={`Shape ${key}`} type="number" min="40" max="5000" value={selectedShape[key]} onChange={e => patchSelected({ [key]: Math.max(40, Math.min(5000, Number(e.target.value) || 40)) })} /></label>)}</div> : null}
        <label><input aria-label="Snap to grid" type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)} /> Snap to grid</label>
        <div className="diagram-help">Shift+click: select several<br />Space+drag: pan<br />Wheel: zoom<br />Ctrl/Cmd+D: duplicate<br />Ctrl/Cmd+C / V: copy / paste<br />Delete: remove selection<br />Double-click a shape: edit label</div>
      </fieldset></aside></div>
      {error && loaded ? <p className="attachment-error" role="alert">{error}</p> : null}
      <footer className="diagram-footer"><div><button onClick={() => setView(v => ({ ...v, zoom: Math.max(.15, v.zoom / 1.2) }))}>−</button><output aria-label="Diagram zoom">{Math.round(view.zoom * 100)}%</output><button onClick={() => setView(v => ({ ...v, zoom: Math.min(3, v.zoom * 1.2) }))}>+</button><button onClick={fit}>Fit</button><span>{doc.shapes.length} shapes · {doc.edges.length} connectors</span></div><div><button disabled={!loaded || busy} onClick={() => void exportDiagram(false)}>Export SVG</button><button disabled={!loaded || busy} onClick={() => void exportDiagram(true)}>Export PNG</button><span role="status">{!loaded ? 'Diagram not loaded' : saved && !dirty ? 'Diagram saved' : dirty ? 'Unsaved diagram' : 'Saved in this note'}</span><button className="diagram-save" disabled={!loaded || busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save diagram'}</button></div></footer>
    </div>
  </Modal>
}
