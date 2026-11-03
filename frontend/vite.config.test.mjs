/**
 * Bundles a single module for the error-path tests.
 *
 * `src/lib/api.ts` imports through the `@/` alias, which Node's loader does not
 * resolve. This config resolves it exactly like `vite.config.ts` does, so the
 * test exercises the shipped module rather than a rewritten copy. Only the one
 * entry is built - no app, no PWA plugin, no CSS.
 */
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  build: {
    // Env-var reads are baked in; the test sets them before importing.
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/lib/api.ts'),
      formats: ['es'],
      fileName: () => 'api.mjs',
    },
    outDir: process.env.API_TEST_OUT_DIR || 'test/.tmp',
    emptyOutDir: true,
    minify: false,
    target: 'node20',
  },
})
