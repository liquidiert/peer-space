import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      vue(),
      tailwindcss(),
      VitePWA({
        // 'prompt' (not 'autoUpdate'): a silent auto-reload would yank the app out from
        // under someone mid call/screen-share. Instead the new SW installs in the
        // background and App.vue shows a toast letting the user reload on their own terms.
        registerType: 'prompt',
        // This is a live socket.io/WebRTC app, not offline-first content - the service
        // worker should only ever speed up loading the app shell (JS/CSS/icons), and must
        // never intercept the realtime traffic. Nothing under /api, /auth or /socket.io is
        // precached, and no runtime caching routes are added for them, so all of that
        // always goes straight to the network untouched.
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /^\/socket\.io\//],
        },
        includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'peer-space | Spatial Office',
          short_name: 'peer-space',
          description: '2D Spatial Virtual Office & Pixel Collaboration Hub',
          start_url: '/',
          display: 'standalone',
          background_color: '#0f172a',
          theme_color: '#fcd34d',
          icons: [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        '~': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
