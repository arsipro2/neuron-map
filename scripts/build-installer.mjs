import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const presets = {
  linux: { host: 'linux', bundles: ['deb', 'appimage'] },
  'linux-deb': { host: 'linux', bundles: ['deb'] },
  'linux-appimage': { host: 'linux', bundles: ['appimage'] },
  windows: { host: 'win32', bundles: ['nsis'] },
  'windows-msi': { host: 'win32', bundles: ['msi'] },
  'windows-offline': { host: 'win32', bundles: ['nsis'], config: 'src-tauri/tauri.windows.offline.conf.json' },
  macos: { host: 'darwin', bundles: ['app', 'dmg'] },
  'macos-universal': { host: 'darwin', bundles: ['app', 'dmg'], target: 'universal-apple-darwin' },
}
const [name, ...options] = process.argv.slice(2)
const preset = presets[name]
function fail(message) {
  console.error(message)
  process.exit(1)
}
if (!preset || options.some(option => option !== '--dry-run')) {
  fail(`Usage: node scripts/build-installer.mjs <${Object.keys(presets).join('|')}> [--dry-run]`)
}

const args = ['build', '--ci', '--bundles', ...preset.bundles]
if (preset.config) args.push('--config', preset.config)
if (preset.target) args.push('--target', preset.target)
args.push('--', '--locked')
const output = resolve(root, 'src-tauri/target', preset.target ?? '', 'release/bundle')
if (options.includes('--dry-run')) {
  console.log(JSON.stringify({ preset: name, requiredHost: preset.host, args, output }, null, 2))
  process.exit(0)
}
if (process.platform !== preset.host) {
  fail(`Preset ${name} requires ${preset.host}; this host is ${process.platform}. See BUILD-INSTALLERS.md for Docker and GitHub Actions.`)
}
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js')
if (!existsSync(cli)) fail('Install project dependencies first: npm ci')
if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  fail('Rust/Cargo is missing from PATH. Install Rust using rustup, then reopen your terminal. See BUILD-INSTALLERS.md.')
}
if (preset.host === 'linux' && spawnSync('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1'], { stdio: 'ignore' }).status !== 0) {
  fail('Linux build dependencies are missing: pkg-config, GTK 3 and WebKitGTK 4.1. See BUILD-INSTALLERS.md or use the Docker build.')
}
console.log(`Building ${name}. The installed application embeds its frontend; no development server is started.`)
const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' })
if (result.error) fail(result.error.message)
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Installers: ${output}`)
