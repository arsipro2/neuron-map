import type { NoteNode } from '../types'
export function searchNotes(notes: NoteNode[], query: string) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  return notes.map(node => {
    const title = node.title.toLocaleLowerCase(), summary = node.summary.toLocaleLowerCase(), content = node.content.toLocaleLowerCase()
    const tags = (node.tags ?? []).map(tag => tag.toLocaleLowerCase())
    const files = (node.attachments ?? []).map(file => file.name.toLocaleLowerCase()).join(' ')
    let score = 0
    for (const token of tokens) {
      if (token.startsWith('#')) { if (!tags.includes(token.slice(1))) return { node, score: 0 }; score += 80; continue }
      const match = title === token ? 100 : title.startsWith(token) ? 70 : title.includes(token) ? 45 : summary.includes(token) ? 20 : tags.some(t => t.includes(token)) ? 18 : files.includes(token) ? 15 : content.includes(token) ? 8 : 0
      if (!match) return { node, score: 0 }
      score += match
    }
    return { node, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title)).slice(0, 12)
}
