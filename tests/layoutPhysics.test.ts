import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLayoutIteration, buildLayoutBranches } from '../src/engine/layoutPhysics'

function arrange(coordinates: number[], links: number[], iterations = 160) {
  const positions = new Float32Array(coordinates)
  const edges = new Int32Array(links)
  const neighbors = Array.from({ length: positions.length / 3 }, () => new Set<number>())
  for (let i = 0; i < edges.length; i += 2) {
    neighbors[edges[i]].add(edges[i + 1]); neighbors[edges[i + 1]].add(edges[i])
  }
  const branches = buildLayoutBranches(positions, edges, neighbors)
  for (let i = 0; i < iterations; i++) applyLayoutIteration(positions, edges, neighbors, branches)
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
  // Three outward links can legitimately span about 12 units from the root.
  assert.ok(positions.every(n => Number.isFinite(n) && Math.abs(n) < 15))
  for (let i = 0; i < links.length; i += 2) assert.ok(distance(positions, links[i], links[i + 1]) < 5)
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    assert.ok(distance(positions, a, b) > 3, `overlap: ${a}/${b}`)
  }
})

test('folded branches unfold away from their root instead of returning into the graph', () => {
  const coordinates = [0, 0, 0, 4, 0, 0, 2, 2, 0, 1, 3, 0, -4, 0, 0, -2, -2, 0, -1, -3, 0]
  const links = [0, 1, 1, 2, 2, 3, 0, 4, 4, 5, 5, 6]
  for (const edges of [links, [...links, 3, 4]]) {
    const positions = arrange(coordinates, edges)
    assert.deepEqual([...positions.slice(0, 3)], [0, 0, 0], 'root should stay in place')
    for (const [sign, branch] of [[1, [0, 1, 2, 3]], [-1, [0, 4, 5, 6]]] as const) {
      for (let i = 1; i < branch.length; i++) {
        const parent = branch[i - 1], child = branch[i]
        const advance = sign * (positions[child * 3] - positions[parent * 3])
        assert.ok(advance > 2, `branch turned inward: ${parent}/${child}, advance ${advance}`)
        assert.ok(distance(positions, parent, child) < 5, 'branch should remain compact')
      }
      for (let i = 1; i < branch.length - 1; i++) {
        const [a, b, c] = [branch[i - 1], branch[i], branch[i + 1]]
        const dot = [0, 1, 2].reduce((sum, axis) => sum + (positions[b * 3 + axis] - positions[a * 3 + axis]) * (positions[c * 3 + axis] - positions[b * 3 + axis]), 0)
        assert.ok(dot / (distance(positions, a, b) * distance(positions, b, c)) > 0.8, 'sharp bend inside a branch')
      }
    }
  }
})

test('layout forest handles reversed links, cycles, separate components and isolated notes', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 8, 0, 0, 9, 0, 0, 10, 0, 0, 20, 0, 0])
  const edges = new Int32Array([1, 0, 1, 2, 3, 4, 4, 5, 5, 3])
  const neighbors = Array.from({ length: 7 }, () => new Set<number>())
  for (let i = 0; i < edges.length; i += 2) {
    neighbors[edges[i]].add(edges[i + 1]); neighbors[edges[i + 1]].add(edges[i])
  }
  const branches = buildLayoutBranches(positions, edges, neighbors)
  assert.equal(branches.parents[1], -1)
  assert.equal(branches.parents[0], 1)
  assert.equal(branches.parents[2], 1)
  assert.equal(branches.parents[6], -1)
  assert.equal([...branches.parents].filter(parent => parent === -1).length, 3)
  assert.ok(branches.parents.every(parent => parent >= -1))
  for (let i = 0; i < 160; i++) applyLayoutIteration(positions, edges, neighbors, branches)
  assert.ok(positions.every(Number.isFinite))
  assert.deepEqual(buildLayoutBranches(new Float32Array(), new Int32Array(), []).parents, new Int32Array())
})
