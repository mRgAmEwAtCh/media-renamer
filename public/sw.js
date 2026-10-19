// Shows push notifications from the server, also when no Media Renamer page is open.
self.addEventListener('push', (event) => {
  const message = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(message.title ?? 'Media Renamer', {
      body: message.body ?? '',
      icon: '/icon-192.png',
      data: { url: message.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      return open ? open.focus() : self.clients.openWindow(event.notification.data?.url ?? '/');
    })(),
  );
});
