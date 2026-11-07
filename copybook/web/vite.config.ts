import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Served at https://copybook.factordynamics.com/ (GitHub Pages, .github/workflows/copybook-pages.yml).
// Data is published by copybook/ingest to refcell/gust and read cross-origin (Pages sends CORS *).
// COPYBOOK_BASE, VITE_SITE and VITE_DATA_BASE override these for another host.
process.env.VITE_SITE ||= 'https://copybook.factordynamics.com/'
process.env.VITE_DATA_BASE ||= 'https://refcell.github.io/gust/copybook/data/'
export default defineConfig({
  base: process.env.COPYBOOK_BASE || '/',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
