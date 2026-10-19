import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorPoints, copyItems, diagramSvg, duplicateItems, emptyDiagram, newShape, parseDiagram, removeItems, snap } from '../src/services/diagrams'

test('diagram connectors stay anchored after moving and resizing shapes; deletion removes incident connectors', () => {
  const a = newShape('rounded', 0, 0), b = newShape('diamond', 400, 100)
  const e = { id: 'edge', source: a.id, target: b.id, text: 'Yes', stroke: '#444444', strokeWidth: 2, arrow: true, route: 'orthogonal' as const }
  const doc = parseDiagram({ version: 1, shapes: [a, b], edges: [e] })
  const points = connectorPoints(e, a, b)
  assert.deepEqual(points[0], { x: a.width, y: a.height / 2 })
  assert.deepEqual(points.at(-1), { x: b.x, y: b.y + b.height / 2 })
  const moved = { ...b, x: 600, width: 240 }
  assert.deepEqual(connectorPoints(e, a, moved).at(-1), { x: 600, y: 150 })
  assert.equal(removeItems(doc, new Set([a.id])).edges.length, 0)
  assert.equal(removeItems(doc, new Set([e.id])).shapes.length, 2)
  assert.equal(snap(34, true), 40); assert.equal(snap(34, false), 34)
})

test('copying a diagram selection preserves internal connectors and generates new IDs', () => {
  const a = newShape('rectangle', 0, 0), b = newShape('ellipse', 400, 0), c = newShape('text', 800, 0)
  const e = { id: 'edge', source: a.id, target: b.id, text: '', stroke: '#444444', strokeWidth: 2, arrow: true, route: 'straight' as const }
  const doc = { version: 1 as const, shapes: [a, b, c], edges: [e] }
  assert.equal(copyItems(doc, new Set([a.id])).edges.length, 0)
  const copied = copyItems(doc, new Set([a.id, b.id])), result = duplicateItems(doc, copied)
  assert.equal(result.document.shapes.length, 5); assert.equal(result.document.edges.length, 2)
  assert.notEqual(result.ids[0], a.id)
  assert.equal(result.document.edges[1].source, result.ids[0])
  assert.equal(result.document.shapes[3].x, 20)
})

test('diagram parsing rejects damaged geometry and links; SVG exports escape text and strip unknown fields', () => {
  const shape = newShape('rectangle', 0, 0)
  shape.text = '<script>alert("x")</script> & Привет'
  const doc = { ...emptyDiagram(), shapes: [shape] }
  const svg = diagramSvg(doc)
  assert.ok(!svg.includes('<script>')); assert.match(svg, /&lt;/)
  assert.throws(() => parseDiagram({ ...doc, shapes: [{ ...shape, x: NaN }] }))
  assert.throws(() => parseDiagram({ ...doc, shapes: [{ ...shape, fill: 'url(https://evil)' }] }))
  assert.throws(() => parseDiagram({ ...doc, shapes: [shape, shape] }))
  assert.throws(() => parseDiagram({ ...doc, edges: [{ id: 'bad', source: shape.id, target: 'missing' }] }))
  assert.throws(() => parseDiagram({ version: 2, shapes: [], edges: [] }))
  assert.throws(() => parseDiagram({ ...doc, shapes: Array(501).fill(shape) }))
  assert.equal('onclick' in parseDiagram({ ...doc, shapes: [{ ...shape, onclick: 'evil' }] }).shapes[0], false)
})
