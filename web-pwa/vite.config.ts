import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// In production the app is served by Apache at /esmira/pwa/.
// In dev, all /esmira/api/* calls are proxied to a running ESMira instance.
// Override the proxy target with ESMIRA_PROXY (e.g. a local Docker container at
// http://localhost:8081, or the live instance).
const ESMIRA = process.env.ESMIRA_PROXY || 'https://iemabot.surrey.ac.uk';

// Surface the package version to the app (shown on the About ESMira screen).
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  base: '/esmira/pwa/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // injectManifest: we own the service worker (src/sw.ts) so it can handle
      // `push` / `notificationclick` for web-push reminders, while still
      // precaching the app shell and keeping the runtime caches.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Static files (copied from public/) that the SW should precache too.
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'esmira-logo.svg'],
      manifest: {
        // id/scope/start_url are all the served sub-path so the installed app is
        // isolated from ESMira's admin UI at /esmira/. start_url carries no ?key=
        // (the manifest can't); App.tsx restores the last study from localStorage.
        id: '/esmira/pwa/',
        scope: '/esmira/pwa/',
        start_url: '/esmira/pwa/',
        name: 'ESMira',
        short_name: 'ESMira',
        description: 'Take part in your ESMira study.',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#075E54',
        background_color: '#075E54',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Files to precache (the runtime caches/routes live in src/sw.ts).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
      // Exercise the service worker under `npm run dev` (which proxies /esmira/api).
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    // Output into the served tree at <repo>/dist/pwa so Apache can serve it
    // alongside ESMira's own dist/. Kept out of ESMira's webpack build.
    outDir: path.resolve(__dirname, '..', 'dist', 'pwa'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/esmira/api': {
        target: ESMIRA,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
