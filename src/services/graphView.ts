import { useGraphStore } from '../store/useGraphStore'
import type { Edge } from '../types'
let previousEdges: Edge[] | undefined, previousFocus: string | null | undefined, cached: Set<string> | null = null
export function visibleNoteIds() {
  const { edges, neighborhoodId } = useGraphStore.getState()
  if (edges === previousEdges && neighborhoodId === previousFocus) return cached
  previousEdges = edges; previousFocus = neighborhoodId
  if (!neighborhoodId) return cached = null
  cached = new Set([neighborhoodId])
  for (const edge of edges) { if (edge.source === neighborhoodId) cached.add(edge.target); if (edge.target === neighborhoodId) cached.add(edge.source) }
  return cached
}
