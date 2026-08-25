import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import tailwindcss from '@tailwindcss/vite'

/*
 * Playwright serves a production build for the duration of a long serial suite.
 * Keeping that build under its ignored test directory prevents an ordinary
 * `npm run build` in another terminal from replacing hashed assets while the
 * suite is still requesting them.
 */
const e2eBuildRoot = process.env.SEP_E2E_BUILD_ROOT

export default defineConfig({
  /*
   * The dependency-optimizer cache is per-server, not per-project.
   * Two dev servers started from this directory — yours on 9990 and the
   * end-to-end suite's on 9880 — otherwise share `node_modules/.vite` and
   * corrupt each other's pre-bundled output, which surfaces as the client
   * entry failing to load and the page never hydrating.
   */
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  /*
   * The preset is deliberately not set here.
   *
   * `npm run build` must keep producing a Node server, because the end-to-end
   * suite runs the built artifact with `node .output/server/index.mjs`. A
   * Cloudflare build exports a module with a `fetch` handler instead, which
   * `node` will happily load and then exit from without ever listening.
   *
   * `npm run build:cf` sets NITRO_PRESET=cloudflare-module for the deployable
   * build. Two targets, chosen explicitly, rather than one that silently means
   * something different depending on the environment.
   */
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro(
      e2eBuildRoot
        ? {
            buildDir: `${e2eBuildRoot}/nitro`,
            output: { dir: `${e2eBuildRoot}/output` },
          }
        : {},
    ),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  build: {
    // Surfaces any chunk drifting past the per-route budget in the plan.
    chunkSizeWarningLimit: 200,
  },
})
