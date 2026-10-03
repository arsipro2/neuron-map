import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const pkg = json('package.json'), lock = json('package-lock.json'), config = json('src-tauri/tauri.conf.json')
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8'), cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8')
assert.equal(config.version, pkg.version)
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], pkg.version)
assert.equal(lock.packages[''].version, pkg.version)
for (const name of ['@tauri-apps/api', '@tauri-apps/cli']) {
  const expected = pkg.dependencies[name] ?? pkg.devDependencies[name]
  assert.equal(lock.packages[`node_modules/${name}`].version, expected)
  assert.equal(expected, cargoLock.match(/name = "tauri"\nversion = "([^"]+)"/)?.[1])
}
console.log(`Neuron Map ${pkg.version}: project versions and Tauri API / CLI / Rust match.`)
