import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const monorepoRoot = resolve(__dirname, '../..')

export default defineConfig({
  resolve: {
    alias: { '@': resolve(monorepoRoot, 'packages/ui/src') },
    dedupe: ['react', 'react-dom']
  },
  server: { port: 5173, fs: { allow: [monorepoRoot] } },
  plugins: [react(), tailwindcss()]
})
