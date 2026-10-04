import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareRelease } from '../scripts/prepare-release.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'neuron-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = [
    ['ubuntu-x64', 'neuron-map_0.22.2_amd64.deb'], ['ubuntu-x64', 'Neuron.Map_0.22.2_amd64.AppImage'],
    ['windows-x64', 'Neuron.Map_0.22.2_x64-setup.exe'], ['macos-universal', 'Neuron.Map_0.22.2_universal.dmg'],
  ]
  for (const [platform, name] of files) {
    const directory = join(root, `neuron-map-${platform}`, 'bundle')
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), 'installer-fixture')
  }
  return { root, output: join(root, 'assets') }
}

test('release requires all platforms and produces checksums of the copied assets', async t => {
  const { root, output } = await fixture(t)
  const files = await prepareRelease(root, output, '0.22.2')
  assert.equal(files.length, 4)
  const expectedHash = createHash('sha256').update('installer-fixture').digest('hex')
  const sums = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n')
  assert.equal(sums.length, 4)
  assert.ok(sums.every(line => line.startsWith(`${expectedHash}  `)))
  await assert.rejects(prepareRelease(root, output, '0.22.2'), /EEXIST/)
})

test('release rejects missing platform, wrong version, and duplicate installer formats', async t => {
  const { root, output } = await fixture(t)
  await assert.rejects(prepareRelease(root, output, '0.22.3'), /version mismatch/)
  const extra = join(root, 'neuron-map-windows-x64', 'extra_0.22.2_x64.exe')
  await writeFile(extra, 'duplicate')
  await assert.rejects(prepareRelease(root, output, '0.22.2'), /Expected one .exe/)
  await rm(extra)
  await rm(join(root, 'neuron-map-macos-universal'), { recursive: true })
  await assert.rejects(prepareRelease(root, output, '0.22.2'), /ENOENT/)
})

test('release rejects an empty installer', async t => {
  const { root, output } = await fixture(t)
  await writeFile(join(root, 'neuron-map-ubuntu-x64', 'bundle', 'neuron-map_0.22.2_amd64.deb'), '')
  await assert.rejects(prepareRelease(root, output, '0.22.2'), /Empty installer/)
})
