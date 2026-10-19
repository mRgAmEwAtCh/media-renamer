const toBytes = (base64url) => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/**
 * The "Notify me" button: subscribes this browser to push notifications for
 * files that need review and failed jobs. Needs HTTPS (or localhost); on
 * iPhone the app must be added to the home screen first.
 */
export async function setupNotifications(api) {
  const button = document.getElementById('notifyToggle');
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const registration = await navigator.serviceWorker.register('/sw.js');
  let subscription = await registration.pushManager.getSubscription();

  const render = () => {
    button.textContent = subscription ? '🔔 Notifications on' : '🔕 Notify me';
    button.title = subscription
      ? 'Click to stop notifications on this device'
      : 'Get a notification on this device when files need review or a job fails';
    button.hidden = false;
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (subscription) {
        await api('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        subscription = null;
      } else {
        if ((await Notification.requestPermission()) !== 'granted') {
          throw new Error('Notifications are blocked for this site. Allow them in the browser settings and try again.');
        }
        const { publicKey } = await api('/api/push/key', {});
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
        await api('/api/push/subscribe', { subscription: subscription.toJSON() });
      }
    } catch (error) {
      alert(error.message);
    }
    button.disabled = false;
    render();
  });

  render();
  // Re-register in case the server lost its list.
  if (subscription) api('/api/push/subscribe', { subscription: subscription.toJSON() }).catch(() => {});
}
