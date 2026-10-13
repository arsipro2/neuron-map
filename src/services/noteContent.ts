export const RICH_CONTENT_PREFIX = 'neuron-rich-text:v1\n'
export type RichNode = { type: string; text?: string; attrs?: Record<string, any>; marks?: Array<{ type: string; attrs?: Record<string, any> }>; content?: RichNode[] }
const nodeTypes = new Set(['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader', 'taskList', 'taskItem', 'attachmentImage', 'noteLink'])
const markTypes = new Set(['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript', 'code', 'link'])
export const safeLink = (href: unknown): href is string => typeof href === 'string' && /^(https?:\/\/|mailto:|neuron:)/i.test(href) && !/[\u0000-\u0020]/.test(href)
export function richDocument(content: string): RichNode | null {
  if (!content.startsWith(RICH_CONTENT_PREFIX)) return null
  try {
    const raw = JSON.parse(content.slice(RICH_CONTENT_PREFIX.length))
    let count = 0
    const clean = (node: any, depth = 0): RichNode => {
      if (++count > 100000 || depth > 40 || !node || typeof node !== 'object' || !nodeTypes.has(node.type)) throw new Error('Invalid content')
      const out: RichNode = { type: node.type }
      if (node.type === 'text') { if (typeof node.text !== 'string' || !node.text) throw new Error('Invalid text'); out.text = node.text }
      const attrs = node.attrs ?? {}
      if (node.type === 'heading') out.attrs = { level: Math.max(1, Math.min(6, Number(attrs.level) || 2)) }
      if (node.type === 'orderedList') out.attrs = { start: Math.max(1, Math.min(1000000, Number(attrs.start) || 1)) }
      if (node.type === 'taskItem') out.attrs = { checked: attrs.checked === true }
      if (node.type === 'codeBlock') out.attrs = { language: typeof attrs.language === 'string' ? attrs.language.slice(0, 80) : null }
      if (node.type === 'tableCell' || node.type === 'tableHeader') out.attrs = { colspan: Math.max(1, Math.min(100, Number(attrs.colspan) || 1)), rowspan: Math.max(1, Math.min(100, Number(attrs.rowspan) || 1)) }
      if (node.type === 'attachmentImage') {
        if (typeof attrs.attachmentId !== 'string' || attrs.attachmentId.length > 256) throw new Error('Invalid image')
        out.attrs = { attachmentId: attrs.attachmentId, annotationId: typeof attrs.annotationId === 'string' ? attrs.annotationId.slice(0, 256) : null, alt: typeof attrs.alt === 'string' ? attrs.alt.slice(0, 500) : 'Image' }
      }
      if (node.type === 'noteLink') out.attrs = { label: String(attrs.label ?? '').slice(0, 512), target: typeof attrs.target === 'string' ? attrs.target.slice(0, 256) : null, enabled: attrs.enabled === true }
      if (Array.isArray(node.marks)) out.marks = node.marks.filter((m: any) => markTypes.has(m.type) && (m.type !== 'link' || safeLink(m.attrs?.href))).map((m: any) => m.type === 'link' ? { type: m.type, attrs: { href: m.attrs.href } } : { type: m.type })
      if (node.content !== undefined) { if (!Array.isArray(node.content)) throw new Error('Invalid content'); out.content = node.content.map((child: any) => clean(child, depth + 1)) }
      return out
    }
    const doc = clean(raw)
    return doc.type === 'doc' ? doc : null
  } catch { return null }
}
export function serializeRichDocument(doc: RichNode) {
  // Keep ordinary text portable and compatible with old notes. Formatting and
  // local images use a versioned JSON document inside the existing content field.
  const plain = doc.content?.every(p => p.type === 'paragraph' && (!p.content || p.content.every(n => (n.type === 'text' && !n.marks?.length) || n.type === 'hardBreak')))
  if (plain) return (doc.content ?? []).map(p => (p.content ?? []).map(n => n.type === 'hardBreak' ? '\n' : n.text ?? '').join('')).join('\n\n')
  return RICH_CONTENT_PREFIX + JSON.stringify(doc)
}
function computeNotePlainText(content: string) {
  const doc = richDocument(content)
  if (!doc) return content
  const text = (node: RichNode): string => node.type === 'attachmentImage' ? String(node.attrs?.alt ?? '') : node.type === 'hardBreak' ? '\n' : node.text ?? (node.content ?? []).map(text).join(['doc', 'bulletList', 'orderedList', 'taskList', 'table', 'tableRow'].includes(node.type) ? '\n' : '')
  return text(doc)
}
// Stable note/link metadata owns this cache; no strong global list of large notes.
const plainTextCache = new WeakMap<object, { source: string; text: string }>()
export function notePlainText(content: string, owner?: object) {
  const previous = owner ? plainTextCache.get(owner) : null
  if (previous?.source === content) return previous.text
  const text = computeNotePlainText(content)
  if (owner) plainTextCache.set(owner, { source: content, text })
  return text
}

export function appendNoteText(content: string, text: string) {
  const doc = richDocument(content)
  if (!doc) return content + (content ? '\n' : '') + text
  doc.content ??= []; doc.content.push({ type: 'paragraph', content: [{ type: 'text', text }] })
  return serializeRichDocument(doc)
}
export function imageAnnotationIds(content: string) {
  const ids = new Set<string>()
  const walk = (node: RichNode) => { if (node.type === 'attachmentImage' && node.attrs?.annotationId) ids.add(node.attrs.annotationId); node.content?.forEach(walk) }
  const doc = richDocument(content); if (doc) walk(doc)
  return ids
}

export function annotationForImage(content: string, imageId: string): string | null {
  let found: string | null = null
  const walk = (node: RichNode) => { if (node.type === 'attachmentImage' && node.attrs?.attachmentId === imageId) found = node.attrs.annotationId ?? null; node.content?.forEach(walk) }
  const doc = richDocument(content); if (doc) walk(doc)
  return found
}
