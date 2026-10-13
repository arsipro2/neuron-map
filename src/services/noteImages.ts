import { useGraphStore } from '../store/useGraphStore'
import { flushPersist, getActiveWorkspaceId } from './persistence'
import { graphAttachments, type Attachment } from '../types'
import { MAX_ATTACHMENT_BYTES, MAX_WORKSPACE_ATTACHMENT_BYTES, readAttachment, storeAttachment } from './attachments'
import { contentToDocument } from './editorDocument'
import { imageAnnotationIds, serializeRichDocument, type RichNode } from './noteContent'
import { ANNOTATION_MIME, parseAnnotations, type ImageMark } from './imageAnnotations'
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']
export function imageFile(file: File) {
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  const inferred: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' }
  const mime = file.type || inferred[extension ?? '']
  if (!IMAGE_MIMES.includes(mime)) throw new Error('Choose a PNG, JPEG, GIF, WebP, AVIF or BMP image.')
  return file.type === mime ? file : new File([file], file.name, { type: mime })
}
export function ensureFileCapacity(bytes: number) {
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('Each image or annotation file must be at most 20 MiB.')
  const total = graphAttachments(useGraphStore.getState()).reduce((sum, file) => sum + file.size, 0)
  if (total + bytes > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('Workspace attachments are limited to 64 MiB, including Trash.')
}
export async function loadImageAnnotations(workspaceId: string, file: Attachment, imageId: string) {
  const blob = await readAttachment(workspaceId, file)
  return parseAnnotations(JSON.parse(await blob.text()), imageId)
}
export async function saveImageAnnotations(nodeId: string, workspaceId: string, imageId: string, marks: ImageMark[]) {
  const state = useGraphStore.getState(), initial = state.nodes.find(node => node.id === nodeId)
  if (getActiveWorkspaceId() !== workspaceId || !initial?.attachments?.some(file => file.id === imageId)) throw new Error('This image is no longer attached to the note.')
  const document = parseAnnotations({ version: 1, imageId, marks }, imageId)
  let attachment: Attachment | null = null
  if (marks.length) {
    const file = new File([JSON.stringify(document)], `image-${crypto.randomUUID()}.annotations.json`, { type: ANNOTATION_MIME })
    ensureFileCapacity(file.size)
    attachment = await storeAttachment(workspaceId, file)
  }
  const current = useGraphStore.getState().nodes.find(node => node.id === nodeId)
  if (getActiveWorkspaceId() !== workspaceId || !current?.attachments?.some(file => file.id === imageId)) throw new Error('The note changed before annotations could be saved.')
  const doc = contentToDocument(current.content), previous = imageAnnotationIds(current.content)
  let found = false
  const walk = (node: RichNode) => {
    if (node.type === 'attachmentImage' && node.attrs?.attachmentId === imageId) { node.attrs.annotationId = attachment?.id ?? null; found = true }
    node.content?.forEach(walk)
  }
  walk(doc)
  if (!found) { doc.content ??= []; doc.content.push({ type: 'attachmentImage', attrs: { attachmentId: imageId, annotationId: attachment?.id ?? null, alt: current.attachments.find(file => file.id === imageId)!.name } }) }
  const content = serializeRichDocument(doc), retained = imageAnnotationIds(content)
  const attachments = current.attachments.filter(file => !previous.has(file.id) || retained.has(file.id))
  if (attachment) attachments.push(attachment)
  useGraphStore.getState().updateNode(nodeId, { content, attachments })
  await flushPersist()
}
