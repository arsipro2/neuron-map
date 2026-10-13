export const ANNOTATION_MIME = 'application/vnd.neuron-map.image-annotations+json'
export type ImagePoint = { x: number; y: number }
export type ImageMark = { kind: 'stroke'; color: string; width: number; erase: boolean; points: ImagePoint[] } | { kind: 'text'; color: string; size: number; text: string; x: number; y: number }
export type ImageAnnotations = { version: 1; imageId: string; marks: ImageMark[] }
const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const color = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)
export function parseAnnotations(value: unknown, imageId: string): ImageAnnotations {
  const data = value as ImageAnnotations
  if (!data || data.version !== 1 || data.imageId !== imageId || !Array.isArray(data.marks) || data.marks.length > 2000) throw new Error('Invalid image annotations.')
  let points = 0
  for (const mark of data.marks) {
    if (!mark || !color(mark.color)) throw new Error('Invalid annotation color.')
    if (mark.kind === 'stroke') {
      if (!Number.isFinite(mark.width) || mark.width < 1 || mark.width > 40 || typeof mark.erase !== 'boolean' || !Array.isArray(mark.points) || !mark.points.length || mark.points.some(p => !unit(p.x) || !unit(p.y))) throw new Error('Invalid brush stroke.')
      points += mark.points.length
    } else if (mark.kind === 'text') {
      if (!unit(mark.x) || !unit(mark.y) || !Number.isFinite(mark.size) || mark.size < 8 || mark.size > 100 || typeof mark.text !== 'string' || !mark.text.trim() || mark.text.length > 1000) throw new Error('Invalid image text.')
    } else throw new Error('Unknown annotation tool.')
  }
  if (points > 100000) throw new Error('Too many annotation points. Save fewer strokes.')
  return data
}
export function drawMark(ctx: CanvasRenderingContext2D, mark: ImageMark) {
  const w = ctx.canvas.width, h = ctx.canvas.height, scale = Math.min(w, h) / 1000
  ctx.save()
  if (mark.kind === 'text') {
    ctx.fillStyle = mark.color; ctx.font = `${mark.size * scale}px sans-serif`; ctx.textBaseline = 'top'
    mark.text.split('\n').forEach((line, i) => ctx.fillText(line, mark.x * w, mark.y * h + i * mark.size * scale * 1.2))
  } else {
    ctx.globalCompositeOperation = mark.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = ctx.fillStyle = mark.color; ctx.lineWidth = mark.width * scale; ctx.lineCap = ctx.lineJoin = 'round'
    const first = mark.points[0]
    if (mark.points.length === 1) { ctx.beginPath(); ctx.arc(first.x * w, first.y * h, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill() }
    else { ctx.beginPath(); ctx.moveTo(first.x * w, first.y * h); for (const p of mark.points.slice(1)) ctx.lineTo(p.x * w, p.y * h); ctx.stroke() }
  }
  ctx.restore()
}
export function drawAnnotations(canvas: HTMLCanvasElement, marks: ImageMark[]) {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const mark of marks) drawMark(ctx, mark)
}
export async function decodeImage(blob: Blob) {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image(); image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image could not be decoded.')
    const longest = Math.max(image.naturalWidth, image.naturalHeight)
    const ratio = Math.min(2048 / longest, Math.max(1, 640 / longest))
    return { image, width: Math.max(1, Math.round(image.naturalWidth * ratio)), height: Math.max(1, Math.round(image.naturalHeight * ratio)), dispose: () => { image.src = ''; URL.revokeObjectURL(url) } }
  } catch (error) { URL.revokeObjectURL(url); throw error }
}
export async function annotatedPreview(blob: Blob, marks: ImageMark[]) {
  const decoded = await decodeImage(blob)
  try {
    const canvas = document.createElement('canvas'), overlay = document.createElement('canvas')
    canvas.width = overlay.width = decoded.width; canvas.height = overlay.height = decoded.height
    canvas.getContext('2d')!.drawImage(decoded.image, 0, 0, decoded.width, decoded.height)
    drawAnnotations(overlay, marks); canvas.getContext('2d')!.drawImage(overlay, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not render the annotated image.')), 'image/png'))
  } finally { decoded.dispose() }
}
