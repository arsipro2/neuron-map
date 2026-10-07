import { test } from 'node:test'
import './edgeProjection.test'
import './layoutPhysics.test'
import assert from 'node:assert/strict'
import { useGraphStore } from '../src/store/useGraphStore'
import { graphEngine } from '../src/engine/graphEngine'
import { captureLinkTargets, referencedNoteIds, resolveNoteLink } from '../src/services/noteLinks'
import { searchNotes } from '../src/services/searchNotes'
import fixtures from './fixtures/workspace-validation.json'
import { parseWorkspaceFile } from '../src/services/workspaceFormat'
import { hydratePersistence, flushPersist, getPersistenceStatus, installGraphPersistenceSubscription, reloadWorkspace, getActiveWorkspaceId } from '../src/services/persistence'
import { openAttachment, downloadAttachment } from '../src/services/attachments'

class FakeWorker {
  static current: FakeWorker
  messages: any[] = []
  onmessage: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  constructor() { FakeWorker.current = this }
  postMessage(message: any) { this.messages.push(message) }
  terminate() {}
}
Object.assign(globalThis, { Worker: FakeWorker })
const node = (id = 'node') => ({ id, title: 'Title', summary: '', content: 'original', position: [1, 2, 3] as [number, number, number] })

test('selection clears the opposite selection without cancelling a note click', () => {
  const store = useGraphStore.getState(); store.hydrateGraph([node()], [])
  store.setSelected('node'); store.setSelectedEdge(null)
  assert.equal(useGraphStore.getState().selectedId, 'node')
  const previous = useGraphStore.getState().selectionVersion
  store.setSelected('node')
  assert.equal(useGraphStore.getState().selectionVersion, previous + 1)
  store.connectNodes('node', 'missing')
  assert.equal(useGraphStore.getState().edges.length, 0)
})

test('late physics messages cannot overwrite a new graph with the same node count', () => {
  graphEngine.syncGraph([node('first')], [], true)
  const worker = FakeWorker.current, previous = worker.messages.at(-1).revision
  graphEngine.syncGraph([node('second')], [], true)
  worker.onmessage!({ data: { type: 'positions', revision: previous, positions: new Float32Array([99, 99, 99]).buffer } })
  assert.deepEqual(graphEngine.runtime.positionOf('second'), [1, 2, 3])
  const revision = worker.messages.at(-1).revision
  worker.onmessage!({ data: { type: 'positions', revision, positions: new Float32Array([4, 5, 6]).buffer } })
  assert.deepEqual(graphEngine.runtime.positionOf('second'), [4, 5, 6])
})

test('v1 imports and v2 binary validation reject missing or damaged files', () => {
  const base = { format: 'neuron-map-workspace', version: 1, workspace: { name: 'A' }, state: { nodes: [node()], edges: [], camera: null } }
  assert.equal(parseWorkspaceFile(JSON.stringify(base)).state.nodes[0].attachments?.length, 0)
  const attached = { ...node(), attachments: [{ id: 'file', name: 'data.bin', mime: '', size: 3, addedAt: 1 }] }
  const withFile = { ...base, version: 2, state: { ...base.state, nodes: [attached] }, files: [{ id: 'file', data: 'AP+A' }] }
  assert.equal(parseWorkspaceFile(JSON.stringify(withFile)).files.length, 1)
  assert.throws(() => parseWorkspaceFile(JSON.stringify({ ...withFile, files: [] })), /missing/)
  assert.throws(() => parseWorkspaceFile(JSON.stringify({ ...withFile, files: [{ id: 'file', data: 'AA==' }] })), /size/)
  // Multi-megabyte validation must not exhaust the regex stack.
  const large = { ...attached, attachments: [{ ...attached.attachments[0], size: 3 * 1024 * 1024 }] }
  assert.equal(parseWorkspaceFile(JSON.stringify({ ...withFile, state: { ...base.state, nodes: [large] }, files: [{ id: 'file', data: 'AAAA'.repeat(1024 * 1024) }] })).files.length, 1)
})

