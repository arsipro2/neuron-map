import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendNoteText, notePlainText, RICH_CONTENT_PREFIX, richDocument, serializeRichDocument } from '../src/services/noteContent'
import { ANNOTATION_MIME, parseAnnotations } from '../src/services/imageAnnotations'
import { captureLinkTargets, referencedNoteIds } from '../src/services/noteLinks'
import { searchNotes } from '../src/services/searchNotes'

test('rich formatting and local image references round-trip without changing plain notes', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H', marks: [{ type: 'bold' }] }, { type: 'text', text: '2', marks: [{ type: 'subscript' }] }] }, { type: 'attachmentImage', attrs: { attachmentId: 'image', annotationId: 'layer', alt: 'Diagram' } }] }
  const content = serializeRichDocument(doc)
  assert.deepEqual(richDocument(content), doc)
  assert.equal(serializeRichDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain note' }] }] }), 'Plain note')
  assert.equal(richDocument('**Old Markdown**'), null)
  assert.match(notePlainText(content), /H2\nDiagram/)
})

test('wiki links and search use visible rich text, including links split by formatting', () => {
  const content = serializeRichDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[[Be', marks: [{ type: 'bold' }] }, { type: 'text', text: 'ta]] science' }] }] })
  const nodes = ['alpha', 'beta'].map(id => ({ id, title: id === 'beta' ? 'Beta' : 'Alpha', summary: '', content: id === 'alpha' ? content : '', position: [0, 0, 0] as [number, number, number] }))
  assert.equal(captureLinkTargets(content, nodes).beta, 'beta')
  assert.deepEqual([...referencedNoteIds(content, nodes)], ['beta'])
  assert.equal(searchNotes(nodes, 'beta science')[0].node.id, 'alpha')
  assert.deepEqual(searchNotes(nodes, 'paragraph'), [])
  const withLayer = { ...nodes[0], attachments: [{ id: 'layer', name: 'internal-cache.annotations.json', mime: ANNOTATION_MIME, size: 1, addedAt: 0 }] }
  assert.deepEqual(searchNotes([withLayer], 'internal-cache'), [])
  assert.match(notePlainText(appendNoteText(content, '[[Beta|next]]')), /\[\[Beta\|next\]\]/)
})

test('rich content drops unsafe link attributes and rejects invalid document structures', () => {
  const raw = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Safe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', onclick: 'evil' } }, { type: 'bold' }] }] }] }
  assert.deepEqual(richDocument(RICH_CONTENT_PREFIX + JSON.stringify(raw))!.content![0].content![0].marks, [{ type: 'bold' }])
  assert.equal(richDocument(RICH_CONTENT_PREFIX + '{broken'), null)
  assert.equal(richDocument(RICH_CONTENT_PREFIX + JSON.stringify({ type: 'doc', content: [{ type: 'script', text: 'evil' }] })), null)
})

test('annotation layers validate brush, eraser and text while retaining the original image ID', () => {
  const data = { version: 1, imageId: 'original', marks: [{ kind: 'stroke', color: '#ff4444', width: 12, erase: false, points: [{ x: .1, y: .2 }, { x: .3, y: .4 }] }, { kind: 'stroke', color: '#ff4444', width: 20, erase: true, points: [{ x: .2, y: .2 }] }, { kind: 'text', text: 'Подпись', color: '#ffffff', size: 40, x: .5, y: .5 }] }
  assert.deepEqual(parseAnnotations(JSON.parse(JSON.stringify(data)), 'original'), data)
  assert.throws(() => parseAnnotations(data, 'different-image'))
  assert.throws(() => parseAnnotations({ ...data, marks: [{ ...data.marks[0], width: NaN }] }, 'original'))
  assert.throws(() => parseAnnotations({ ...data, marks: [{ ...data.marks[0], points: [{ x: Infinity, y: 0 }] }] }, 'original'))
  assert.throws(() => parseAnnotations({ ...data, marks: [{ ...data.marks[0], color: 'url(evil)' }] }, 'original'))
})
