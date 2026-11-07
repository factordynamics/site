import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Served from GitHub Pages at https://refcell.github.io/gust/copybook/.
// Override with COPYBOOK_BASE when hosting elsewhere.
export default defineConfig({
  base: process.env.COPYBOOK_BASE || '/gust/copybook/',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
