import {
  actionPathOf,
  openNotificationTarget,
  parsePushPayload,
  pushDisplayOf,
  targetPathOf,
  type ClientsLike
} from './lib/push/service-worker-push'

// The one service worker of the app (TDD_09 §16.3, TDD_06 §7.2). It holds the push handlers only.
// The caching rules and the manifest are Step 8.3, which adds them to this file.
declare const self: ServiceWorkerGlobalScope

self.addEventListener('push', event => {
  let raw: unknown = null
  try {
    raw = event.data?.json()
  } catch {
    // Not JSON: nothing to show
  }
  const payload = parsePushPayload(raw)
  if (payload === null) return
  const { title, options } = pushDisplayOf(payload)
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const origin = self.location.origin
  const target = targetPathOf(actionPathOf(event.notification.data), origin)
  const clients: ClientsLike = {
    matchAll: () => self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    openWindow: url => self.clients.openWindow(url)
  }
  event.waitUntil(openNotificationTarget(clients, target, origin))
})
