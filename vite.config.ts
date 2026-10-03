import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['pdfjs-dist/legacy/build/pdf.mjs', 'react-markdown', 'remark-gfm', 'rehype-highlight'] },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  clearScreen: false,
  build: { rollupOptions: { output: { manualChunks(id) {
    if (id.includes('/three/build/three.core.js')) return 'three-core'
    if (id.includes('/three/build/three.module.js')) return 'three-renderer'
    if (id.includes('/node_modules/@react-three/')) return 'react-three'
  } } } },
})
