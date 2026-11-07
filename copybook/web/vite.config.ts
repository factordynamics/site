import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Default build is for https://refcell.github.io/gust/copybook/. Another host sets COPYBOOK_BASE,
// VITE_SITE (absolute site URL) and VITE_DATA_BASE (data URL) in the environment.
process.env.VITE_SITE ||= 'https://refcell.github.io/gust/copybook/'
export default defineConfig({
  base: process.env.COPYBOOK_BASE || '/gust/copybook/',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
