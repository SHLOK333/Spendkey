import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', '@tanstack/react-query'],
          evm: ['viem'],
          sui: ['@mysten/sui/grpc', '@mysten/sui/transactions', '@mysten/sui/bcs', '@mysten/dapp-kit-react'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
})
