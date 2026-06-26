/// <reference lib="webworker" />
/**
 * Custom service worker (injectManifest strategy).
 *
 * Replicates the previous generateSW behaviour — precache the app shell, SPA
 * navigation fallback, NetworkFirst for the study definition, CacheFirst for
 * Google Fonts — and adds the web-push handlers that let the server deliver
 * questionnaire reminders while the PWA is closed.
 */
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

// Activate a new service worker immediately (matches registerType: 'autoUpdate').
self.skipWaiting();
clientsClaim();

// ── App shell precache (hashed assets injected at build time) ──────────────────
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback, but never intercept the PHP API.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/esmira\/api\//],
  }),
);

// Study definition: NetworkFirst so a previously opened study works offline.
// The query string is part of the cache key, so each access_key caches separately.
registerRoute(
  ({ url }) => url.pathname.endsWith('/api/studies.php'),
  new NetworkFirst({
    cacheName: 'esmira-study',
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

// Google Fonts (Inter) used by index.html.
registerRoute(
  ({ url }) =>
    url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  }),
);

// ── Web push: show the reminder the server sent ────────────────────────────────
interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let payload: PushPayload = {};
  if (event.data) {
    try {
      payload = event.data.json() as PushPayload;
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const title = payload.title || 'ESMira';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body ?? '',
      icon: '/esmira/pwa/pwa-192x192.png',
      badge: '/esmira/pwa/pwa-192x192.png',
      tag: payload.tag,
      data: { url: payload.url || '/esmira/pwa/' },
    }),
  );
});

// Tapping a reminder focuses the already-open app, or opens it at the study.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const targetUrl = data?.url || '/esmira/pwa/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of wins) {
        if (client.url.includes('/esmira/pwa/')) return (client as WindowClient).focus();
      }
      return self.clients.openWindow(targetUrl);
    })(),
  );
});
