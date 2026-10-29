import { resolve } from 'node:path'

import { defineConfig } from 'vite'

// One classic script, loaded from the site of the store with a plain <script> tag: an IIFE, no chunks
// and no stylesheet file (the styles live in the bundle and are applied with a constructable
// stylesheet), so it works under a strict Content-Security-Policy and costs one request.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  build: {
    outDir: resolve(import.meta.dirname, '../../dist/apps/widget'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    rolldownOptions: {
      // The constants come from barrels that also build zod schemas; without this the bundle keeps them
      treeshake: { moduleSideEffects: false }
    },
    lib: {
      entry: resolve(import.meta.dirname, 'src/main.ts'),
      name: 'PlatformWidget',
      formats: ['iife'],
      fileName: () => 'widget.js'
    }
  }
})
