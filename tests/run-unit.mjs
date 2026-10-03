import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const directory = await mkdtemp(join(tmpdir(), 'neuron-map-unit-'))
try {
  const outfile = join(directory, 'core.test.mjs')
  await build({ entryPoints: ['tests/core.test.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' })
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally { await rm(directory, { recursive: true, force: true }) }
