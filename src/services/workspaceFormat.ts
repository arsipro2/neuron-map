import type { Attachment, Edge, GraphData, NoteNode, Trash, Vec3 } from '../types'
import { graphAttachments } from '../types'
import { MAX_ATTACHMENT_BYTES, MAX_WORKSPACE_ATTACHMENT_BYTES, type FilePayload } from './attachments'

export const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024
export const MAX_COORDINATE = 100_000
export const MAX_NODES = 20_000
export const MAX_EDGES = 100_000
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE)

export function validateGraph(value: unknown): GraphData {
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('Invalid workspace graph.')
  const rawTrash = value.trash === undefined ? { nodes: [], edges: [] } : value.trash
  if (!object(rawTrash) || !Array.isArray(rawTrash.nodes) || !Array.isArray(rawTrash.edges)) throw new Error('Invalid trash.')
  if (value.nodes.length + rawTrash.nodes.length > MAX_NODES || value.edges.length + rawTrash.edges.length > MAX_EDGES) throw new Error('Workspace exceeds 20,000 notes or 100,000 links, including trash.')
  const ids = new Set<string>(), edgeIds = new Set<string>(), fileIds = new Set<string>()
  let fileBytes = 0
  const readNode = (node: unknown): NoteNode => {
    if (!object(node) || !id(node.id) || ids.has(node.id) || typeof node.title !== 'string' || typeof node.content !== 'string' || !vector(node.position, 3)) throw new Error('Invalid note, duplicate ID or coordinates outside the supported range.')
    ids.add(node.id)
    if (node.summary !== undefined && typeof node.summary !== 'string') throw new Error('Invalid note description.')
    if (node.attachments !== undefined && !Array.isArray(node.attachments)) throw new Error('Invalid attachments list.')
    if (node.tags !== undefined && (!Array.isArray(node.tags) || node.tags.length > 20 || node.tags.some((tag: unknown) => typeof tag !== 'string' || !tag.trim() || tag.length > 40))) throw new Error('Invalid tags: use up to 20 tags of 40 characters.')
    if (node.linkTargets !== undefined && (!object(node.linkTargets) || Object.entries(node.linkTargets).some(([key, value]) => key.length > 512 || !id(value)))) throw new Error('Invalid internal note links.')
    const attachments = (node.attachments ?? []).map((file: unknown): Attachment => {
      if (!object(file) || !id(file.id) || fileIds.has(file.id) || typeof file.name !== 'string' || !file.name.trim() || file.name === '.' || file.name === '..' || /[/\\\u0000]/.test(file.name) || typeof file.mime !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES || !timestamp(file.addedAt)) throw new Error('Invalid or duplicate attachment metadata.')
      fileIds.add(file.id); fileBytes += file.size
      return { id: file.id, name: file.name, mime: file.mime, size: file.size, addedAt: file.addedAt }
    })
    return { id: node.id, title: node.title, summary: node.summary ?? '', content: node.content, position: [...node.position] as Vec3, attachments, tags: [...new Set<string>((node.tags ?? []).map((tag: string) => tag.trim()).filter(Boolean))], linkTargets: { ...(node.linkTargets ?? {}) } }
  }
  const nodes = value.nodes.map(readNode)
  const liveIds = new Set<string>(ids)
  const trash: Trash = { nodes: rawTrash.nodes.map((entry: unknown) => {
    if (!object(entry) || !timestamp(entry.deletedAt)) throw new Error('Invalid deleted note.')
    return { node: readNode(entry.node), deletedAt: entry.deletedAt }
  }), edges: [] }
  if (fileBytes > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('Workspace attachments exceed 64 MiB, including trash.')
  const pairs = new Map<string, Set<string>>()
  const readEdge = (edge: unknown, inTrash = false): Edge => {
    if (!object(edge) || !id(edge.id) || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error('Invalid, duplicate or dangling link in workspace.')
    if (inTrash ? liveIds.has(edge.source) && liveIds.has(edge.target) : !liveIds.has(edge.source) || !liveIds.has(edge.target)) throw new Error('Link belongs to the wrong part of the workspace.')
    const [a, b] = [edge.source as string, edge.target as string].sort()
    if (pairs.get(a)?.has(b)) throw new Error('Duplicate connection in workspace.')
    if (!pairs.has(a)) pairs.set(a, new Set())
    pairs.get(a)!.add(b); edgeIds.add(edge.id)
    return { id: edge.id, source: edge.source, target: edge.target }
  }
  const edges = value.edges.map((edge: unknown) => readEdge(edge))
  trash.edges = rawTrash.edges.map((edge: unknown) => readEdge(edge, true))
  return { nodes, edges, trash }
}

export function validateCamera(camera: unknown) {
  if (camera == null) return null
  if (!object(camera) || !vector(camera.position, 3) || !vector(camera.quaternion, 4) || !vector(camera.orbit_target, 3) || Math.hypot(...camera.quaternion) < 0.001) throw new Error('Invalid camera in workspace.')
  const length = Math.hypot(...camera.quaternion)
  return { position: camera.position as Vec3, quaternion: camera.quaternion.map((v: number) => v / length) as [number, number, number, number], orbit_target: camera.orbit_target as Vec3 }
}

export function validateFilePayloads(graph: GraphData, raw: unknown): FilePayload[] {
  if (!Array.isArray(raw)) throw new Error('Invalid file payloads.')
  const metadata = new Map(graphAttachments(graph).map((file) => [file.id, file]))
  const seen = new Set<string>(), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (const file of raw) {
    if (!object(file) || typeof file.id !== 'string' || seen.has(file.id) || !metadata.has(file.id) || typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data) || /=/.test(file.data.replace(/={1,2}$/, ''))) throw new Error('Invalid attachment data.')
    const padding = file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0
    const bits = alphabet.indexOf(file.data[file.data.length - padding - 1])
    if ((padding === 2 && (bits & 15) !== 0) || (padding === 1 && (bits & 3) !== 0)) throw new Error('Invalid attachment encoding.')
    if (file.data.length / 4 * 3 - padding !== metadata.get(file.id)!.size) throw new Error('Attachment size does not match its data.')
    seen.add(file.id)
  }
  if (seen.size !== metadata.size) throw new Error('Workspace is missing attachment data.')
  return raw as FilePayload[]
}

export function parseWorkspaceFile(payload: string) {
  if (new Blob([payload]).size > MAX_WORKSPACE_FILE_BYTES) throw new Error('Workspace exceeds the 100 MiB import limit.')
  const value: unknown = JSON.parse(payload)
  if (!object(value) || value.format !== 'neuron-map-workspace' || ![1, 2, 3].includes(value.version) || !object(value.workspace) || typeof value.workspace.name !== 'string' || !object(value.state)) throw new Error('Unsupported workspace file format.')
  for (const time of [value.exported_at, value.workspace.created_at, value.workspace.updated_at, value.state.revision]) if (time !== undefined && time !== null && !timestamp(time)) throw new Error('Invalid workspace timestamp or revision.')
  const graph = validateGraph(value.state), camera = validateCamera(value.state.camera)
  const prefs = value.state.preferences
  if (prefs != null && (!object(prefs) || ['linkNavigationEnabled', 'reducedMotion'].some((key) => prefs[key] !== undefined && typeof prefs[key] !== 'boolean'))) throw new Error('Invalid workspace preferences.')
  return { name: value.workspace.name, state: { ...graph, camera, preferences: { linkNavigationEnabled: prefs?.linkNavigationEnabled === true, reducedMotion: prefs?.reducedMotion === true } }, files: validateFilePayloads(graph, value.files === undefined ? [] : value.files) }
}
