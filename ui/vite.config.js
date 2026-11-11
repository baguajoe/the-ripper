import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The UI is loaded by Electron from ripper://app/ (prod) or the Vite dev server (dev),
// and later by the JUCE plugin's WebView — so all asset paths are relative.
// The production CSP (index.html) forbids inline scripts; Vite's dev server + React Refresh
// inject one, so the meta tag is dropped only when serving in dev.
const devCsp = {
  name: 'ripper-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, ''),
}

export default defineConfig({
  base: './',
  plugins: [react(), devCsp],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{js,jsx}'],
  },
})
