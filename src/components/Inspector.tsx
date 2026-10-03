import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/useGraphStore'
import { AttachmentPanel } from './AttachmentPanel'
import { getPersistenceStatus, subscribePersistenceStatus } from '../services/persistence'
import { useEffect } from 'react'
import { referencedNoteIds } from '../services/noteLinks'
const WikiContent = lazy(() => import('./WikiContent').then(module => ({ default: module.WikiContent })))

type Props = {
  open: boolean
  onBusyChange: (busy: boolean, message?: string) => void
  linkNavigationEnabled?: boolean
  onNavigate?: (id: string) => void
}

export function Inspector({ open, onBusyChange, linkNavigationEnabled = false, onNavigate }: Props) {
  const [saveStatus, setSaveStatus] = useState(getPersistenceStatus())
  useEffect(() => subscribePersistenceStatus(setSaveStatus), [])
  const selectedId = useGraphStore((s) => s.selectedId)
  const [linkQuery, setLinkQuery] = useState('')
  const [contentMode, setContentMode] = useState<'edit' | 'read'>('edit')

  const node = useGraphStore(useShallow((s) => {
    const found = s.nodes.find((n) => n.id === selectedId)
    if (!found) return null
    return { id: found.id, title: found.title, summary: found.summary, content: found.content, attachments: found.attachments, tags: found.tags, linkTargets: found.linkTargets }
  }))

  const linkedIds = useGraphStore(useShallow((s) => {
    if (!selectedId) return [] as string[]
    const ids = new Set<string>()
    for (const edge of s.edges) {
      if (edge.source === selectedId) ids.add(edge.target)
      if (edge.target === selectedId) ids.add(edge.source)
    }
    return [...ids].sort()
  }))

  const linkedMetadata = useGraphStore(useShallow((s) => {
    const out: Record<string, string> = Object.create(null)
    for (const id of linkedIds) {
      const found = s.nodes.find((n) => n.id === id)
      if (found) out[id] = `${found.title}\u0000${found.summary ?? ''}`
    }
    return out
  }))

  const linkedNodes = useMemo(() => linkedIds.flatMap((id) => {
    const raw = linkedMetadata[id]
    if (raw == null) return []
    const split = raw.indexOf('\u0000')
    return [{ id, title: split >= 0 ? raw.slice(0, split) : raw, summary: split >= 0 ? raw.slice(split + 1) : '' }]
  }), [linkedIds, linkedMetadata])

  const updateNode = useGraphStore((s) => s.updateNode)
  const deleteNode = useGraphStore((s) => s.deleteNode)

  const nodes = useGraphStore(s => s.nodes)
  const backlinks = useMemo(() => nodes.filter(source => source.id !== selectedId && referencedNoteIds(source.content, nodes, source.linkTargets).has(selectedId ?? '')), [nodes, selectedId])
  const neighborhoodId = useGraphStore(s => s.neighborhoodId)

  if (!open) return null

  if (!node) {
    return (
      <aside className="inspector empty">
        <div className="empty-mark">✦</div>
        <strong>Select a neuron</strong>
        <p>Hover to preview the short description. Click — without dragging — to open the full note here.</p>
      </aside>
    )
  }

  return (
    <aside className="inspector note-inspector">
      <div className="inspector-head">
        <div>
          <div className="eyebrow">NOTE</div>
          <div className="meta-line">{linkedNodes.length} connection{linkedNodes.length === 1 ? '' : 's'}</div>
        </div>
        <button className="icon-btn danger" title="Move note to Trash" onClick={() => deleteNode(node.id)}>×</button>
      </div>

      {linkNavigationEnabled && linkedNodes.length > 0 ? (
        <section className="linked-nav-block">
          <span className="field-label">LINKED NOTES</span>
          <div className="linked-nav-list">
            {linkedNodes.map((linked) => (
              <button key={linked.id} onClick={() => onNavigate?.(linked.id)} title={linked.summary || linked.title}>
                <span>↗</span>{linked.title || 'Untitled'}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <label className="editor-block title-block">
        <span className="field-label">TITLE</span>
        <input className="title-input" value={node.title} onChange={(e) => updateNode(node.id, { title: e.target.value })} placeholder="Untitled" />
      </label>

      <label className="editor-block summary-block">
        <span className="field-label">SHORT DESCRIPTION</span>
        <textarea className="summary-input" value={node.summary ?? ''} onChange={(e) => updateNode(node.id, { summary: e.target.value })} placeholder="A concise explanation shown when you hover the node…" />
      </label>

      <TagsEditor key={`tags-${node.id}`} tags={node.tags ?? []} onChange={tags => updateNode(node.id, { tags })} />
      <div className="note-tools"><button onClick={() => useGraphStore.getState().setNeighborhood(neighborhoodId === node.id ? null : node.id)}>{neighborhoodId === node.id ? 'Show all notes' : 'Show neighbors'}</button></div>
      <section className="editor-block content-block">
        <div className="content-head-row">
          <span className="field-label">CONTENT</span>
          {(
            <div className="content-mode-switch" role="tablist" aria-label="Content mode">
              <button type="button" className={contentMode === 'edit' ? 'active' : ''} onClick={() => setContentMode('edit')}>Edit</button>
              <button type="button" className={contentMode === 'read' ? 'active' : ''} onClick={() => setContentMode('read')}>Read</button>
            </div>
          )}
        </div>

        {contentMode === 'read' ? (
          <Suspense fallback={<p>Opening reading view…</p>}><WikiContent content={node.content} linkTargets={node.linkTargets} enabled={linkNavigationEnabled} onNavigate={onNavigate} /></Suspense>
        ) : (
          <textarea
            className="content-input"
            value={node.content}
            onChange={(e) => updateNode(node.id, { content: e.target.value })}
            placeholder={linkNavigationEnabled ? 'Write the full note here… Use [[Note title]] or [[Note title|custom label]] for internal links.' : 'Write the full note here…'}
          />
        )}
      </section>

      {contentMode === 'edit' ? <label className="note-link-picker"><span className="field-label">INSERT NOTE LINK</span><input aria-label="Filter note links" value={linkQuery} onChange={event => setLinkQuery(event.target.value)} placeholder="Filter note titles…" /><select aria-label="Insert note link" value="" onChange={event => {
        const target = nodes.find(n => n.id === event.target.value); if (!target) return
        const base = target.title.trim().replace(/[\[\]|]/g, '') || 'Untitled'
        let label = base, suffix = 2
        while ((node.linkTargets?.[label.toLocaleLowerCase()] && node.linkTargets[label.toLocaleLowerCase()] !== target.id)
          || nodes.some(n => n.id !== target.id && n.title.trim().toLocaleLowerCase() === label.toLocaleLowerCase())) label = `${base} (${suffix++})`
        updateNode(node.id, { content: node.content + `${node.content ? '\n' : ''}[[${label}]]`, linkTargets: { ...node.linkTargets, [label.toLocaleLowerCase()]: target.id } })
      }}><option value="">Choose a note…</option>{nodes.filter(n => n.id !== node.id && n.title.toLocaleLowerCase().includes(linkQuery.trim().toLocaleLowerCase())).slice(0, 100).map((target, index) => <option key={target.id} value={target.id}>{target.title || 'Untitled'} · {target.summary.slice(0, 45) || `Note ${index + 1}`}</option>)}</select></label> : null}
      {linkNavigationEnabled && backlinks.length ? <section className="linked-nav-block"><span className="field-label">MENTIONED IN</span><div className="linked-nav-list">{backlinks.map(source => <button key={source.id} onClick={() => onNavigate?.(source.id)}>{source.title || 'Untitled'}</button>)}</div></section> : null}
      <AttachmentPanel key={`attachments-${node.id}`} node={node} onBusyChange={onBusyChange} />

      <div className="inspector-footer">
        <span>{saveStatus.state === 'saved' ? 'Saved locally' : saveStatus.state === 'saving' ? 'Saving…' : saveStatus.state === 'error' ? 'Save failed' : 'Unsaved changes'}</span>
        <span>{linkNavigationEnabled ? '[[wiki-links]] enabled' : 'local-first'}</span>
      </div>
    </aside>
  )
}

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [value, setValue] = useState(tags.join(', ')), editing = useRef(false)
  useEffect(() => { if (!editing.current) setValue(tags.join(', ')) }, [tags])
  const commit = (text: string) => {
    const next = [...new Set(text.split(',').map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
    if (next.join('\0') !== tags.join('\0')) onChange(next)
    return next
  }
  return <label className="editor-block tags-block"><span className="field-label">TAGS</span><input aria-label="Tags" placeholder="research, ideas…" value={value}
    onFocus={() => { editing.current = true }} onChange={event => { setValue(event.target.value); commit(event.target.value) }}
    onBlur={() => { editing.current = false; setValue(commit(value).join(', ')) }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
}
