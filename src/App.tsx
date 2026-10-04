import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GraphScene } from './components/GraphScene'
import { Inspector } from './components/Inspector'
import { SearchPanel } from './components/SearchPanel'
import { RecoveryPanel } from './components/RecoveryPanel'
import { WorkspaceMenu } from './components/WorkspaceMenu'
import { useGraphStore } from './store/useGraphStore'
import {
  createNewWorkspace,
  deleteWorkspace,
  exportCurrentWorkspace,
  exportBackupCopy,
  flushPersist,
  getPersistenceStatus,
  getCameraSnapshot,
  hydratePersistence,
  importWorkspaceFile,
  installGraphPersistenceSubscription,
  refreshWorkspaces,
  reloadWorkspace,
  renameCurrentWorkspace,
  setPreferences,
  subscribePersistenceStatus,
  type PersistenceStatus,
  type WorkspaceInfo,
} from './services/persistence'
import type { AppPreferences, CameraSnapshot } from './types'
import './styles.css'

export default function App() {
  const [editorOpen, setEditorOpen] = useState(true)
  const [linkToolActive, setLinkToolActive] = useState(false)
  const [ready, setReady] = useState(false)
  const [initialCamera, setInitialCamera] = useState<CameraSnapshot | null>(null)
  const [search, setSearch] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [sceneRevision, setSceneRevision] = useState(0)
  const navigation = useRef<{ ids: string[]; index: number; moving: boolean }>({ ids: [], index: -1, moving: false })
  const [, setNavigationTick] = useState(0)
  const [busyMessage, setBusyMessage] = useState('Working…')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preferences, setPrefs] = useState<AppPreferences>({ linkNavigationEnabled: false })
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const busyRef = useRef(false)
  const setBusy = (busy: boolean, message = 'Working…') => { busyRef.current = busy; setWorkspaceBusy(busy); setBusyMessage(message) }
  const [saveStatus, setSaveStatus] = useState<PersistenceStatus>(getPersistenceStatus())
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const selectionVersion = useGraphStore((s) => s.selectionVersion)
  const selectedId = useGraphStore((s) => s.selectedId)
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId)
  const setSelected = useGraphStore((s) => s.setSelected)
  const addNode = useGraphStore((s) => s.addNode)
  const deleteNode = useGraphStore((s) => s.deleteNode)
  const deleteEdge = useGraphStore((s) => s.deleteEdge)
  const resetGraph = useGraphStore((s) => s.resetGraph)
  const autoArrange = useGraphStore((s) => s.autoArrange)
  const undoDepth = useGraphStore(s => s.undoDepth), redoDepth = useGraphStore(s => s.redoDepth)
  const neighborhoodId = useGraphStore(s => s.neighborhoodId)

  useEffect(() => subscribePersistenceStatus(setSaveStatus), [])

  useEffect(() => {
    let cancelled = false
    let unsubscribe = () => {}
    void hydratePersistence()
      .then(({ camera, preferences: loadedPreferences, workspaces: loadedWorkspaces, activeWorkspace: loadedActive }) => {
        if (cancelled) return
        setInitialCamera(camera)
        setPrefs(loadedPreferences)
        setWorkspaces(loadedWorkspaces)
        setActiveWorkspace(loadedActive)
        setReady(true)
        unsubscribe = installGraphPersistenceSubscription()
      })
      .catch((error) => {
        if (cancelled) return
        setWorkspaceError(error instanceof Error ? error.message : String(error))
        setReady(true)
      })
    return () => { cancelled = true; unsubscribe() }
  }, [])

  // Tauri can close the WebView before a debounced JavaScript save fires. Intercept
  // the desktop close request, flush the workspace transaction, then destroy the window.
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let closing = false
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow()
      unlisten = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault()
        if (closing || busyRef.current) return
        closing = true
        setBusy(true)
        try {
          await flushPersist({ createBackup: true })
        } catch (error) {
          setWorkspaceError(`Could not save before closing: ${String(error)}`)
          closing = false; setBusy(false)
          return
        }
        if (disposed) return
        const candidate = appWindow as unknown as { destroy?: () => Promise<void>; close?: () => Promise<void> }
        try {
          if (candidate.destroy) await candidate.destroy()
          else if (candidate.close) await candidate.close()
        } catch (error) { closing = false; setBusy(false); setWorkspaceError(String(error)) }
      })
      if (disposed) unlisten?.()
    }).catch((error) => { if (!disposed) setWorkspaceError(`Close handler: ${String(error)}`) })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => { if (selectedId) setEditorOpen(true) }, [selectedId, selectionVersion])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsOpen) return
      if (settingsRef.current?.contains(event.target as Node)) return
      setSettingsOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [settingsOpen])

  useEffect(() => { navigation.current = { ids: [], index: -1, moving: false }; setNavigationTick(t => t + 1) }, [activeWorkspace?.id, sceneRevision])
  useEffect(() => {
    const history = navigation.current
    if (history.moving) { history.moving = false; return }
    if (selectedId && history.ids[history.index] !== selectedId) {
      history.ids = [...history.ids.slice(0, history.index + 1), selectedId].slice(-100)
      history.index = history.ids.length - 1; setNavigationTick(t => t + 1)
    }
  }, [selectedId, activeWorkspace?.id, sceneRevision])
  const travelNotes = (direction: number) => {
    const history = navigation.current, ids = new Set(useGraphStore.getState().nodes.map(n => n.id))
    let next = history.index + direction
    while (next >= 0 && next < history.ids.length && !ids.has(history.ids[next])) next += direction
    if (next < 0 || next >= history.ids.length) return
    history.index = next; history.moving = true; setNavigationTick(t => t + 1)
    navigateToNode(history.ids[next])
  }

  const navigateToNode = (id: string) => {
    if (!useGraphStore.getState().nodes.some(n => n.id === id)) return
    useGraphStore.getState().setNeighborhood(null)
    setSelected(id)
    setEditorOpen(true)
    setSearch('')
    setFocusRequest({ id, token: Date.now() + Math.random() })
  }


  const createNodeInView = () => {
    const snapshot = getCameraSnapshot()
    const position = new THREE.Vector3(...snapshot.position)
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(new THREE.Quaternion(...snapshot.quaternion))
      .normalize()
    position.addScaledVector(forward, 4.2)
    const id = addNode([position.x, position.y, position.z])
    navigateToNode(id)
  }

  const updatePreferences = (patch: Partial<AppPreferences>) => {
    const next = { ...preferences, ...patch }
    setPrefs(next)
    setPreferences(next)
  }

  const syncWorkspaceList = async (preferredId?: string) => {
    const bootstrap = await refreshWorkspaces()
    setWorkspaces(bootstrap.workspaces)
    const id = preferredId ?? activeWorkspace?.id ?? bootstrap.lastWorkspaceId
    const current = bootstrap.workspaces.find((workspace) => workspace.id === id) ?? bootstrap.workspaces[0]
    if (current) setActiveWorkspace(current)
  }

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceBusy || workspaceId === activeWorkspace?.id) return
    setBusy(true)
    setWorkspaceError(null)
    setSearch('')
    setLinkToolActive(false)
    try {
      const result = await reloadWorkspace(workspaceId)
      setInitialCamera(result.camera)
      setPrefs(result.preferences)
      setWorkspaces(result.workspaces)
      setActiveWorkspace(result.activeWorkspace)
      setFocusRequest(null)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const newWorkspace = async () => {
    if (workspaceBusy) return
    const name = window.prompt('Name for the new workspace:', 'New workspace')
    if (name === null) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const workspace = await createNewWorkspace(name)
      const result = await reloadWorkspace(workspace.id)
      setInitialCamera(result.camera)
      setPrefs(result.preferences)
      setWorkspaces(result.workspaces)
      setActiveWorkspace(result.activeWorkspace)
      setFocusRequest(null)
      setSearch('')
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const renameWorkspace = async () => {
    if (!activeWorkspace || workspaceBusy) return
    const name = window.prompt('Rename workspace:', activeWorkspace.name)
    if (name === null || !name.trim()) return
    setBusy(true)
    try {
      await renameCurrentWorkspace(activeWorkspace.id, name)
      await syncWorkspaceList(activeWorkspace.id)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeWorkspace = async (workspaceId: string) => {
    if (!activeWorkspace || workspaceBusy || workspaces.length <= 1) return
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
    if (!window.confirm(`Delete workspace “${workspace?.name ?? 'Untitled'}”? This removes its notes from the active database.`)) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const bootstrap = await deleteWorkspace(workspaceId)
      setWorkspaces(bootstrap.workspaces)
      if (workspaceId === activeWorkspace.id) {
        const result = await reloadWorkspace(bootstrap.lastWorkspaceId)
        setInitialCamera(result.camera)
        setPrefs(result.preferences)
        setWorkspaces(result.workspaces)
        setActiveWorkspace(result.activeWorkspace)
        setFocusRequest(null)
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const saveNow = async () => {
    if (workspaceBusy) return
    setWorkspaceError(null)
    try {
      await flushPersist({ createBackup: true })
      await syncWorkspaceList(activeWorkspace?.id)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    }
  }

  const exportWorkspace = async () => {
    if (!activeWorkspace || workspaceBusy) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const result = await exportCurrentWorkspace(activeWorkspace.id)
      await syncWorkspaceList(activeWorkspace.id)
      if (result) window.alert(`Workspace exported successfully.\n\n${result.path}`)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const backupCopy = async () => {
    if (!activeWorkspace || busyRef.current) return
    setBusy(true, 'Preparing backup copy…')
    try { const result = await exportBackupCopy(activeWorkspace.id); if (result) window.alert(`Backup saved: ${result.path}`) }
    catch (error) { setWorkspaceError(String(error)) } finally { setBusy(false) }
  }
  const reloadSaved = async () => {
    if (!activeWorkspace || busyRef.current || !window.confirm('Reload the saved workspace? Save a backup copy first if you want to keep your unsaved edits.')) return
    setBusy(true)
    try {
      const result = await reloadWorkspace(activeWorkspace.id, true)
      setInitialCamera(result.camera); setPrefs(result.preferences); setWorkspaces(result.workspaces); setActiveWorkspace(result.activeWorkspace)
      setSceneRevision(v => v + 1); setWorkspaceError(null); setFocusRequest(null)
    } catch (error) { setWorkspaceError(String(error)) } finally { setBusy(false) }
  }

  const importWorkspace = async () => {
    if (workspaceBusy) return
    setBusy(true)
    setWorkspaceError(null)
    setSearch('')
    setLinkToolActive(false)
    try {
      await flushPersist({ createBackup: true })
      const importedFile = await importWorkspaceFile()
      if (!importedFile) return
      const result = await reloadWorkspace(importedFile.workspace.id)
      setInitialCamera(result.camera)
      setPrefs(result.preferences)
      setWorkspaces(result.workspaces)
      setActiveWorkspace(result.activeWorkspace)
      setFocusRequest(null)
      window.alert(`Imported “${result.activeWorkspace.name}” from ${importedFile.fileName}.`)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (busyRef.current || document.querySelector('dialog[open]')) return
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (!typing && (event.ctrlKey || event.metaKey) && (event.code === 'KeyZ' || event.code === 'KeyY')) {
        event.preventDefault(); if (event.shiftKey || event.code === 'KeyY') useGraphStore.getState().redo(); else useGraphStore.getState().undo(); return
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
        event.preventDefault()
        void saveNow()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || workspaceBusy) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) { event.preventDefault(); deleteEdge(selectedEdgeId); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) { event.preventDefault(); deleteNode(selectedId); return }
      if (event.code === 'KeyN') createNodeInView()
      if (event.code === 'KeyL') setLinkToolActive((value) => !value)
      if (event.code === 'KeyE') setEditorOpen((value) => !value)
      if (event.code === 'Escape') { setLinkToolActive(false); setSearch(''); setSettingsOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeWorkspace?.id, deleteEdge, deleteNode, selectedEdgeId, selectedId, workspaceBusy])

  if (!ready) {
    return <main className="boot-screen"><div className="boot-mark">✦</div><strong>Neuron Map</strong><span>Opening local workspaces…</span></main>
  }

  if (!initialCamera || !activeWorkspace) {
    return (
      <main className="boot-screen boot-error">
        <div className="boot-mark">!</div><strong>Could not open the knowledge database</strong>
        <span>{workspaceError ?? 'No workspace is available.'}</span>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-and-workspace">
          <div className="brand-group"><span className="brand-glyph">✦</span><div><strong>Neuron Map</strong><span className="version">0.22.2</span></div></div>
          <WorkspaceMenu
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            status={saveStatus}
            busy={workspaceBusy}
            onSwitch={(id) => void switchWorkspace(id)}
            onNew={() => void newWorkspace()}
            onRename={() => void renameWorkspace()}
            onDelete={(id) => void removeWorkspace(id)}
            onSave={() => void saveNow()}
            onExport={() => void exportWorkspace()}
            onImport={() => void importWorkspace()}
            onRecovery={() => setRecoveryOpen(true)}
            onBackup={() => void backupCopy()}
          />
        </div>

        <div className="search-shell">
          <span className="search-icon">⌕</span>
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notes, #tags, files…" />
          {search ? <button onClick={() => setSearch('')}>×</button> : null}
          <SearchPanel query={search} onQueryChange={setSearch} onNavigate={navigateToNode} />
        </div>

        <div className="top-stats">
          <span>{nodeCount} notes</span><i /><span>{edgeCount} links</span><i />
          <span className={`save-indicator ${saveStatus.state}`}>●</span><span>{saveStatus.state === 'saving' ? 'Saving…' : saveStatus.state === 'dirty' ? 'Unsaved' : saveStatus.state === 'error' ? 'Save failed' : 'Saved'}</span>
        </div>

        <div className="toolbar top-right-toolbar">
          <button title="Back to previous note" aria-label="Back to previous note" disabled={navigation.current.index <= 0} onClick={() => travelNotes(-1)}>←</button>
          <button title="Forward to next note" aria-label="Forward to next note" disabled={navigation.current.index >= navigation.current.ids.length - 1} onClick={() => travelNotes(1)}>→</button>
          <button disabled={!undoDepth} title="Undo (Ctrl+Z outside the editor)" onClick={() => useGraphStore.getState().undo()}>Undo</button>
          <button disabled={!redoDepth} title="Redo (Ctrl+Shift+Z)" onClick={() => useGraphStore.getState().redo()}>Redo</button>
          <button className={`save-button ${saveStatus.state === 'dirty' ? 'dirty' : ''}`} onClick={() => void saveNow()} title="Save workspace and create a recovery snapshot (Ctrl+S)">Save</button>
          <button onClick={() => { setLinkToolActive(false); createNodeInView() }}>+ New node</button>
          <button className={linkToolActive ? 'active link-tool-active' : ''} onClick={() => setLinkToolActive((value) => !value)}>↗ New link</button>
          {selectedEdgeId ? <button className="danger-link" onClick={() => deleteEdge(selectedEdgeId)}>Delete link</button> : null}
          <button className={editorOpen ? 'active' : ''} onClick={() => setEditorOpen((v) => !v)}>Editor</button>
          <div className="settings-anchor" ref={settingsRef}>
            <button className={settingsOpen ? 'active' : ''} onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
            {settingsOpen ? (
              <div className="settings-popover">
                <div className="settings-title">NAVIGATION</div>
                <label className="toggle-row">
                  <div>
                    <strong>Internal note navigation</strong>
                    <span>Enable connected-note shortcuts and clickable [[wiki-links]] inside Content Read mode.</span>
                  </div>
                  <input type="checkbox" checked={preferences.linkNavigationEnabled} onChange={(e) => updatePreferences({ linkNavigationEnabled: e.target.checked })} />
                </label>

                <div className="settings-divider" />
                <div className="settings-title">GRAPH</div>
                <label className="toggle-row"><div><strong>Reduced motion</strong><span>Pause link particles when the graph is still.</span></div><input type="checkbox" checked={preferences.reducedMotion ?? false} onChange={e => updatePreferences({ reducedMotion: e.target.checked })} /></label>
                <div className="settings-actions">
                  <button onClick={() => { autoArrange(); setSettingsOpen(false) }}>Auto layout</button>
                  <button className="danger-setting" onClick={() => {
                    if (window.confirm('Reset only the current workspace to the demo notes?')) {
                      resetGraph()
                      setSettingsOpen(false)
                    }
                  }}>Reset graph</button>
                </div>
                <div className="settings-divider" />
                <div className="settings-title">SAVING</div>
                <div className="settings-tip save-settings-copy">
                  Unsaved changes are autosaved to SQLite every <b>5 minutes</b>. <b>Ctrl+S</b> saves immediately and creates a recovery snapshot. Neuron Map also saves before the desktop window closes or when switching workspaces.
                </div>
                <div className="settings-tip">Wiki syntax: <code>[[Note title]]</code> or <code>[[Note title|custom label]]</code>.</div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {workspaceError || saveStatus.state === 'error' ? <div className="workspace-error-banner" role="alert"><span>{workspaceError ?? saveStatus.message}</span>{saveStatus.state === 'error' ? <><button onClick={() => void saveNow()}>Retry</button><button onClick={() => void backupCopy()}>Save backup copy…</button><button onClick={() => void reloadSaved()}>Reload saved</button></> : <button onClick={() => setWorkspaceError(null)}>×</button>}</div> : null}
      {workspaceBusy ? <div className="workspace-busy-overlay" role="status">{busyMessage}</div> : null}

      <section className={`workspace ${editorOpen ? '' : 'editor-closed'}`}>
        <div className="scene-wrap">
          <GraphScene
            key={`${activeWorkspace.id}-${sceneRevision}`}
            reducedMotion={preferences.reducedMotion ?? false}
            disabled={workspaceBusy || recoveryOpen}
            initialCamera={initialCamera}
            linkToolActive={linkToolActive}
            onLinkToolChange={setLinkToolActive}
            focusRequest={focusRequest}
          />
          {neighborhoodId ? <div className="neighborhood-banner">Showing this note and its neighbors <button onClick={() => useGraphStore.getState().setNeighborhood(null)}>Show all</button></div> : null}
          <div className="scene-help"><span>Search</span><b>Ctrl+K · title, description, content</b><span>Save</span><b>Ctrl+S · autosave every 5 min</b><span>Cursor</span><b>drag orbit · RMB pan · scroll zoom</b><span>Flight</span><b>F · WASD · mouse · Shift boost</b><span>Links</span><b>select line · Delete removes it</b></div>
          <div className="shortcut-help">{preferences.linkNavigationEnabled ? 'Internal navigation ON · linked notes + [[wiki-links]]' : 'Internal navigation OFF · enable it in ⚙ Settings'}</div>
        </div>
        <Inspector onBusyChange={setBusy} open={editorOpen} linkNavigationEnabled={preferences.linkNavigationEnabled} onNavigate={navigateToNode} />
      </section>
      {recoveryOpen ? <RecoveryPanel workspaceId={activeWorkspace.id} onClose={() => setRecoveryOpen(false)} onBusyChange={setBusy} onRestored={result => {
        setInitialCamera(result.camera); setPrefs(result.preferences); setWorkspaces(result.workspaces); setActiveWorkspace(result.activeWorkspace); setFocusRequest(null); setSceneRevision(v => v + 1); setWorkspaceError(null)
      }} /> : null}
    </main>
  )
}
