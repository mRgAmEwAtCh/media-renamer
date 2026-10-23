import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';

const toBytes = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/**
 * Push notifications for files that need review and failed jobs. Needs HTTPS
 * (or localhost); on iPhone the app must be added to the home screen first.
 * `available` is false where the browser cannot do push.
 */
export function useNotifications() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    (async () => {
      const registered = await navigator.serviceWorker.register('/sw.js');
      const existing = await registered.pushManager.getSubscription();
      setRegistration(registered);
      setSubscription(existing);
      // Re-register in case the server lost its list.
      if (existing) api('/api/push/subscribe', { subscription: existing.toJSON() }).catch(() => {});
    })().catch((error: unknown) => console.warn(`Notifications unavailable: ${errorMessage(error)}`));
  }, []);

  const toggle = useCallback(async () => {
    if (!registration) return;
    setPending(true);
    try {
      if (subscription) {
        await api('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        setSubscription(null);
      } else {
        if ((await Notification.requestPermission()) !== 'granted') {
          throw new Error('Notifications are blocked for this site. Allow them in the browser settings and try again.');
        }
        const { publicKey } = await api('/api/push/key', {});
        const created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
        await api('/api/push/subscribe', { subscription: created.toJSON() });
        setSubscription(created);
      }
    } catch (error) {
      alert(errorMessage(error));
    }
    setPending(false);
  }, [registration, subscription]);

  return { available: registration !== null, enabled: subscription !== null, pending, toggle };
}
