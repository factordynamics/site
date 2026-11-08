import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Holdterm: static SPA on Cloudflare Pages (project "holdterm"). All data is read in the browser from
// Copybook's public SEC EDGAR files; nothing is fetched at build time.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { target: 'es2022' },
})
