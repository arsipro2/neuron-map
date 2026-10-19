import { useGraphStore } from '../store/useGraphStore'
import { flushPersist, getActiveWorkspaceId } from './persistence'
import { graphAttachments, type NoteNode } from '../types'
import { MAX_WORKSPACE_ATTACHMENT_BYTES, readAttachment, storeAttachment } from './attachments'
import { DIAGRAM_MIME, parseDiagram, type Diagram } from './diagrams'
export const diagramAttachment = (node: Pick<NoteNode, 'attachments'>) => node.attachments?.find(file => file.mime === DIAGRAM_MIME)
export async function loadNoteDiagram(workspaceId: string, node: Pick<NoteNode, 'attachments'>) {
  const file = diagramAttachment(node)
  return file ? parseDiagram(JSON.parse(await (await readAttachment(workspaceId, file)).text())) : null
}
export async function saveNoteDiagram(nodeId: string, workspaceId: string, doc: Diagram, expectedId: string | null, onStored?: (id: string) => void) {
  const state = useGraphStore.getState(), epoch = state.graphEpoch
  const check = () => {
    const current = useGraphStore.getState(), node = current.nodes.find(n => n.id === nodeId)
    if (getActiveWorkspaceId() !== workspaceId || current.graphEpoch !== epoch || !node) throw new Error('The note changed or its workspace was closed. Reopen the diagram before saving.')
    if ((diagramAttachment(node)?.id ?? null) !== expectedId) throw new Error('This diagram changed while the editor was open. Reopen it to load the latest version.')
    return node
  }
  check()
  const document = parseDiagram(doc)
  const file = new File([JSON.stringify(document)], 'diagram.neuron.json', { type: DIAGRAM_MIME })
  const total = graphAttachments(state).reduce((sum, file) => sum + file.size, 0)
  if (total + file.size > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('Workspace attachments are limited to 64 MiB, including Trash.')
  const attachment = await storeAttachment(workspaceId, file), current = check()
  useGraphStore.getState().updateNode(nodeId, { attachments: [...(current.attachments ?? []).filter(f => f.mime !== DIAGRAM_MIME), attachment] })
  onStored?.(attachment.id)
  await flushPersist()
  return attachment.id
}
