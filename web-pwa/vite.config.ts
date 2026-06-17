import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// In production the app is served by Apache at /esmira/pwa/.
// In dev, all /esmira/api/* calls are proxied to a running ESMira instance.
// Override the proxy target with ESMIRA_PROXY (e.g. a local Docker container at
// http://localhost:8081, or the live instance).
const ESMIRA = process.env.ESMIRA_PROXY || 'https://iemabot.surrey.ac.uk';

export default defineConfig({
  base: '/esmira/pwa/',
  plugins: [react(), tailwindcss()],
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
