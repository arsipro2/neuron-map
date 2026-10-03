export type Vec3 = [number, number, number]
export type Quat4 = [number, number, number, number]

export type Attachment = {
  id: string
  name: string
  mime: string
  size: number
  addedAt: number
}

export type NoteNode = {
  id: string
  title: string
  summary: string
  content: string
  position: Vec3
  attachments?: Attachment[]
  tags?: string[]
  linkTargets?: Record<string, string>
}

export type Edge = {
  id: string
  source: string
  target: string
}

export type CameraSnapshot = {
  position: Vec3
  quaternion: Quat4
  orbitTarget: Vec3
}

export type AppPreferences = {
  linkNavigationEnabled: boolean
  reducedMotion?: boolean
}

export type Trash = { nodes: Array<{ node: NoteNode; deletedAt: number }>; edges: Edge[] }
export type GraphData = { nodes: NoteNode[]; edges: Edge[]; trash: Trash }
export const emptyTrash = (): Trash => ({ nodes: [], edges: [] })
export function graphAttachments(graph: GraphData): Attachment[] {
  return [...graph.nodes, ...graph.trash.nodes.map((entry) => entry.node)].flatMap((node) => node.attachments ?? [])
}
