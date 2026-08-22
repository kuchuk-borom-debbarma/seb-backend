import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

export default defineConfig({
  /*
   * The dependency-optimizer cache is per-server, not per-project.
   * Two dev servers started from this directory — yours on 9990 and the
   * end-to-end suite's on 9880 — otherwise share `node_modules/.vite` and
   * corrupt each other's pre-bundled output, which surfaces as the client
   * entry failing to load and the page never hydrating.
   */
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  resolve: { tsconfigPaths: true },
  plugins: [nitro(), tanstackStart(), viteReact()],
  build: {
    // Surfaces any chunk drifting past the per-route budget in the plan.
    chunkSizeWarningLimit: 200,
  },
})
