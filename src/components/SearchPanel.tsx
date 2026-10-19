import { ANNOTATION_MIME } from '../services/imageAnnotations'
import { DIAGRAM_MIME } from '../services/diagrams'
import { useMemo } from 'react'
import { useGraphStore } from '../store/useGraphStore'
import { searchNotes } from '../services/searchNotes'

type Props = { query: string; onQueryChange: (value: string) => void; onNavigate: (id: string) => void }
export function SearchPanel({ query, onNavigate }: Props) {
  const nodes = useGraphStore(state => state.nodes)
  const visible = useGraphStore(state => state.neighborhoodNodeIds)
  const results = useMemo(() => searchNotes(visible ? nodes.filter(node => visible.has(node.id)) : nodes, query), [nodes, query, visible])
  if (!query.trim()) return null
  return <div className="search-popover">{results.length ? results.map(({ node }) => <button key={node.id} className="search-result" onClick={() => onNavigate(node.id)}>
    <strong>{node.title || 'Untitled'}</strong><span>{(node.summary || node.content || 'No description').slice(0, 130)}</span>
    {node.tags?.length || node.attachments?.some(file => file.mime !== ANNOTATION_MIME && file.mime !== DIAGRAM_MIME) ? <small>{node.tags?.map(t => `#${t}`).join(' ')} {node.attachments?.filter(file => file.mime !== ANNOTATION_MIME && file.mime !== DIAGRAM_MIME).map(f => f.name).join(' · ')}</small> : null}
  </button>) : <div className="search-empty">No matching notes</div>}</div>
}
