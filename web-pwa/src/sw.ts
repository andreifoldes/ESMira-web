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
  /** studyId/userId the server stamped in, so we can report delivery + click receipts. */
  sid?: number;
  uid?: string;
}

/** Report a push funnel event ('received'/'clicked') to the backend. Best-effort. */
function reportPushEvent(sid: number | undefined, uid: string | undefined, event: string): Promise<unknown> {
  if (!sid || !uid) return Promise.resolve();
  return fetch('/esmira/api/push_event.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studyId: sid, userId: uid, event }),
    keepalive: true,
  }).catch(() => undefined);
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
    Promise.all([
      self.registration.showNotification(title, {
        body: payload.body ?? '',
        icon: '/pwa/pwa-192x192.png',
        badge: '/pwa/pwa-192x192.png',
        tag: payload.tag,
        data: { url: payload.url || '/pwa/', sid: payload.sid, uid: payload.uid },
      }),
      // The notification actually reached this device — record "arrived".
      reportPushEvent(payload.sid, payload.uid, 'received'),
    ]),
  );
});

// Tapping a reminder focuses the already-open app, or opens it at the study.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string; sid?: number; uid?: string } | undefined;
  const targetUrl = data?.url || '/pwa/';
  event.waitUntil(
    (async () => {
      await reportPushEvent(data?.sid, data?.uid, 'clicked');
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of wins) {
        if (client.url.includes('/pwa/')) return (client as WindowClient).focus();
      }
      return self.clients.openWindow(targetUrl);
    })(),
  );
});
