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
import { getCompletion } from './lib/completionMirror';

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
// A constant tag keeps at most one ESMira notification on screen (each push replaces
// the last), and the per-questionnaire `items` let us drop any survey the participant
// has already completed (read from the IndexedDB completion mirror, since the SW can't
// read localStorage). See completionMirror.ts and backend PushSender::buildCoalescedPayload.
const DEFAULT_TAG = 'esmira-reminder';

/** One questionnaire referenced by a (possibly coalesced) push. */
interface PushItem {
  qid: number;
  /** When this occurrence's completion window opened (epoch ms). */
  windowStart?: number;
  /** Whether the questionnaire is one-shot (completableOnce). */
  once?: boolean;
  title?: string;
  body?: string;
}

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  /** studyId/userId the server stamped in, so we can report delivery + click receipts. */
  sid?: number;
  uid?: string;
  /** Per-questionnaire entries for completed-survey suppression + remaining-count re-render. */
  items?: PushItem[];
  /** printf template ("You have %d questionnaires…") used when some items are dropped. */
  bodyTemplate?: string;
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

/** Has this questionnaire's current occurrence already been completed? */
async function itemCompleted(sid: number, uid: string, it: PushItem): Promise<boolean> {
  const rec = await getCompletion(sid, uid, it.qid);
  if (!rec) return false;
  // Completed at/after this occurrence's window opened → already handled.
  if (typeof it.windowStart === 'number' && rec.lastAt >= it.windowStart) return true;
  // One-shot questionnaire completed at least once (covers completion on an earlier day).
  if (it.once && rec.count > 0) return true;
  return false;
}

async function showReminder(payload: PushPayload): Promise<void> {
  const tag = payload.tag || DEFAULT_TAG;
  let title = payload.title || 'ESMira';
  let body = payload.body ?? '';

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length && payload.sid && payload.uid) {
    const remaining: PushItem[] = [];
    for (const it of items) {
      if (!(await itemCompleted(payload.sid, payload.uid, it))) remaining.push(it);
    }
    // Everything referenced here is already done — never prompt for a completed survey.
    // (On userVisibleOnly subscriptions the platform may occasionally surface a generic
    // fallback; the server also stops reminding once a dataset arrives, so this is rare.)
    if (remaining.length === 0) return;
    if (remaining.length === 1) {
      title = remaining[0].title || title;
      body = remaining[0].body || body;
    } else {
      title = payload.title || 'ESMira';
      body = payload.bodyTemplate
        ? payload.bodyTemplate.replace('%d', String(remaining.length))
        : `You have ${remaining.length} questionnaires to complete.`;
    }
  }

  // Never stack: clear any existing ESMira notification, then show exactly one.
  for (const n of await self.registration.getNotifications({ tag })) n.close();
  await self.registration.showNotification(title, {
    body,
    icon: '/pwa/pwa-192x192.png',
    badge: '/pwa/pwa-192x192.png',
    tag,
    renotify: true,
    data: { url: payload.url || '/pwa/', sid: payload.sid, uid: payload.uid },
  } as NotificationOptions);
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
  event.waitUntil(
    Promise.all([
      showReminder(payload),
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
