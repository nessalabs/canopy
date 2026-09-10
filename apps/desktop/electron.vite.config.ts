import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const monorepoRoot = resolve(__dirname, '../..')

export default defineConfig({
  main: {
    // @canopy/shared ships TypeScript sources, so the main process bundles it rather than
    // importing it at runtime: the menu-bar tray drives the daemon through the same client
    // and routes the renderer uses.
    plugins: [externalizeDepsPlugin({ exclude: ['@canopy/shared'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          tray: resolve(__dirname, 'src/preload/tray.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      // Vendored nessa-ui files import `@/lib/utils`; `@` is packages/ui/src everywhere.
      alias: { '@': resolve(monorepoRoot, 'packages/ui/src') },
      dedupe: ['react', 'react-dom']
    },
    server: { fs: { allow: [monorepoRoot] } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // The menu-bar panel is its own document: a different window, its own preload.
          tray: resolve(__dirname, 'src/renderer/tray.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
