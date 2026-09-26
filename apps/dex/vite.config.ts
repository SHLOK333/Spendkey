import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = path.resolve(__dirname, '../..')

// The frontend is a pure client SPA; every server secret (RPC key, agent keys, OpenAI key) stays in the
// standalone API server under `server/`. In dev the API runs on :3101 and Vite proxies `/api` to it, so the
// browser only ever talks to one origin. Only VITE_* variables are exposed to the client bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  const reownProjectId = env.VITE_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || ''
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    define: {
      'import.meta.env.VITE_REOWN_PROJECT_ID': JSON.stringify(reownProjectId),
    },
    server: {
      port: 3100,
      strictPort: true,
      proxy: {
        '/api': { target: `http://localhost:${env.PORT || 3101}`, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  }
})
