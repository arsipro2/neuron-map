import type { AppPreferences, CameraSnapshot, Edge, NoteNode, Trash } from '../types'
import { emptyTrash, graphAttachments } from '../types'
import { historyAttachmentIds, useGraphStore } from '../store/useGraphStore'
import { graphEngine } from '../engine/graphEngine'
import { deleteWorkspaceFiles, downloadBlob, exportFiles, importFiles, webSnapshots, putWebSnapshot, cleanupWebFiles } from './attachments'
import { MAX_WORKSPACE_FILE_BYTES, parseWorkspaceFile, validateGraph } from './workspaceFormat'

export type WorkspaceInfo = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  nodeCount: number
}

export type PersistenceStatus = {
  state: 'saved' | 'dirty' | 'saving' | 'error'
  savedAt: number | null
  message?: string
}

export type WorkspaceBackup = {
  id: number
  createdAt: number
  nodeCount: number
  trashCount: number
  fileCount: number
  titles: string[]
}

type PersistedState = {
  nodes: NoteNode[]
  edges: Edge[]
  trash: Trash
  revision: number
  camera: CameraSnapshot | null
  preferences: AppPreferences
}

type RustState = {
  nodes: NoteNode[]
  edges: Edge[]
  trash: Trash
  revision: number
  camera: null | {
    position: [number, number, number]
    quaternion: [number, number, number, number]
    orbit_target: [number, number, number]
  }
  preferences?: AppPreferences | null
}

type WorkspaceBootstrap = {
  workspaces: WorkspaceInfo[]
  lastWorkspaceId: string
}

const DEFAULT_CAMERA: CameraSnapshot = {
  position: [0, 2.2, 11.5],
  quaternion: [0, 0, 0, 1],
  orbitTarget: [0, 0.2, 0],
}
const DEFAULT_PREFERENCES: AppPreferences = { linkNavigationEnabled: false }
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000

let cameraSnapshot: CameraSnapshot = DEFAULT_CAMERA
let preferencesSnapshot: AppPreferences = DEFAULT_PREFERENCES
let activeWorkspaceId: string | null = null
let saveTimer: number | null = null
let hydrated = false
let savePromise: Promise<number> | null = null
let activeRevision = 0
let activeWorkspaceName = 'Workspace'
let retryTimer: number | null = null
let retryAttempt = 0
const RETRY_DELAYS = [2000, 5000, 15000]
let changeVersion = 0
let loading = false
let hydrationPromise: ReturnType<typeof hydrateOnce> | null = null
let status: PersistenceStatus = { state: 'saved', savedAt: null }
const statusListeners = new Set<(next: PersistenceStatus) => void>()

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function emitStatus(next: PersistenceStatus) {
  status = next
  for (const listener of statusListeners) listener(next)
}

export function getPersistenceStatus() {
  return status
}

export function subscribePersistenceStatus(listener: (next: PersistenceStatus) => void) {
  statusListeners.add(listener)
  listener(status)
  return () => { statusListeners.delete(listener) }
}

function legacyState(): PersistedState | null {
  if (typeof window === 'undefined') return null
  for (const key of ['neuron-map-v015-fallback', 'neuron-map-v014-fallback', 'neuron-map-v013', 'neuron-map-v02']) {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const source = parsed?.state ?? parsed
      if (!Array.isArray(source?.nodes) || !Array.isArray(source?.edges)) continue
      return {
        nodes: source.nodes.map((node: any) => ({
          ...node,
          summary: typeof node.summary === 'string' ? node.summary : (typeof node.content === 'string' ? node.content.slice(0, 180) : ''),
        })),
        edges: source.edges,
        trash: emptyTrash(), revision: 0,
        camera: source.camera ?? null,
        preferences: source.preferences ?? DEFAULT_PREFERENCES,
      }
    } catch {
      // Continue to the next legacy key.
    }
  }
  return null
}

