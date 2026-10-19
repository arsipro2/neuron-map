export const DIAGRAM_MIME = 'application/vnd.neuron-map.diagram+json'
export const SHAPE_KINDS = ['rectangle', 'rounded', 'ellipse', 'diamond', 'text'] as const
export type ShapeKind = typeof SHAPE_KINDS[number]
export type DiagramStyle = { fill: string; stroke: string; color: string; strokeWidth: number; fontSize: number }
export type DiagramShape = DiagramStyle & { id: string; kind: ShapeKind; x: number; y: number; width: number; height: number; text: string }
export type DiagramEdge = { id: string; source: string; target: string; text: string; stroke: string; strokeWidth: number; arrow: boolean; route: 'straight' | 'orthogonal' }
export type Diagram = { version: 1; shapes: DiagramShape[]; edges: DiagramEdge[] }
export type Point = { x: number; y: number }
export const DEFAULT_STYLE: DiagramStyle = { fill: '#f7efd9', stroke: '#a58339', color: '#242128', strokeWidth: 2, fontSize: 16 }
export const emptyDiagram = (): Diagram => ({ version: 1, shapes: [], edges: [] })
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const color = (v: unknown): v is string => typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
export function parseDiagram(value: unknown): Diagram {
  const data = value as Diagram
  if (!data || data.version !== 1 || !Array.isArray(data.shapes) || !Array.isArray(data.edges) || data.shapes.length > 500 || data.edges.length > 1000) throw new Error('Invalid diagram. Maximum: 500 shapes and 1000 connectors.')
  const ids = new Set<string>(); let textSize = 0
  const shapes = data.shapes.map(s => {
    if (!s || !id(s.id) || ids.has(s.id) || !SHAPE_KINDS.includes(s.kind) || !finite(s.x, -100000, 100000) || !finite(s.y, -100000, 100000)
      || !finite(s.width, 20, 5000) || !finite(s.height, 20, 5000) || typeof s.text !== 'string' || s.text.length > 10000
      || !color(s.fill) || !color(s.stroke) || !color(s.color) || !finite(s.strokeWidth, 1, 8) || !finite(s.fontSize, 8, 64)) throw new Error('Invalid diagram shape.')
    ids.add(s.id); textSize += s.text.length
    return { id: s.id, kind: s.kind, x: s.x, y: s.y, width: s.width, height: s.height, text: s.text, fill: s.fill, stroke: s.stroke, color: s.color, strokeWidth: s.strokeWidth, fontSize: s.fontSize }
  })
  const edgeIds = new Set<string>()
  const edges = data.edges.map(e => {
    if (!e || !id(e.id) || ids.has(e.id) || edgeIds.has(e.id) || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target
      || typeof e.text !== 'string' || e.text.length > 1000 || !color(e.stroke) || !finite(e.strokeWidth, 1, 8) || typeof e.arrow !== 'boolean'
      || !['straight', 'orthogonal'].includes(e.route)) throw new Error('Invalid diagram connector.')
    edgeIds.add(e.id); textSize += e.text.length
    return { id: e.id, source: e.source, target: e.target, text: e.text, stroke: e.stroke, strokeWidth: e.strokeWidth, arrow: e.arrow, route: e.route }
  })
  if (textSize > 100000) throw new Error('Diagram text is too large.')
  return { version: 1, shapes, edges }
}
export const snap = (value: number, grid: boolean) => Math.max(-100000, Math.min(100000, grid ? Math.round(value / 20) * 20 : value))
export function newShape(kind: ShapeKind, x: number, y: number, style = DEFAULT_STYLE): DiagramShape {
  return { id: crypto.randomUUID(), kind, x, y, width: kind === 'diamond' ? 160 : 180, height: kind === 'text' ? 60 : 100, text: kind === 'text' ? 'Text' : '', ...style }
}
export function removeItems(doc: Diagram, selected: ReadonlySet<string>): Diagram {
  return { ...doc, shapes: doc.shapes.filter(s => !selected.has(s.id)), edges: doc.edges.filter(e => !selected.has(e.id) && !selected.has(e.source) && !selected.has(e.target)) }
}
export function copyItems(doc: Diagram, selected: ReadonlySet<string>): Diagram {
  const shapes = doc.shapes.filter(s => selected.has(s.id)), ids = new Set(shapes.map(s => s.id))
  return { version: 1, shapes, edges: doc.edges.filter(e => ids.has(e.source) && ids.has(e.target)) }
}
export function duplicateItems(doc: Diagram, copied: Diagram, offset = 20): { document: Diagram; ids: string[] } {
  const ids = new Map(copied.shapes.map(s => [s.id, crypto.randomUUID()]))
  const shapes = copied.shapes.map(s => ({ ...s, id: ids.get(s.id)!, x: snap(s.x + offset, false), y: snap(s.y + offset, false) }))
  const edges = copied.edges.map(e => ({ ...e, id: crypto.randomUUID(), source: ids.get(e.source)!, target: ids.get(e.target)! }))
  return { document: parseDiagram({ ...doc, shapes: [...doc.shapes, ...shapes], edges: [...doc.edges, ...edges] }), ids: shapes.map(s => s.id) }
}
export function connectorPoints(edge: DiagramEdge, a: DiagramShape, b: DiagramShape): Point[] {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const horizontal = Math.abs(bc.x - ac.x) / ((a.width + b.width) / 2) >= Math.abs(bc.y - ac.y) / ((a.height + b.height) / 2)
  const sign = (horizontal ? bc.x >= ac.x : bc.y >= ac.y) ? 1 : -1
  const start = horizontal ? { x: ac.x + sign * a.width / 2, y: ac.y } : { x: ac.x, y: ac.y + sign * a.height / 2 }
  const end = horizontal ? { x: bc.x - sign * b.width / 2, y: bc.y } : { x: bc.x, y: bc.y - sign * b.height / 2 }
  if (edge.route === 'straight') return [start, end]
  return horizontal ? [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end]
    : [start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end]
}
export const pointPath = (points: Point[]) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
export function diagramBounds(doc: Diagram) {
  if (!doc.shapes.length) return { x: 0, y: 0, width: 800, height: 500 }
  const x = Math.min(...doc.shapes.map(s => s.x)) - 40, y = Math.min(...doc.shapes.map(s => s.y)) - 40
  return { x, y, width: Math.max(...doc.shapes.map(s => s.x + s.width)) - x + 40, height: Math.max(...doc.shapes.map(s => s.y + s.height)) - y + 40 }
}
export function textLines(shape: DiagramShape) {
  const factor = shape.kind === 'diamond' ? .6 : 1
  const max = Math.max(1, Math.floor((shape.width * factor - 24) / (shape.fontSize * .6)))
  const lines = shape.text.split('\n').flatMap(line => {
    const chars = Array.from(line), result: string[] = []
    do { result.push(chars.splice(0, max).join('')) } while (chars.length)
    return result
  })
  const limit = Math.max(1, Math.floor((shape.height * factor - 16) / (shape.fontSize * 1.25)))
  if (lines.length > limit) { lines.length = limit; lines[limit - 1] = lines[limit - 1].slice(0, -1) + '…' }
  return lines
}
const xml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
export function diagramSvg(input: Diagram) {
  const doc = parseDiagram(input), bounds = diagramBounds(doc), map = new Map(doc.shapes.map(s => [s.id, s]))
  const edges = doc.edges.map(e => {
    const p = connectorPoints(e, map.get(e.source)!, map.get(e.target)!), m = p.length === 2 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : { x: (p[1].x + p[2].x) / 2, y: (p[1].y + p[2].y) / 2 }
    return `<path d="${pointPath(p)}" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" fill="none" ${e.arrow ? `marker-end="url(#arrow-${e.id})"` : ''}/><text x="${m.x}" y="${m.y - 8}" text-anchor="middle" fill="${e.stroke}" font-size="14" stroke="white" stroke-width="4" paint-order="stroke">${xml(e.text.slice(0, 100))}</text>`
  }).join('')
  const shapes = doc.shapes.map(s => {
    const style = `fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}"`
    const outline = s.kind === 'text' ? '' : s.kind === 'ellipse' ? `<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" ${style}/>`
      : s.kind === 'diamond' ? `<path d="M${s.x + s.width / 2},${s.y} L${s.x + s.width},${s.y + s.height / 2} L${s.x + s.width / 2},${s.y + s.height} L${s.x},${s.y + s.height / 2} Z" ${style}/>`
        : `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.kind === 'rounded' ? 16 : 0}" ${style}/>`
    const lines = textLines(s)
    return outline + `<text text-anchor="middle" fill="${s.color}" font-size="${s.fontSize}">${lines.map((line, i) => `<tspan x="${s.x + s.width / 2}" y="${s.y + s.height / 2 + (i - (lines.length - 1) / 2) * s.fontSize * 1.25 + s.fontSize * .35}">${xml(line)}</tspan>`).join('')}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" width="${bounds.width}" height="${bounds.height}" font-family="Arial,sans-serif"><defs>${doc.edges.map(e => `<marker id="arrow-${e.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${e.stroke}"/></marker>`).join('')}</defs><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/>${edges}${shapes}</svg>`
}
