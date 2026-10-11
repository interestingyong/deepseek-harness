import { defineConfig } from 'tsdown'

/**
 * Build the proxy and worker separately so each inlines shared modules; a
 * multi-entry build creates an unlisted chunk. The worker is CommonJS because
 * Node's `Worker` resolves it via `new URL('./worker.cjs', import.meta.url)`.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/worker.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