function fromRust(raw: RustState): PersistedState {
  return {
    nodes: raw.nodes,
    edges: raw.edges,
    trash: raw.trash ?? emptyTrash(), revision: raw.revision ?? 0,
    camera: raw.camera
      ? { position: raw.camera.position, quaternion: raw.camera.quaternion, orbitTarget: raw.camera.orbit_target }
      : null,
    preferences: raw.preferences ?? DEFAULT_PREFERENCES,
  }
}

function toRust(state: PersistedState) {
  return {
    nodes: state.nodes,
    edges: state.edges,
    trash: state.trash, revision: state.revision,
    camera: state.camera
      ? { position: state.camera.position, quaternion: state.camera.quaternion, orbit_target: state.camera.orbitTarget }
      : null,
    preferences: state.preferences,
  }
}

const WEB_CATALOG = 'neuron-map-workspaces-v1'
function webCatalog(): WorkspaceBootstrap {
  const raw = window.localStorage.getItem(WEB_CATALOG)
  if (raw) return JSON.parse(raw)
  const timestamp = Date.now()
  return { workspaces: [{ id: 'web-default', name: 'Main', createdAt: timestamp, updatedAt: timestamp, nodeCount: 0 }], lastWorkspaceId: 'web-default' }
}
function saveWebCatalog(catalog: WorkspaceBootstrap) { window.localStorage.setItem(WEB_CATALOG, JSON.stringify(catalog)) }

async function invokeBootstrap(): Promise<WorkspaceBootstrap> {
  if (!isTauri()) return webCatalog()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceBootstrap>('bootstrap_workspaces')
}

