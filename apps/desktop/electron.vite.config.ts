import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const monorepoRoot = resolve(__dirname, '../..')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      // Vendored nessa-ui files import `@/lib/utils`; `@` is packages/ui/src everywhere.
      alias: { '@': resolve(monorepoRoot, 'packages/ui/src') },
      dedupe: ['react', 'react-dom']
    },
    server: { fs: { allow: [monorepoRoot] } },
    plugins: [react(), tailwindcss()]
  }
})
