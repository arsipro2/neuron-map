import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useGraphStore } from '../store/useGraphStore'
import { resolveNoteLink, WIKI_PATTERN } from '../services/noteLinks'

type Props = { content: string; enabled: boolean; linkTargets?: Record<string, string>; onNavigate?: (id: string) => void }
type AstNode = { type: string; value?: string; url?: string; children?: AstNode[] }

export function WikiContent({ content, enabled, linkTargets, onNavigate }: Props) {
  const notes = useGraphStore(s => s.nodes)
  const wikiPlugin = useMemo(() => () => (tree: AstNode) => {
    const walk = (parent: AstNode) => {
      if (!parent.children || ['link', 'code', 'inlineCode', 'html'].includes(parent.type)) return
      parent.children = parent.children.flatMap(child => {
        if (child.type !== 'text') { walk(child); return [child] }
        const value = child.value ?? '', result: AstNode[] = []
        let end = 0
        for (const match of value.matchAll(WIKI_PATTERN)) {
          if (match.index! > end) result.push({ type: 'text', value: value.slice(end, match.index) })
          const id = resolveNoteLink(match[1], notes, linkTargets)
          result.push({ type: 'link', url: id ? `neuron:${encodeURIComponent(id)}` : 'neuron-missing:', children: [{ type: 'text', value: (match[2] ?? match[1]).trim() }] })
          end = match.index! + match[0].length
        }
        if (end < value.length) result.push({ type: 'text', value: value.slice(end) })
        return result.length ? result : [child]
      })
    }
    walk(tree)
  }, [notes, linkTargets])
  if (!content.trim()) return <div className="wiki-empty">Nothing here yet.</div>
  return <div className="wiki-content-view markdown-body" aria-label="Rendered note content">
    <Markdown skipHtml remarkPlugins={[remarkGfm, wikiPlugin]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      urlTransform={url => /^(https?:|mailto:|neuron:|neuron-missing:)/i.test(url) ? url : ''}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith('neuron')) {
            let id: string | null = null
            try { const decoded = href.startsWith('neuron:') ? decodeURIComponent(href.slice(7)) : null; if (notes.some(n => n.id === decoded)) id = decoded } catch { /* Malformed links render as missing. */ }
            if (!enabled || !id) return <span className={`wiki-link ${id ? 'disabled' : 'missing'}`} title={id ? 'Enable internal navigation in Settings' : 'Note is missing or its title is ambiguous'}>[[{children}]]</span>
            return <button type="button" className="wiki-link resolved" onClick={() => onNavigate?.(id)}>{children}</button>
          }
          return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
        },
        img: ({ alt }) => <span className="markdown-image-label">[Image: {alt || 'external image'} — attach the file to preview it locally]</span>,
      }}>{content}</Markdown>
  </div>
}
