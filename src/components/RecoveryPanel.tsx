import { useEffect, useState } from 'react'
import { useGraphStore } from '../store/useGraphStore'
import { cleanupUnusedAttachments, exportBackupCopy, listWorkspaceBackups, restoreWorkspaceBackup, type WorkspaceBackup } from '../services/persistence'
import { isDesktop } from '../services/attachments'
import { Modal } from './Modal'
import { formatBytes } from './AttachmentPanel'

type Restored = Awaited<ReturnType<typeof restoreWorkspaceBackup>>
export function RecoveryPanel({ workspaceId, onClose, onRestored, onBusyChange }: { workspaceId: string; onClose: () => void; onRestored: (result: Restored) => void; onBusyChange: (busy: boolean) => void }) {
  const trash = useGraphStore(s => s.trash)
  const [tab, setTab] = useState<'trash' | 'snapshots' | 'files'>('trash')
  const [backups, setBackups] = useState<WorkspaceBackup[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [cleanup, setCleanup] = useState<{ fileCount: number; bytes: number } | null>(null)
  useEffect(() => { let cancelled = false; void listWorkspaceBackups(workspaceId).then(rows => { if (!cancelled) setBackups(rows) }).catch(e => { if (!cancelled) setError(String(e)) }); return () => { cancelled = true } }, [workspaceId])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); onBusyChange(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(String(e)) } finally { setBusy(false); onBusyChange(false) }
  }
  return <Modal title="Recovery & backups" onClose={onClose} busy={busy}>
    <div className="modal-tabs" role="tablist" aria-label="Recovery sections">{(['trash', 'snapshots', 'files'] as const).map(t => <button role="tab" aria-selected={tab === t} key={t} disabled={busy} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setNotice('') }}>{t === 'trash' ? `Trash (${trash.nodes.length})` : t === 'snapshots' ? 'Snapshots' : 'Files & copies'}</button>)}</div>
    <div className="modal-body">
      {tab === 'trash' ? <>
        <p>Deleted notes keep their content, connections and attachments. Restore notes in any order.</p>
        {trash.nodes.length === 0 ? <p className="empty-message">Trash is empty.</p> : <>
          <ul className="recovery-list">{trash.nodes.map(({ node, deletedAt }) => <li key={node.id}><div><strong>{node.title || 'Untitled'}</strong><small>{new Date(deletedAt).toLocaleString()} · {node.attachments?.length ?? 0} files</small></div>
            <button disabled={busy} onClick={() => useGraphStore.getState().restoreNode(node.id)}>Restore</button>
            <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Remove “${node.title}” from Trash? Older snapshots may still contain it.`)) useGraphStore.getState().purgeNode(node.id) }}>Remove</button></li>)}</ul>
          <button disabled={busy} className="danger" onClick={() => { if (window.confirm('Empty Trash? Session undo and older snapshots will still be available.')) useGraphStore.getState().emptyTrash() }}>Empty Trash</button>
        </>}
      </> : tab === 'snapshots' ? <>
        <p>Up to 20 snapshots are kept. Restoring first preserves your current edits in a safety snapshot.</p>
        {backups.length === 0 ? <p className="empty-message">No snapshots yet. Use Save to create one.</p> : <ul className="recovery-list">{backups.map(backup => <li key={backup.id}><div>
          <strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{backup.nodeCount} notes · {backup.trashCount} in Trash · {backup.fileCount} files</small><span className="snapshot-preview">{backup.titles.join(' · ') || 'Empty workspace'}</span>
          </div><button disabled={busy} onClick={() => {
            if (window.confirm('Restore this snapshot? Current edits will be preserved in a safety snapshot.')) void run(async () => { const result = await restoreWorkspaceBackup(workspaceId, backup.id); onRestored(result); onClose() })
          }}>Restore snapshot</button></li>)}</ul>}
      </> : <>
        <p>A backup copy is a separate .neuron file containing current notes, Trash and attachments. Store copies on another drive if you need protection against disk failure.</p>
        <button disabled={busy} onClick={() => void run(async () => { const result = await exportBackupCopy(workspaceId); if (result) setNotice(`Backup saved: ${result.path}`) })}>Save backup copy…</button>
        <hr /><p>Unused files can be removed when no note, Trash item, undo action or retained snapshot refers to them.</p>
        <button disabled={busy} onClick={() => void run(async () => setCleanup(await cleanupUnusedAttachments(workspaceId)))}>Check unused files</button>
        {cleanup ? <p>{cleanup.fileCount} unused files · {formatBytes(cleanup.bytes)} {isDesktop() && cleanup.fileCount > 0 ? <button disabled={busy} onClick={() => {
          if (window.confirm('Remove the unused file data? Files referenced by notes or recovery history are preserved.')) void run(async () => { const result = await cleanupUnusedAttachments(workspaceId, false); setNotice(`Removed ${result.fileCount} files (${formatBytes(result.bytes)}).`); setCleanup(null) })
        }}>Clean up</button> : null}</p> : null}
        {!isDesktop() ? <p className="attachment-hint">Cleanup is available in the desktop app; other browser tabs may still use these files.</p> : null}
      </>}
      {busy ? <p role="status">Working…</p> : null}{error ? <p role="alert" className="attachment-error">{error}</p> : null}{notice ? <p role="status" className="success-message">{notice}</p> : null}
    </div>
  </Modal>
}
