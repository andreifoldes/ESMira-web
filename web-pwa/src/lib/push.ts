/**
 * Browser-side web-push helpers.
 *
 * The flow: confirm support → ensure notification permission → get (or create) a
 * PushManager subscription against the server's VAPID public key. The resulting
 * `PushSubscription` is then POSTed to the backend via `subscribeToPush` so the
 * server scheduler can deliver reminders while the app is closed.
 *
 * Note: actual delivery only works over HTTPS (or localhost) and, on iOS, only
 * for a PWA installed to the Home Screen (iOS 16.4+).
 */

/** True when this browser can register a web-push subscription. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Convert a base64url VAPID public key to the Uint8Array `applicationServerKey` wants. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Get the existing push subscription for the active service worker, or create one
 * bound to `vapidPublicKey`. Returns the subscription serialized as JSON, ready to
 * send to the backend. Throws if push is unsupported or the SW isn't ready.
 */
export async function ensurePushSubscription(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!isPushSupported()) throw new Error('Push is not supported on this device');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  return sub.toJSON();
}
