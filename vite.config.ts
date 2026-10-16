import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // `npm run dev` only serves the client — the backend (server/) runs
    // separately on 4001, so proxy /api there to keep the browser's cookies
    // and fetch('/api/...') calls same-origin during local dev too.
    proxy: {
      '/api': 'http://localhost:4001',
    },
  },
})
