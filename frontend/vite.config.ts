import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

/**
 * Dev/preview server: proxy `/api` to the backend so the browser only ever talks
 * to its own origin - exactly like production. Without this the SPA has to call
 * `http://localhost:4000` directly, which breaks whenever the port differs, the
 * app is opened from 127.0.0.1 instead of localhost, or the backend's
 * `FRONTEND_URL` CORS allowlist does not match. All of those surface as a bare
 * "Failed to fetch" with nothing useful in it.
 *
 * Override the target with API_PROXY_TARGET when the backend is elsewhere.
 */
const apiTarget = process.env.API_PROXY_TARGET?.trim() || 'http://localhost:4000'

/** Returns JSON, not HTML, when the proxy cannot reach the backend. */
function apiProxy() {
  return {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
    configure(proxy: { on: (event: string, handler: (error: Error, req: unknown, res: any) => void) => void }) {
      proxy.on('error', (error, _req, res) => {
        if (typeof res?.writeHead !== 'function' || res.headersSent) return
        const reason = (error as { code?: string }).code || error.message || 'connection failed'
        console.error(`[vite] /api proxy error -> ${apiTarget}: ${reason}`)
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 'API_UNREACHABLE',
            message: `The dev server could not reach the backend at ${apiTarget} (${reason}). Start it with "npm run dev" in backend/, or set API_PROXY_TARGET.`,
          }),
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-192x192.svg', 'pwa-512x512.svg', 'maskable-icon.svg'],
      manifest: {
        name: '9Drive',
        short_name: '9Drive',
        description: 'Google Drive storage gateway for files, folders, sharing, and quota tracking.',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/all-files',
        scope: '/',
        orientation: 'portrait-primary',
        icons: [
          { src: '/pwa-192x192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/pwa-512x512.svg', sizes: '512x512', type: 'image/svg+xml' },
          { src: '/maskable-icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/(auth|connected-accounts|files|folders|invites|provider-configs|public|storage|uploads)(\/|$)/],
        globPatterns: ['**/*.{js,css,html,svg,ico,png,webp,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // 0.0.0.0 so the app is reachable from a phone on the same network and from
    // container/preview hosts, not just from localhost.
    host: true,
    port: 5173,
    // Dev only: accept whatever hostname the preview proxy / tunnel uses.
    // Vite otherwise answers "Blocked request. This host is not allowed."
    allowedHosts: true,
    proxy: { '/api': apiProxy() },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    proxy: { '/api': apiProxy() },
  },
})
