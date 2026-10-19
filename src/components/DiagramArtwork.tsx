import { connectorPoints, pointPath, textLines, type Diagram, type DiagramShape } from '../services/diagrams'
export function ShapeOutline({ shape: s }: { shape: DiagramShape }) {
  const props = { fill: s.kind === 'text' ? 'transparent' : s.fill, stroke: s.stroke, strokeWidth: s.kind === 'text' ? 0 : s.strokeWidth }
  if (s.kind === 'ellipse') return <ellipse cx={s.x + s.width / 2} cy={s.y + s.height / 2} rx={s.width / 2} ry={s.height / 2} {...props} />
  if (s.kind === 'diamond') return <path d={`M${s.x + s.width / 2},${s.y} L${s.x + s.width},${s.y + s.height / 2} L${s.x + s.width / 2},${s.y + s.height} L${s.x},${s.y + s.height / 2} Z`} {...props} />
  return <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={s.kind === 'rounded' ? 16 : 0} {...props} />
}
export function DiagramArtwork({ document: doc, selected = new Set<string>(), connecting, prefix = 'diagram' }: { document: Diagram; selected?: ReadonlySet<string>; connecting?: string | null; prefix?: string }) {
  const map = new Map(doc.shapes.map(s => [s.id, s]))
  return <>
    <defs>{doc.edges.map(e => <marker key={e.id} id={`${prefix}-${e.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill={e.stroke} /></marker>)}</defs>
    {doc.edges.map(e => {
      const a = map.get(e.source), b = map.get(e.target); if (!a || !b) return null
      const p = connectorPoints(e, a, b), mid = p.length === 2 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : { x: (p[1].x + p[2].x) / 2, y: (p[1].y + p[2].y) / 2 }
      return <g key={e.id} data-edge-id={e.id} aria-label={`Connector ${e.text || e.id}`}>
        <path d={pointPath(p)} fill="none" stroke="transparent" strokeWidth={Math.max(14, e.strokeWidth)} pointerEvents="stroke" />
        {selected.has(e.id) ? <path d={pointPath(p)} fill="none" stroke="#4287ff" strokeWidth={e.strokeWidth + 5} opacity=".55" pointerEvents="none" /> : null}
        <path d={pointPath(p)} fill="none" stroke={e.stroke} strokeWidth={e.strokeWidth} markerEnd={e.arrow ? `url(#${prefix}-${e.id})` : undefined} pointerEvents="none" />
        <text x={mid.x} y={mid.y - 8} fill={e.stroke} fontSize={14} textAnchor="middle" stroke="#ffffff" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">{e.text.slice(0, 100)}</text>
      </g>
    })}
    {doc.shapes.map(s => {
      const lines = textLines(s)
      return <g key={s.id} data-shape-id={s.id} aria-label={`${s.kind} ${s.text || 'shape'}`}>
        <ShapeOutline shape={s} />
        <text textAnchor="middle" fill={s.color} fontSize={s.fontSize} pointerEvents="none">{lines.map((line, i) => <tspan key={i} x={s.x + s.width / 2} y={s.y + s.height / 2 + (i - (lines.length - 1) / 2) * s.fontSize * 1.25 + s.fontSize * .35}>{line}</tspan>)}</text>
        {selected.has(s.id) || connecting === s.id ? <rect x={s.x - 4} y={s.y - 4} width={s.width + 8} height={s.height + 8} fill="none" stroke="#4287ff" strokeWidth={2} strokeDasharray={connecting === s.id ? '6 4' : undefined} pointerEvents="none" /> : null}
      </g>
    })}
  </>
}
