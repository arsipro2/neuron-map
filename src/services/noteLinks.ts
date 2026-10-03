import type { NoteNode } from '../types'

export const WIKI_PATTERN = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
type NoteIndex = { ids: Set<string>; titles: Map<string, string | null> }
const indexes = new WeakMap<object, NoteIndex>()
function noteIndex(notes: Pick<NoteNode, 'id' | 'title'>[]) {
  let index = indexes.get(notes)
  if (!index) {
    index = { ids: new Set(), titles: new Map() }
    for (const note of notes) {
      index.ids.add(note.id)
      const key = note.title.trim().toLocaleLowerCase()
      index.titles.set(key, index.titles.has(key) ? null : note.id)
    }
    indexes.set(notes, index)
  }
  return index
}
export function resolveNoteLink(target: string, notes: Pick<NoteNode, 'id' | 'title'>[], targets: Record<string, string> = {}): string | null {
  const index = noteIndex(notes)
  if (target.startsWith('id:')) {
    try { const id = decodeURIComponent(target.slice(3)); return index.ids.has(id) ? id : null } catch { return null }
  }
  const key = target.trim().toLocaleLowerCase()
  if (Object.hasOwn(targets, key)) return index.ids.has(targets[key]) ? targets[key] : null
  return index.titles.get(key) ?? null
}
export function captureLinkTargets(content: string, notes: Pick<NoteNode, 'id' | 'title'>[], previous: Record<string, string> = {}) {
  const result: Record<string, string> = Object.create(null)
  for (const match of content.matchAll(WIKI_PATTERN)) {
    const key = match[1].trim().toLocaleLowerCase()
    const target = Object.hasOwn(previous, key) ? previous[key] : resolveNoteLink(match[1], notes)
    if (target) result[key] = target
  }
  return result
}
export function referencedNoteIds(content: string, notes: Pick<NoteNode, 'id' | 'title'>[], targets: Record<string, string> = {}) {
  return new Set(Array.from(content.matchAll(WIKI_PATTERN)).map((match) => resolveNoteLink(match[1], notes, targets)).filter((id): id is string => Boolean(id)))
}