test('save callers wait, concurrent edits stay dirty, and a failed switch preserves the current graph', async () => {
  const workspaces = ['first', 'second'].map((id) => ({ id, name: id, createdAt: 0, updatedAt: 0, nodeCount: 1 }))
  const pending: Array<{ resolve: (revision: number) => void; reject: (error: Error) => void }> = []
  const writes: any[] = []
  const windowMock = {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      if (command === 'bootstrap_workspaces') return { workspaces, lastWorkspaceId: 'first' }
      if (command === 'load_workspace') return { nodes: [node(args.workspaceId)], edges: [], camera: null }
      if (command === 'save_workspace') {
        writes.push(args)
        return new Promise<number>((resolve, reject) => pending.push({ resolve, reject }))
      }
      throw new Error(command)
    } },
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
  }
  Object.assign(globalThis, { window: windowMock })
  await hydratePersistence()
  const unsubscribe = installGraphPersistenceSubscription()
  useGraphStore.getState().updateNode('first', { content: 'before' })
  const first = flushPersist()
  await new Promise((resolve) => setTimeout(resolve, 0))
  useGraphStore.getState().updateNode('first', { content: 'during' })
  let secondDone = false
  const second = flushPersist().then(() => { secondDone = true })
  assert.equal(secondDone, false)
  pending.shift()!.resolve(writes.length); await first
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(writes.length, 2)
  assert.equal(writes[1].state.nodes[0].content, 'during')
  assert.equal(secondDone, false)
  pending.shift()!.resolve(writes.length); await second
  assert.equal(getPersistenceStatus().state, 'saved')
  useGraphStore.getState().updateNode('first', { content: 'keep on failure' })
  const switching = reloadWorkspace('second')
  const rejected = assert.rejects(switching, /disk full/)
  await new Promise((resolve) => setTimeout(resolve, 0)); pending.shift()!.reject(new Error('disk full')); await rejected
  assert.equal(getActiveWorkspaceId(), 'first')
  assert.equal(useGraphStore.getState().nodes[0].content, 'keep on failure')
  assert.equal(getPersistenceStatus().state, 'error')
  const cleanup = flushPersist(); await new Promise((resolve) => setTimeout(resolve, 0)); pending.shift()!.resolve(writes.length); await cleanup
  unsubscribe()
})


