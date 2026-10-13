import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react'
import { useGraphStore } from '../store/useGraphStore'
import { getActiveWorkspaceId } from '../services/persistence'
import { storeAttachment } from '../services/attachments'
import { AttachmentImage, contentToDocument, editorExtensions } from '../services/editorDocument'
import { ensureFileCapacity, imageFile } from '../services/noteImages'
import { serializeRichDocument, type RichNode } from '../services/noteContent'
import { resolveNoteLink, WIKI_PATTERN } from '../services/noteLinks'
import { NoteImage } from './NoteImage'
const NoteContext = createContext('')
const NO_LINK_TARGETS: Record<string, string> = {}
function ImageView({ node, editor, deleteNode }: NodeViewProps) {
  const nodeId = useContext(NoteContext)
  return <NodeViewWrapper className="note-image-block"><NoteImage nodeId={nodeId} attachmentId={node.attrs.attachmentId} annotationId={node.attrs.annotationId} alt={node.attrs.alt} />{editor.isEditable ? <button type="button" className="note-image-remove" aria-label={`Remove image ${node.attrs.alt} from content`} onClick={deleteNode}>Remove image</button> : null}</NodeViewWrapper>
}
const imageExtension = AttachmentImage.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView) })
function readingDocument(doc: RichNode, enabled: boolean, targets: Record<string, string>, notes: Array<{ id: string; title: string }>): RichNode {
  const eligible = (node: RichNode) => node.type === 'text' && !node.marks?.some(mark => ['code', 'link'].includes(mark.type))
  const walk = (node: RichNode): RichNode => {
    if (node.type === 'codeBlock' || !node.content) return node
    const content: RichNode[] = []
    for (let index = 0; index < node.content.length;) {
      if (!eligible(node.content[index])) { content.push(walk(node.content[index++])); continue }
      const group: RichNode[] = []
      while (index < node.content.length && eligible(node.content[index])) group.push(node.content[index++])
      const value = group.map(part => part.text ?? '').join('')
      let partIndex = 0, partStart = 0, end = 0
      const emitText = (from: number, to: number) => {
        while (partIndex < group.length && partStart + group[partIndex].text!.length <= from) partStart += group[partIndex++].text!.length
        while (partIndex < group.length && partStart < to) {
          const part = group[partIndex], partEnd = partStart + part.text!.length
          const text = part.text!.slice(Math.max(0, from - partStart), Math.min(part.text!.length, to - partStart))
          if (text) content.push({ ...part, text })
          if (partEnd > to) break
          partStart = partEnd; partIndex++
        }
      }
      for (const match of value.matchAll(WIKI_PATTERN)) {
        emitText(end, match.index!)
        const labelStart = match.index! + 2 + (match[2] === undefined ? 0 : match[1].length + 1)
        let styledIndex = partIndex, styledStart = partStart
        while (styledIndex < group.length && styledStart + group[styledIndex].text!.length <= labelStart) styledStart += group[styledIndex++].text!.length
        content.push({ type: 'noteLink', marks: group[styledIndex]?.marks, attrs: { label: (match[2] ?? match[1]).trim(), target: resolveNoteLink(match[1], notes, targets), enabled } })
        end = match.index! + match[0].length
      }
      emitText(end, value.length)
    }
    return { ...node, content }
  }
  return walk(doc)
}
export default function RichEditor({ nodeId, content, readOnly = false, enabled = false, linkTargets = NO_LINK_TARGETS, onNavigate, onBusyChange }: {
  nodeId: string; content: string; readOnly?: boolean; enabled?: boolean; linkTargets?: Record<string, string>; onNavigate?: (id: string) => void; onBusyChange: (busy: boolean, message?: string) => void
}) {
  const notes = useGraphStore(state => state.nodes), lastStored = useRef(content), picker = useRef<HTMLInputElement>(null), pending = useRef(false)
  const noteNames = notes.map(note => `${note.id}\0${note.title}`).join('\0')
  const [error, setError] = useState(''), [, refresh] = useState(0)
  const actions = useRef({ addImages: (_files: File[]) => {} })
  const initial = useRef<RichNode | null>(null)
  if (!initial.current) initial.current = readOnly ? readingDocument(contentToDocument(content), enabled, linkTargets, notes) : contentToDocument(content)
  const editor = useEditor({
    extensions: editorExtensions(imageExtension), editable: !readOnly,
    content: initial.current,
    editorProps: {
      attributes: { class: `${readOnly ? 'rich-reading' : 'content-input rich-content-input'} markdown-body`, role: 'textbox', 'aria-label': readOnly ? 'Rendered note content' : 'Note content', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'))
        if (readOnly || !files.length) return false
        event.preventDefault(); actions.current.addImages(files); return true
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (readOnly || !files.length) return false
        event.preventDefault(); event.stopPropagation()
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (position) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))))
        actions.current.addImages(files); return true
      },
    },
    onUpdate: ({ editor }) => {
      if (readOnly) return
      const value = serializeRichDocument(editor.getJSON() as RichNode)
      lastStored.current = value
      useGraphStore.getState().updateNode(nodeId, { content: value })
    },
    onTransaction: () => refresh(v => v + 1),
  }, [nodeId, readOnly])
  useEffect(() => {
    if (!editor) return
    if (readOnly) editor.commands.setContent(readingDocument(contentToDocument(content), enabled, linkTargets, notes), { emitUpdate: false })
    else if (content !== lastStored.current) { lastStored.current = content; editor.commands.setContent(contentToDocument(content), { emitUpdate: false }) }
  }, [content, enabled, linkTargets, noteNames, editor, readOnly])
  const addImages = async (files: File[]) => {
    const workspaceId = getActiveWorkspaceId()
    if (!editor || editor.isDestroyed || !workspaceId || !files.length || pending.current) return
    pending.current = true; setError(''); onBusyChange(true, 'Inserting images…')
    try {
      const images = files.map(imageFile)
      // Per-file and cumulative checks happen before a batch starts writing.
      for (const file of images) ensureFileCapacity(file.size)
      const total = (await import('../types')).graphAttachments(useGraphStore.getState()).reduce((sum, file) => sum + file.size, 0)
      if (total + images.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error('Workspace attachments are limited to 64 MiB.')
      for (const file of images) {
        const attachment = await storeAttachment(workspaceId, file)
        const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
        if (getActiveWorkspaceId() !== workspaceId || !node || editor.isDestroyed) throw new Error('The note changed before the image could be inserted.')
        useGraphStore.getState().updateNode(nodeId, { attachments: [...(node.attachments ?? []), attachment] })
        editor.chain().focus().insertContentAt(editor.state.selection.to, [{ type: 'attachmentImage', attrs: { attachmentId: attachment.id, alt: attachment.name } }, { type: 'paragraph' }]).run()
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; onBusyChange(false) }
  }
  actions.current.addImages = files => { void addImages(files) }
  if (!editor) return <p>Opening editor…</p>
  const button = (label: string, text: string, active: boolean, run: () => void) => <button type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={e => e.preventDefault()} onClick={run}>{text}</button>
  return <NoteContext.Provider value={nodeId}><div className={readOnly ? 'rich-reading-shell' : 'rich-editor-shell'}>
    {!readOnly ? <div className="format-toolbar" role="toolbar" aria-label="Text formatting">
      {button('Bold', 'B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {button('Italic', 'I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {button('Underline', 'U', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
      {button('Strikethrough', 'S̶', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run())}
      {button('Subscript', 'x₂', editor.isActive('subscript'), () => editor.chain().focus().unsetSuperscript().toggleSubscript().run())}
      {button('Superscript', 'x²', editor.isActive('superscript'), () => editor.chain().focus().unsetSubscript().toggleSuperscript().run())}
      {button('Bullet list', '• List', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {button('Clear formatting', 'Clear', false, () => editor.chain().focus().unsetAllMarks().run())}
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => picker.current?.click()}>Insert image</button>
      <button type="button" aria-label="Undo text edit" disabled={!editor.can().undo()} onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().undo().run()}>↶</button>
      <button type="button" aria-label="Redo text edit" disabled={!editor.can().redo()} onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().redo().run()}>↷</button>
      <input ref={picker} type="file" aria-label="Insert images" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" multiple hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void addImages(files) }} />
    </div> : null}
    <EditorContent editor={editor} onClickCapture={e => {
      if (!readOnly) return
      const link = (e.target as HTMLElement).closest<HTMLElement>('[data-note-id], a[href^="neuron:"]')
      if (link) { e.preventDefault(); const id = link.dataset.noteId ?? resolveNoteLink('id:' + (link.getAttribute('href') ?? '').slice(7), notes); if (id && notes.some(note => note.id === id)) onNavigate?.(id) }
    }} />
    {!readOnly ? <p className="rich-editor-hint">Select text to format it. Paste or drop images into the note; click an image to annotate it.</p> : null}
    {error ? <p role="alert" className="attachment-error">{error}</p> : null}
  </div></NoteContext.Provider>
}
