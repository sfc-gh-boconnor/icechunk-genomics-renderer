import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: {
          'gosling': ['gosling.js'],
          'three': ['three', '@react-three/fiber', '@react-three/drei'],
          'deckgl': ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/react', '@deck.gl/widgets'],
        },
      },
    },
  },
})

