import { useMemo } from 'react'
import { useGraphStore } from '../store/useGraphStore'
import { searchNotes } from '../services/searchNotes'

type Props = { query: string; onQueryChange: (value: string) => void; onNavigate: (id: string) => void }
export function SearchPanel({ query, onNavigate }: Props) {
  const nodes = useGraphStore(state => state.nodes)
  const results = useMemo(() => searchNotes(nodes, query), [nodes, query])
  if (!query.trim()) return null
  return <div className="search-popover">{results.length ? results.map(({ node }) => <button key={node.id} className="search-result" onClick={() => onNavigate(node.id)}>
    <strong>{node.title || 'Untitled'}</strong><span>{(node.summary || node.content || 'No description').slice(0, 130)}</span>
    {node.tags?.length || node.attachments?.length ? <small>{node.tags?.map(t => `#${t}`).join(' ')} {node.attachments?.map(f => f.name).join(' · ')}</small> : null}
  </button>) : <div className="search-empty">No matching notes</div>}</div>
}
