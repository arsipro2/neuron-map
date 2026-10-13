import { generateJSON, getSchema, Mark, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { TableKit } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Marked } from 'marked'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { notePlainText, richDocument, safeLink, type RichNode } from './noteContent'

export const AttachmentImage = Node.create({
  name: 'attachmentImage', group: 'block', atom: true,
  addAttributes: () => ({ attachmentId: { default: '' }, annotationId: { default: null }, alt: { default: 'Image' } }),
  parseHTML: () => [{ tag: 'img[data-attachment-id]', getAttrs: element => ({ attachmentId: element.getAttribute('data-attachment-id'), annotationId: element.getAttribute('data-annotation-id'), alt: element.getAttribute('alt') }) }],
  renderHTML: ({ node }) => ['img', { 'data-attachment-id': node.attrs.attachmentId, 'data-annotation-id': node.attrs.annotationId, alt: node.attrs.alt }],
})
const SafeLink = Mark.create({
  name: 'link', inclusive: false,
  addAttributes: () => ({ href: { default: null } }),
  parseHTML: () => [{ tag: 'a[href]', getAttrs: element => safeLink(element.getAttribute('href')) ? { href: element.getAttribute('href') } : false }],
  renderHTML: ({ mark }) => safeLink(mark.attrs.href) ? ['a', { href: mark.attrs.href, target: '_blank', rel: 'noopener noreferrer' }, 0] : ['span', {}, 0],
})
const NoteLink = Node.create({
  name: 'noteLink', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ label: { default: '' }, target: { default: null }, enabled: { default: false } }),
  renderHTML: ({ node }) => node.attrs.enabled && node.attrs.target
    ? ['button', { type: 'button', class: 'wiki-link resolved', 'data-note-id': node.attrs.target }, node.attrs.label]
    : ['span', { class: 'wiki-link disabled' }, `[[${node.attrs.label}]]`],
})
const lowlight = createLowlight(common)
export function editorExtensions(image = AttachmentImage) {
  return [StarterKit.configure({ link: false, codeBlock: false }), CodeBlockLowlight.configure({ lowlight }), SafeLink, NoteLink, Subscript, Superscript, TableKit, TaskList, TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }), image]
}
const markdown = new Marked({ renderer: { html: ({ text }) => `<pre><code class="language-html">${escapeHTML(text)}</code></pre>`, image: ({ text, href }) => `<span>[Image: ${escapeHTML(text)} — ${escapeHTML(href)}; attach the file to preview it locally]</span>` } })
export function contentToDocument(content: string): RichNode {
  const doc = richDocument(content)
  if (doc) {
    try { getSchema(editorExtensions()).nodeFromJSON(doc).check(); return doc }
    catch { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: notePlainText(content) || 'Unsupported note content' }] }] } }
  }
  const html = markdown.parse(content, { async: false })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  parsed.querySelectorAll('li input[type=checkbox]').forEach(checkbox => {
    const item = checkbox.closest('li')!, list = item.parentElement!
    list.setAttribute('data-type', 'taskList'); item.setAttribute('data-type', 'taskItem'); item.setAttribute('data-checked', String((checkbox as HTMLInputElement).checked)); checkbox.remove()
  })
  return generateJSON(parsed.body.innerHTML, editorExtensions()) as RichNode
}
function escapeHTML(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
