import type { Vec3 } from '../types'
export function hashNumber(seed: string) { let hash = 0; for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0; return Math.abs(hash) }
export function edgeMidpoint(id: string, a: Vec3, b: Vec3): Vec3 {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], length = Math.max(0.001, Math.hypot(dx, dy, dz))
  const up = Math.abs(dy / length) < 0.86
  const normal: Vec3 = up ? [-dz, 0, dx] : [0, dz, -dy]
  const norm = Math.hypot(...normal) || 1
  const curve = Math.min(0.22, length * 0.035) * ((hashNumber(id) % 200 / 199 - 0.5) * 2)
  return a.map((v, i) => (v + b[i]) / 2 + normal[i] / norm * curve) as Vec3
}
export function edgePoint(a: Vec3, mid: Vec3, b: Vec3, t: number): Vec3 {
  const start = t < 0.5 ? a : mid, end = t < 0.5 ? mid : b, amount = t < 0.5 ? t * 2 : (t - 0.5) * 2
  return start.map((v, i) => v + (end[i] - v) * amount) as Vec3
}