test('shared workspace fixtures are accepted and rejected consistently', () => {
  for (const fixture of fixtures) {
    if (fixture.valid) assert.doesNotThrow(() => parseWorkspaceFile(JSON.stringify(fixture.workspace)), fixture.name)
    else assert.throws(() => parseWorkspaceFile(JSON.stringify(fixture.workspace)), undefined, fixture.name)
  }
})
test('trash restores edges in either order and undo/redo preserves files', () => {
  const a = { ...node('a'), attachments: [{ id: 'file', name: 'a.txt', mime: 'text/plain', size: 1, addedAt: 1 }] }, b = node('b')
  graphEngine.syncGraph([a, b], [], true)
  const store = useGraphStore.getState()
  store.hydrateGraph([a, b], [{ id: 'edge', source: 'a', target: 'b' }])
  store.deleteNode('a'); store.deleteNode('b')
  assert.equal(useGraphStore.getState().trash.edges.length, 1)
  store.restoreNode('a'); assert.equal(useGraphStore.getState().edges.length, 0)
  store.restoreNode('b'); assert.equal(useGraphStore.getState().edges.length, 1)
  store.undo(); assert.equal(useGraphStore.getState().trash.nodes[0].node.id, 'b')
  store.undo(); assert.equal(useGraphStore.getState().nodes.length, 0)
  store.redo(); store.redo()
  assert.equal(useGraphStore.getState().nodes[0].attachments?.[0].id, 'file')
  store.deleteNode('a'); assert.equal(store.addLinkedNode('a'), null)
})
test('a restarted worker receives the graph before a drag; invalid physics is ignored', () => {
  graphEngine.stop(); graphEngine.syncGraph([node('physics')], [], true)
  const first = FakeWorker.current, log = console.error; console.error = () => {}
  try { first.onerror!({ message: 'simulated crash' }) } finally { console.error = log }
  graphEngine.startDrag('physics', [4, 5, 6])
  assert.deepEqual(FakeWorker.current.messages.map(m => m.type), ['init', 'dragStart'])
  const revision = FakeWorker.current.messages[0].revision
  FakeWorker.current.onmessage!({ data: { type: 'positions', revision, positions: new Float32Array([Infinity, 2, 3]).buffer } })
  assert.deepEqual(graphEngine.runtime.positionOf('physics'), [1, 2, 3])
  graphEngine.endDrag()
})
test('wiki links keep their target after rename and do not silently retarget a deleted note', () => {
  const notes = [{ ...node('a'), title: 'A' }, { ...node('b'), title: 'B' }]
  const mapping = captureLinkTargets('See [[B|second]]', notes)
  const renamed = [notes[0], { ...notes[1], title: 'Renamed' }]
  assert.equal(resolveNoteLink('B', renamed, mapping), 'b')
  assert.deepEqual([...referencedNoteIds('See [[B]]', renamed, mapping)], ['b'])
  assert.equal(resolveNoteLink('B', [{ ...notes[0], title: 'B' }], mapping), null)
  assert.equal(resolveNoteLink('same', notes.map(n => ({ ...n, title: 'same' }))), null)
})
test('search matches attachment names and exact #tags, combining terms', () => {
  const notes = [{ ...node('a'), tags: ['research'], attachments: [{ id: 'f', name: 'данные.pdf', size: 1, mime: 'application/pdf', addedAt: 1 }] }, node('b')]
  assert.deepEqual(searchNotes(notes, '#research данные').map(r => r.node.id), ['a'])
  assert.deepEqual(searchNotes(notes, '#res данные'), [])
})
test('failed saves retry with the latest memory state and preserve the visible error while editing', async () => {
  const timers: Array<() => void> = [], writes: any[] = []
  const win = (globalThis as any).window
  win.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length }
  win.clearTimeout = () => {}
  let failed = false
  win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
    assert.equal(command, 'save_workspace'); writes.push(args.state)
    if (!failed) { failed = true; throw new Error('temporary disk error') }
    return 100
  }
  useGraphStore.getState().hydrateGraph([node('retry')], [])
  graphEngine.syncGraph([node('retry')], [], true)
  const unsubscribe = installGraphPersistenceSubscription()
  await assert.rejects(flushPersist(), /temporary disk/)
  useGraphStore.getState().updateNode('retry', { content: 'edit after failed save' })
  assert.equal(getPersistenceStatus().state, 'error')
  timers.at(-1)!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(writes.at(-1).nodes[0].content, 'edit after failed save')
  assert.equal(getPersistenceStatus().state, 'saved')
  unsubscribe()
})

test('desktop opening uses stored IDs, stays separate from Save a copy and propagates errors', async () => {
  const previous = (globalThis as any).window
  const calls: unknown[] = []
  const attachment = { id: 'file-id', name: '../../not-a-path.txt', mime: 'text/plain', size: 3, addedAt: 1 }
  let fail = false
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    calls.push([command, args])
    if (fail) throw new Error('No default application')
  } } } })
  try {
    await openAttachment('workspace-id', attachment)
    await downloadAttachment('workspace-id', attachment)
    assert.deepEqual(calls, [
      ['open_attachment', { workspaceId: 'workspace-id', attachmentId: 'file-id' }],
      ['save_attachment_as', { workspaceId: 'workspace-id', attachmentId: 'file-id' }],
    ])
    fail = true
    await assert.rejects(openAttachment('workspace-id', attachment), /No default application/)
  } finally { Object.assign(globalThis, { window: previous }) }
})