async function invokeLoadWorkspace(workspaceId: string): Promise<PersistedState> {
  if (!isTauri()) {
    const raw = window.localStorage.getItem(`neuron-map-workspace-${workspaceId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...parsed, ...validateGraph(parsed), revision: parsed.revision ?? 0 }
    }
    if (workspaceId === 'web-default') return legacyState() ?? { nodes: [], edges: [], trash: emptyTrash(), revision: 0, camera: DEFAULT_CAMERA, preferences: DEFAULT_PREFERENCES }
    return { nodes: [], edges: [], trash: emptyTrash(), revision: 0, camera: DEFAULT_CAMERA, preferences: DEFAULT_PREFERENCES }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const raw = await invoke<RustState>('load_workspace', { workspaceId })
  return fromRust(raw)
}

function writeWebState(workspaceId: string, state: PersistedState): number {
  const key = `neuron-map-workspace-${workspaceId}`
  const saved = window.localStorage.getItem(key)
  const revision = saved ? JSON.parse(saved).revision ?? 0 : 0
  if (state.revision !== revision) throw new Error('SAVE_CONFLICT: Another tab changed this workspace. Save a backup copy, then reload.')
  const catalog = webCatalog(), workspace = catalog.workspaces.find(item => item.id === workspaceId)
  if (!workspace) throw new Error('Workspace no longer exists.')
  window.localStorage.setItem(key, JSON.stringify({ ...state, revision: revision + 1 }))
  workspace.nodeCount = state.nodes.length; workspace.updatedAt = Date.now(); catalog.lastWorkspaceId = workspaceId
  // The graph transaction is already committed. A full catalog must not turn
  // this into a false failed save with an outdated expected revision.
  try { saveWebCatalog(catalog) } catch { /* Counts are recomputed on load. */ }
  return revision + 1
}
async function webLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(`neuron-map-${workspaceId}`, action)
  return action()
}
async function invokeSaveWorkspace(workspaceId: string, state: PersistedState, createBackup: boolean): Promise<number> {
  if (!isTauri()) return webLock(workspaceId, async () => {
    const current = await invokeLoadWorkspace(workspaceId)
    if (state.revision !== current.revision) throw new Error('SAVE_CONFLICT: Another tab changed this workspace. Save a backup copy, then reload.')
    const backups = await webSnapshots<PersistedState>(workspaceId)
    if (createBackup || !backups.length || Date.now() - backups[0].createdAt >= AUTOSAVE_INTERVAL_MS) await putWebSnapshot(workspaceId, state)
    return writeWebState(workspaceId, state)
  })
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<number>('save_workspace', { workspaceId, state: toRust(state), createBackup })
}

async function hydrateOnce(): Promise<{
  camera: CameraSnapshot
  preferences: AppPreferences
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo
}> {
  const bootstrap = await invokeBootstrap()
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.lastWorkspaceId) ?? bootstrap.workspaces[0]
  if (!activeWorkspace) throw new Error('Neuron Map could not create a workspace.')

  // A failed database read is not an empty workspace. Propagate the error so
  // nothing can overwrite the existing graph with fallback data.
  const loaded = await invokeLoadWorkspace(activeWorkspace.id)
  activeWorkspaceId = activeWorkspace.id
  activeRevision = loaded.revision
  activeWorkspaceName = activeWorkspace.name
  graphEngine.syncGraph(loaded.nodes, loaded.edges, true)
  useGraphStore.getState().hydrateGraph(loaded.nodes, loaded.edges, loaded.trash)
  cameraSnapshot = loaded.camera ?? DEFAULT_CAMERA
  preferencesSnapshot = { ...DEFAULT_PREFERENCES, ...(loaded.preferences ?? {}) }
  hydrated = true
  emitStatus({ state: 'saved', savedAt: Date.now() })

  // Immediately persist a recovered legacy graph into the workspace database.
  if (loaded.nodes.length && activeWorkspace.nodeCount === 0) await flushPersist({ createBackup: true })

  return { camera: cameraSnapshot, preferences: preferencesSnapshot, workspaces: bootstrap.workspaces, activeWorkspace }
}

export function hydratePersistence() {
  if (!hydrationPromise) hydrationPromise = hydrateOnce().catch((error) => { hydrationPromise = null; throw error })
  return hydrationPromise
}

export async function reloadWorkspace(workspaceId: string, skipSave = false): Promise<{
  camera: CameraSnapshot
  preferences: AppPreferences
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo
}> {
  if (skipSave && savePromise) await savePromise.catch(() => {})
  if (!skipSave) await flushPersist({ createBackup: false })
  const loaded = await invokeLoadWorkspace(workspaceId)
  const bootstrap = await invokeBootstrap()
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === workspaceId)
  if (!activeWorkspace) throw new Error('Workspace no longer exists.')
  loading = true
  try {
    graphEngine.stop()
    graphEngine.syncGraph(loaded.nodes, loaded.edges, true)
    activeWorkspaceId = workspaceId
    activeRevision = loaded.revision
    activeWorkspaceName = activeWorkspace.name
    clearSaveTimers(); retryAttempt = 0
    useGraphStore.getState().hydrateGraph(loaded.nodes, loaded.edges, loaded.trash)
    cameraSnapshot = loaded.camera ?? DEFAULT_CAMERA
    preferencesSnapshot = { ...DEFAULT_PREFERENCES, ...(loaded.preferences ?? {}) }
    changeVersion += 1
    if (!isTauri()) saveWebCatalog({ ...bootstrap, lastWorkspaceId: workspaceId })
    emitStatus({ state: 'saved', savedAt: Date.now() })
  } finally { loading = false }
  return { camera: cameraSnapshot, preferences: preferencesSnapshot, workspaces: bootstrap.workspaces, activeWorkspace }

}

export async function createNewWorkspace(name: string) {
  await flushPersist({ createBackup: true })
  if (!isTauri()) {
    const workspace: WorkspaceInfo = { id: `web-${crypto.randomUUID()}`, name: name.trim() || 'Untitled workspace', createdAt: Date.now(), updatedAt: Date.now(), nodeCount: 0 }
    const catalog = webCatalog()
    saveWebCatalog({ workspaces: [...catalog.workspaces, workspace], lastWorkspaceId: workspace.id })
    return workspace
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceInfo>('create_workspace', { name })
}

export async function renameCurrentWorkspace(workspaceId: string, name: string) {
  if (workspaceId === activeWorkspaceId) activeWorkspaceName = name.trim() || 'Untitled workspace'
  if (!isTauri()) {
    const catalog = webCatalog()
    const workspace = catalog.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Workspace no longer exists.')
    workspace.name = name.trim().slice(0, 80) || 'Untitled workspace'
    saveWebCatalog(catalog)
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('rename_workspace', { workspaceId, name })
}

export async function deleteWorkspace(workspaceId: string): Promise<WorkspaceBootstrap> {
  await flushPersist({ createBackup: true })
  let result: WorkspaceBootstrap
  if (!isTauri()) {
    const catalog = webCatalog()
    if (catalog.workspaces.length <= 1) throw new Error('At least one workspace must remain.')
    const workspaces = catalog.workspaces.filter((item) => item.id !== workspaceId)
    result = { workspaces, lastWorkspaceId: catalog.lastWorkspaceId === workspaceId ? workspaces[0].id : catalog.lastWorkspaceId }
    saveWebCatalog(result)
    window.localStorage.removeItem(`neuron-map-workspace-${workspaceId}`)
    await deleteWorkspaceFiles(workspaceId)
  } else {
    const { invoke } = await import('@tauri-apps/api/core')
    result = await invoke<WorkspaceBootstrap>('delete_workspace', { workspaceId })
  }
  if (workspaceId === activeWorkspaceId) activeWorkspaceId = null
  return result

}

export async function refreshWorkspaces() {
  return invokeBootstrap()
}


export type WorkspaceExportResult = {
  path: string
}

function memoryState(): PersistedState {
  return { ...graphSnapshot(), camera: getCameraSnapshot(), preferences: { ...preferencesSnapshot }, revision: activeRevision }
}
export async function exportBackupCopy(workspaceId: string): Promise<WorkspaceExportResult | null> {
  const state = memoryState()
  validateGraph(state)
  const name = activeWorkspaceName
  const payload = JSON.stringify({ format: 'neuron-map-workspace', version: 3, exported_at: Date.now(),
    workspace: { name, created_at: Date.now(), updated_at: Date.now() }, state: toRust(state), files: await exportFiles(workspaceId, graphAttachments(state)) }, null, 2)
  const blob = new Blob([payload], { type: 'application/json' })
  if (blob.size > MAX_WORKSPACE_FILE_BYTES) throw new Error('Workspace export exceeds 100 MiB.')
  const suggestedName = `${webSafeName(name)}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.neuron`
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<WorkspaceExportResult | null>('save_workspace_copy', { payload, suggestedName })
  }
  downloadBlob(blob, suggestedName)
  return { path: suggestedName }
}
const webSafeName = (name: string) => name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) || 'Workspace'
export async function exportCurrentWorkspace(workspaceId: string): Promise<WorkspaceExportResult | null> {
  await flushPersist({ createBackup: false })
  if (!isTauri()) return exportBackupCopy(workspaceId)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceExportResult>('export_workspace_file', { workspaceId })
}

export type WorkspaceImportResult = {
  workspace: WorkspaceInfo
  fileName: string
}

export async function importWorkspaceFile(): Promise<WorkspaceImportResult | null> {
  if (!isTauri()) {
    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = '.neuron,.json'
      input.onchange = () => { resolve(input.files?.[0] ?? null); input.remove() }
      input.addEventListener('cancel', () => { resolve(null); input.remove() }, { once: true })
      input.style.display = 'none'; document.body.appendChild(input); input.click()
    })
    if (!file) return null
    if (file.size > MAX_WORKSPACE_FILE_BYTES) throw new Error('Workspace exceeds 100 MiB.')
    const imported = parseWorkspaceFile(await file.text())
    const catalog = webCatalog()
    const base = imported.name.trim().slice(0, 80) || 'Imported workspace'
    let name = base, suffix = 2
    while (catalog.workspaces.some((w) => w.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${base} (${suffix++})`
    const workspace: WorkspaceInfo = { id: `web-${crypto.randomUUID()}`, name, createdAt: Date.now(), updatedAt: Date.now(), nodeCount: imported.state.nodes.length }
    try {
      await importFiles(workspace.id, imported.files)
      window.localStorage.setItem(`neuron-map-workspace-${workspace.id}`, JSON.stringify(fromRust(imported.state as RustState)))
      saveWebCatalog({ workspaces: [...catalog.workspaces, workspace], lastWorkspaceId: workspace.id })
    } catch (error) {
      window.localStorage.removeItem(`neuron-map-workspace-${workspace.id}`)
      await deleteWorkspaceFiles(workspace.id).catch(() => {})
      throw error
    }
    return { workspace, fileName: file.name }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceImportResult | null>('pick_and_import_workspace_file')
}

export async function listWorkspaceBackups(workspaceId: string): Promise<WorkspaceBackup[]> {
  if (!isTauri()) return (await webSnapshots<PersistedState>(workspaceId)).map(({ id, createdAt, state }) => ({ id, createdAt,
    nodeCount: state.nodes.length, trashCount: state.trash?.nodes.length ?? 0,
    fileCount: graphAttachments({ ...state, trash: state.trash ?? emptyTrash() }).length, titles: state.nodes.slice(0, 6).map(n => n.title) }))
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceBackup[]>('list_workspace_backups', { workspaceId })
}
export async function restoreWorkspaceBackup(workspaceId: string, backupId: number) {
  // Wait for an in-flight save, but don't create a snapshot that could evict the target.
  if (savePromise) await savePromise
  clearSaveTimers()
  const current = memoryState()
  try {
    if (!isTauri()) await webLock(workspaceId, async () => {
      const selected = (await webSnapshots<PersistedState>(workspaceId)).find(b => b.id === backupId)
      if (!selected) throw new Error('Recovery snapshot no longer exists.')
      const loaded = await invokeLoadWorkspace(workspaceId)
      if (loaded.revision !== activeRevision) throw new Error('SAVE_CONFLICT: Save a backup copy of your edits before reloading.')
      await putWebSnapshot(workspaceId, current)
      activeRevision = writeWebState(workspaceId, { ...selected.state, ...validateGraph(selected.state), revision: activeRevision })
    })
    else {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('restore_workspace_backup', { workspaceId, backupId, current: toRust(current) })
    }
    return await reloadWorkspace(workspaceId, true)
  } catch (error) { schedulePersist(); throw error }
}
export async function cleanupUnusedAttachments(workspaceId: string, dryRun = true) {
  // Both current edits and session undo/redo must survive cleanup without a save.
  const protectedIds = new Set([...graphAttachments(memoryState()).map(file => file.id), ...historyAttachmentIds()])
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<{ fileCount: number; bytes: number }>('cleanup_attachments', { workspaceId, protectedIds: [...protectedIds], dryRun })
  }
  return webLock(workspaceId, async () => {
    const saved = await invokeLoadWorkspace(workspaceId)
    if (saved.revision !== activeRevision) throw new Error('Reload this workspace before cleaning up files.')
    for (const file of graphAttachments(saved)) protectedIds.add(file.id)
    for (const backup of await webSnapshots<PersistedState>(workspaceId)) {
      for (const file of graphAttachments(validateGraph(backup.state))) protectedIds.add(file.id)
    }
    // Cross-tab in-memory edits are unknown; only the native single-instance app
    // can safely reclaim blobs. Browser mode reports candidates without deletion.
    if (!dryRun) throw new Error('File cleanup is available in the desktop app. Browser tabs may still reference these files.')
    return cleanupWebFiles(workspaceId, protectedIds, true)
  })
}

function cameraSnapshotsClose(a: CameraSnapshot, b: CameraSnapshot, epsilon = 0.0005) {
  const near = (x: number, y: number) => Math.abs(x - y) <= epsilon
  return a.position.every((value, index) => near(value, b.position[index]))
    && a.quaternion.every((value, index) => near(value, b.quaternion[index]))
    && a.orbitTarget.every((value, index) => near(value, b.orbitTarget[index]))
}

export function getCameraSnapshot(): CameraSnapshot {
  return {
    position: [...cameraSnapshot.position] as CameraSnapshot['position'],
    quaternion: [...cameraSnapshot.quaternion] as CameraSnapshot['quaternion'],
    orbitTarget: [...cameraSnapshot.orbitTarget] as CameraSnapshot['orbitTarget'],
  }
}

export function setCameraSnapshot(next: CameraSnapshot) {
  // Camera components report their state frequently (OrbitControls damping and
  // flight sampling). Keep the latest snapshot in memory, mark the workspace
  // dirty, and let the five-minute autosave persist the final state.
  if (cameraSnapshotsClose(cameraSnapshot, next)) return
  cameraSnapshot = next
  schedulePersist()
}

export function setPreferences(next: AppPreferences) {
  preferencesSnapshot = next
  schedulePersist()
}

export function schedulePersist() {
  if (!hydrated || loading || typeof window === 'undefined' || !activeWorkspaceId) return
  changeVersion += 1
  if (status.state !== 'dirty' && status.state !== 'error') emitStatus({ state: 'dirty', savedAt: status.savedAt })

  // Start one autosave window from the first unsaved change. Further edits do
  // not reset the timer, so active editing cannot postpone the save forever.
  // Manual Ctrl+S, workspace switching and app close still flush immediately.
  if (saveTimer !== null || retryTimer !== null || status.state === 'error') return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void flushPersist({ createBackup: true }).catch(() => { /* Status and error banner report the failed save. */ })
  }, AUTOSAVE_INTERVAL_MS)
}

