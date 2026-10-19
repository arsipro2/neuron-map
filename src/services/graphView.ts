import { useGraphStore } from '../store/useGraphStore'

// A working neighborhood is captured on entry and grows only with newly created
// notes. Keep membership through delete/undo so restored notes stay in this view.
export function visibleNoteIds(): ReadonlySet<string> | null {
  return useGraphStore.getState().neighborhoodNodeIds
}
