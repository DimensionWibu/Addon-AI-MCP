import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// Main & preload are ESM (package.json "type":"module") so the ESM-only
// @anthropic-ai/claude-agent-sdk imports cleanly. Deps are externalized
// (not bundled) — important for the SDK, which spawns the `claude` CLI.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