export function getActiveWorkspaceId() { return activeWorkspaceId }

function graphSnapshot() {
  const graph = useGraphStore.getState()
  const runtime = graphEngine.runtime
  const matches = graph.nodes.length === runtime.ids.length && graph.nodes.every((node, i) => node.id === runtime.ids[i])
  const nodes = matches ? graph.nodes.map((node) => ({ ...node, position: runtime.positionOf(node.id) ?? node.position })) : graph.nodes
  return { nodes, edges: graph.edges, trash: graph.trash }
}

function clearSaveTimers() {
  if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null }
  if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null }
}
export async function flushPersist(options: { createBackup?: boolean; retry?: boolean } = {}): Promise<void> {
  if (savePromise) { await savePromise; return flushPersist(options) }
  if (!hydrated || !activeWorkspaceId) return
  clearSaveTimers()
  if (!options.retry) retryAttempt = 0
  const workspaceId = activeWorkspaceId, version = changeVersion, state = memoryState()
  emitStatus({ state: 'saving', savedAt: status.savedAt })
  savePromise = invokeSaveWorkspace(workspaceId, state, Boolean(options.createBackup))
  try {
    activeRevision = await savePromise
    retryAttempt = 0
    emitStatus({ state: changeVersion === version ? 'saved' : 'dirty', savedAt: Date.now() })
    if (changeVersion !== version && saveTimer === null) {
      saveTimer = window.setTimeout(() => { saveTimer = null; void flushPersist({ createBackup: true }).catch(() => {}) }, AUTOSAVE_INTERVAL_MS)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const willRetry = !message.includes('SAVE_CONFLICT') && retryAttempt < RETRY_DELAYS.length
    emitStatus({ state: 'error', savedAt: status.savedAt, message: message + (willRetry ? ' Automatic retry pending.' : ' Use Retry or save a backup copy.') })
    if (willRetry) retryTimer = window.setTimeout(() => {
      retryTimer = null; void flushPersist({ createBackup: true, retry: true }).catch(() => {})
    }, RETRY_DELAYS[retryAttempt++])
    throw error
  } finally { savePromise = null }
}

export function installGraphPersistenceSubscription() {
  const unsubscribe = useGraphStore.subscribe((state, previous) => {
    if (loading) return
    if (state.nodes !== previous.nodes || state.edges !== previous.edges || state.trash !== previous.trash) schedulePersist()
  })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (isTauri() || status.state === 'saved') return
    // Web storage writes synchronously; keep the browser's warning if saving fails.
    const snapshot = memoryState()
    try {
      if (activeWorkspaceId) { activeRevision = writeWebState(activeWorkspaceId, snapshot); clearSaveTimers(); emitStatus({ state: 'saved', savedAt: Date.now() }) }
    } catch { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', beforeUnload)
  return () => { unsubscribe(); window.removeEventListener('beforeunload', beforeUnload) }
}
