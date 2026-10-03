import { cp, mkdir, copyFile } from 'node:fs/promises'
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await mkdir(`public/pdf/${folder}`, { recursive: true })
  await cp(`node_modules/pdfjs-dist/${folder}`, `public/pdf/${folder}`, { recursive: true })
}
await copyFile('node_modules/pdfjs-dist/LICENSE', 'public/pdf/LICENSE.txt')
