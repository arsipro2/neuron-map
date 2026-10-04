import type { Attachment } from '../types'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_WORKSPACE_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export type FilePayload = { id: string; data: string }

let database: Promise<IDBDatabase> | null = null
function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('neuron-map-files', 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files')
      if (!request.result.objectStoreNames.contains('snapshots')) request.result.createObjectStore('snapshots')
    }
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null }; resolve(request.result) }
    request.onblocked = () => { database = null; reject(new Error('Close other Neuron Map browser tabs to upgrade file storage.')) }
    request.onerror = () => { database = null; reject(request.error) }
  })
  return database
}

async function fileTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('files', mode)
    const request = action(transaction.objectStore('files'))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error ?? request.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('File storage was interrupted.'))
  })
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.onabort = () => reject(new Error('File reading was cancelled.'))
    reader.readAsDataURL(blob)
  })
}

export function base64ToBlob(data: string, mime = 'application/octet-stream') {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function storeAttachment(workspaceId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`“${file.name}” exceeds the 20 MiB file limit.`)
  const attachment: Attachment = { id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size, addedAt: Date.now() }
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('store_attachment', { workspaceId, attachment, data: await blobToBase64(file) })
  } else {
    await fileTransaction('readwrite', (store) => store.put(file, [workspaceId, attachment.id]))
  }
  return attachment
}

export async function readAttachment(workspaceId: string, attachment: Attachment): Promise<Blob> {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    const data = await invoke<string>('read_attachment', { workspaceId, attachmentId: attachment.id })
    return base64ToBlob(data, attachment.mime)
  }
  const blob = await fileTransaction<Blob | undefined>('readonly', (store) => store.get([workspaceId, attachment.id]))
  if (!blob) throw new Error(`File “${attachment.name}” was not found.`)
  return blob
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // WebKit may start its download after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function downloadAttachment(workspaceId: string, attachment: Attachment) {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_attachment_as', { workspaceId, attachmentId: attachment.id })
  } else downloadBlob(await readAttachment(workspaceId, attachment), attachment.name)
}

export async function openAttachment(workspaceId: string, attachment: Attachment) {
  if (!isDesktop()) return downloadAttachment(workspaceId, attachment)
  const { invoke } = await import('@tauri-apps/api/core')
  // Rust resolves the stored file by ID; the frontend cannot supply a path or command.
  await invoke('open_attachment', { workspaceId, attachmentId: attachment.id })
}

export async function exportFiles(workspaceId: string, attachments: Attachment[]): Promise<FilePayload[]> {
  const result: FilePayload[] = []
  for (const attachment of attachments) result.push({ id: attachment.id, data: await blobToBase64(await readAttachment(workspaceId, attachment)) })
  return result
}

export async function importFiles(workspaceId: string, files: FilePayload[]) {
  for (const file of files) await fileTransaction('readwrite', (store) => store.put(base64ToBlob(file.data), [workspaceId, file.id]))
}

export async function deleteWorkspaceFiles(workspaceId: string) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['files', 'snapshots'], 'readwrite')
    tx.objectStore('snapshots').delete(IDBKeyRange.bound([workspaceId], [workspaceId, []]))
    const request = tx.objectStore('files').openCursor(IDBKeyRange.bound([workspaceId], [workspaceId, []]))
    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue() } }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}


export type WebSnapshot<T = unknown> = { id: number; createdAt: number; state: T }
export async function webSnapshots<T>(workspaceId: string): Promise<WebSnapshot<T>[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly')
    const request = tx.objectStore('snapshots').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []]))
    tx.oncomplete = () => resolve((request.result as WebSnapshot<T>[]).sort((a, b) => b.id - a.id))
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
}
export async function putWebSnapshot<T>(workspaceId: string, state: T) {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite'), store = tx.objectStore('snapshots')
    const request = store.getAllKeys(IDBKeyRange.bound([workspaceId], [workspaceId, []]))
    request.onsuccess = () => {
      const keys = request.result as [string, number][]
      const id = Math.max(Date.now(), (keys.at(-1)?.[1] ?? 0) + 1)
      store.put({ id, createdAt: Date.now(), state }, [workspaceId, id])
      for (const key of keys.slice(0, Math.max(0, keys.length - 19))) store.delete(key)
    }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
}
export async function cleanupWebFiles(workspaceId: string, protectedIds: Set<string>, dryRun: boolean) {
  const db = await openDatabase()
  return new Promise<{ fileCount: number; bytes: number }>((resolve, reject) => {
    const tx = db.transaction('files', dryRun ? 'readonly' : 'readwrite')
    const result = { fileCount: 0, bytes: 0 }
    const request = tx.objectStore('files').openCursor(IDBKeyRange.bound([workspaceId], [workspaceId, []]))
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return
      if (!protectedIds.has((cursor.key as string[])[1])) {
        result.fileCount++; result.bytes += (cursor.value as Blob).size
        if (!dryRun) cursor.delete()
      }
      cursor.continue()
    }
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
}
