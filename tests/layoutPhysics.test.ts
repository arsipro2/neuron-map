import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLayoutIteration } from '../src/engine/layoutPhysics'

function arrange(coordinates: number[], links: number[], iterations = 160) {
  const positions = new Float32Array(coordinates)
  const edges = new Int32Array(links)
  const neighbors = Array.from({ length: positions.length / 3 }, () => new Set<number>())
  for (let i = 0; i < edges.length; i += 2) {
    neighbors[edges[i]].add(edges[i + 1]); neighbors[edges[i + 1]].add(edges[i])
  }
  for (let i = 0; i < iterations; i++) applyLayoutIteration(positions, edges, neighbors)
  return positions
}

function distance(positions: Float32Array, a: number, b: number) {
  return Math.hypot(...[0, 1, 2].map(axis => positions[a * 3 + axis] - positions[b * 3 + axis]))
}

test('auto layout expands a compact link without making it excessively long', () => {
  const positions = arrange([0, 0, 0, 1, 0, 0], [0, 1])
  const length = distance(positions, 0, 1)
  assert.ok(length > 3.6 && length < 4.5, `link length: ${length}`)
})

test('neighboring branches have clearance while their own links stay compact', () => {
  const links = [0, 1, 0, 2, 1, 3, 2, 4, 3, 5, 4, 6]
  const positions = arrange([0, 0, 0, 1, .25, 0, 1, -.25, 0, 2, .3, 0, 2, -.3, 0, 3, .35, 0, 3, -.35, 0], links)
  for (let i = 0; i < links.length; i += 2) {
    const length = distance(positions, links[i], links[i + 1])
    assert.ok(length > 3.4 && length < 4.8, `link length: ${length}`)
  }
  for (const a of [1, 3, 5]) for (const b of [2, 4, 6]) {
    const gap = distance(positions, a, b)
    assert.ok(gap > 4.2, `branch gap ${a}/${b}: ${gap}`)
  }
})

test('coincident nodes separate deterministically with finite, bounded positions', () => {
  const coordinates = Array(7 * 3).fill(0)
  const links = [0, 1, 0, 2, 1, 3, 2, 4, 3, 5, 4, 6]
  const positions = arrange(coordinates, links)
  assert.deepEqual(positions, arrange(coordinates, links))
  assert.ok(positions.every(n => Number.isFinite(n) && Math.abs(n) < 10))
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    assert.ok(distance(positions, a, b) > 3, `overlap: ${a}/${b}`)
  }
})
