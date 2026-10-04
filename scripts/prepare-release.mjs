import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesIn(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export async function prepareRelease(artifacts, output, version) {
  const required = { 'ubuntu-x64': ['.deb', '.AppImage'], 'windows-x64': ['.exe'], 'macos-universal': ['.dmg'] }
  const assets = []
  for (const [platform, extensions] of Object.entries(required)) {
    const files = await filesIn(join(artifacts, `neuron-map-${platform}`))
    for (const extension of extensions) {
      const candidates = files.filter(file => file.endsWith(extension))
      if (candidates.length !== 1) throw new Error(`Expected one ${extension} installer for ${platform}, found ${candidates.length}`)
      const file = candidates[0], name = basename(file)
      if (!name.includes(`_${version}_`)) throw new Error(`Installer version mismatch: ${name}`)
      if (!(await stat(file)).size) throw new Error(`Empty installer: ${name}`)
      if (assets.some(asset => basename(asset) === name)) throw new Error(`Duplicate installer name: ${name}`)
      assets.push(file)
    }
  }
  // Never mix a fresh release with stale files in an existing output directory.
  await mkdir(output)
  const checksums = []
  for (const file of assets) {
    const target = join(output, basename(file))
    await copyFile(file, target)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(target)) hash.update(chunk)
    checksums.push(`${hash.digest('hex')}  ${basename(file)}`)
  }
  await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
  return assets.map(file => join(output, basename(file)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, output] = process.argv.slice(2)
  if (!artifacts || !output) throw new Error('Usage: node scripts/prepare-release.mjs ARTIFACTS OUTPUT')
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const files = await prepareRelease(artifacts, output, version)
  console.log(`Prepared ${files.length} installers for v${version} and SHA256SUMS.`)
}
