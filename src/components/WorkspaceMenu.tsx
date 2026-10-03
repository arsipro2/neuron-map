import { useEffect, useRef, useState } from 'react'
import type { PersistenceStatus, WorkspaceInfo } from '../services/persistence'

type Props = {
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo
  status: PersistenceStatus
  busy: boolean
  onSwitch: (id: string) => void
  onNew: () => void
  onRename: () => void
  onDelete: (id: string) => void
  onSave: () => void
  onExport: () => void
  onImport: () => void
  onRecovery: () => void
  onBackup: () => void
}

function savedLabel(status: PersistenceStatus) {
  if (status.state === 'saving') return 'Saving…'
  if (status.state === 'dirty') return 'Unsaved changes'
  if (status.state === 'error') return 'Save failed'
  return 'Saved'
}

export function WorkspaceMenu({ workspaces, activeWorkspace, status, busy, onSwitch, onNew, onRename, onDelete, onSave, onExport, onImport, onRecovery, onBackup }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <div className="workspace-menu-anchor" ref={rootRef}>
      <button className="workspace-switcher" onClick={() => setOpen((value) => !value)} disabled={busy} title="Switch workspace">
        <span className="workspace-switcher-dot" />
        <span className="workspace-switcher-name">{activeWorkspace.name}</span>
        <span className="workspace-switcher-chevron">⌄</span>
      </button>
      {open ? (
        <div className="workspace-popover">
          <div className="workspace-popover-head">
            <div><strong>Workspaces</strong><span>Separate saved knowledge environments</span></div>
            <button onClick={() => { onNew(); setOpen(false) }}>+ New</button>
          </div>
          <div className="workspace-list">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                className={`workspace-row ${workspace.id === activeWorkspace.id ? 'active' : ''}`}
                onClick={() => {
                  if (workspace.id !== activeWorkspace.id) onSwitch(workspace.id)
                  setOpen(false)
                }}
              >
                <span className="workspace-row-main"><strong>{workspace.name}</strong><small>{workspace.nodeCount} notes</small></span>
                {workspace.id === activeWorkspace.id ? <span className="workspace-current-mark">●</span> : null}
              </button>
            ))}
          </div>
          <div className="workspace-popover-footer">
            <div className={`save-state ${status.state}`}><i />{savedLabel(status)}</div>
            <div className="workspace-footer-actions">
              <button onClick={() => { onSave(); setOpen(false) }}>Save now</button>
              <button onClick={() => { onExport(); setOpen(false) }}>Export…</button>
              <button onClick={() => { onImport(); setOpen(false) }}>Import…</button>
              <button onClick={() => { onRecovery(); setOpen(false) }}>Recovery & backups</button>
              <button onClick={() => { onBackup(); setOpen(false) }}>Save backup copy…</button>
              <button onClick={() => { onRename(); setOpen(false) }}>Rename</button>
              <button className="danger" disabled={workspaces.length <= 1} onClick={() => { onDelete(activeWorkspace.id); setOpen(false) }}>Delete</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
