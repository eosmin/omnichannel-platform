import {
  type ApiClient,
  registerPushSubscription,
  removePushSubscription
} from '@platform/api-client'

// Where the worker is served (app/serwist/[path]/route.ts) and how far it reaches
export const ServiceWorkerFile = {
  URL: '/serwist/sw.js',
  SCOPE: '/'
} as const

export const PushSubscribeResult = {
  SUBSCRIBED: 'subscribed',
  DENIED: 'denied',
  // The permission popup was closed with no answer: the browser still says 'default'
  DISMISSED: 'dismissed',
  UNSUPPORTED: 'unsupported'
} as const
export type PushSubscribeResultType = (typeof PushSubscribeResult)[keyof typeof PushSubscribeResult]

// The key of the server as the browser wants it. The value is base64url, without padding.
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (current === null) return false
  const bytes = new Uint8Array(current)
  return bytes.length === expected.length && bytes.every((byte, i) => byte === expected[i])
}

// The server key is set for this environment. Without it no browser can subscribe, so the page says
// the environment lacks the setup instead of blaming a browser that may well support push.
export function isPushConfigured(publicKey: string | undefined): boolean {
  return publicKey !== undefined && publicKey !== ''
}

export function isPushSupported(publicKey: string | undefined): boolean {
  return (
    isPushConfigured(publicKey) &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// 'default' is the browser that was never asked; null when push cannot work here
export function pushPermission(publicKey: string | undefined): NotificationPermission | null {
  return isPushSupported(publicKey) ? Notification.permission : null
}

async function registerWorker(): Promise<ServiceWorkerRegistration> {
  // A classic script (the route builds it as an IIFE): module workers are not supported everywhere
  await navigator.serviceWorker.register(ServiceWorkerFile.URL, {
    scope: ServiceWorkerFile.SCOPE
  })
  return navigator.serviceWorker.ready
}

// Asks the permission (a browser that was asked before answers at once), subscribes this browser to
// the push service and tells the api, for the person who is signed in. TDD_06 §7.3.
export async function subscribeToPush(
  client: ApiClient,
  storeId: string,
  publicKey: string | undefined
): Promise<PushSubscribeResultType> {
  if (publicKey === undefined || !isPushSupported(publicKey)) return PushSubscribeResult.UNSUPPORTED
  const permission = await Notification.requestPermission()
  if (permission === 'default') return PushSubscribeResult.DISMISSED
  if (permission !== 'granted') return PushSubscribeResult.DENIED

  const registration = await registerWorker()
  const serverKey = urlBase64ToUint8Array(publicKey)
  let subscription = await registration.pushManager.getSubscription()
  // A subscription made for another VAPID key is refused by the push service for good: start over
  if (subscription !== null && !sameKey(subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey
  })
  const { endpoint, keys } = subscription.toJSON()
  if (endpoint === undefined || keys?.p256dh === undefined || keys.auth === undefined) {
    // A subscription with no keys cannot be pushed to
    await subscription.unsubscribe()
    return PushSubscribeResult.UNSUPPORTED
  }
  await registerPushSubscription(client, storeId, {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: navigator.userAgent.slice(0, 512)
  })
  return PushSubscribeResult.SUBSCRIBED
}

// On sign out: this browser stops receiving the pushes of the person who leaves (a shared computer
// would show the next person's notifications to them otherwise). It never throws: leaving must not
// depend on it, and a subscription that stays is dropped by the push service when it answers 410.
export async function unsubscribeFromPush(
  client: ApiClient,
  storeId: string | null
): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const registration = await navigator.serviceWorker.getRegistration(ServiceWorkerFile.SCOPE)
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription === undefined || subscription === null) return
    const { endpoint } = subscription
    // The browser first: it must stop receiving even when the session is gone or the api is down
    await subscription.unsubscribe()
    if (storeId !== null) await removePushSubscription(client, storeId, endpoint)
  } catch {
    // Best effort
  }
}

// Whether this browser holds a push subscription right now (the permission alone does not say: a
// person may have turned it off here). False where push cannot work.
export async function hasPushSubscription(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false
    const registration = await navigator.serviceWorker.getRegistration(ServiceWorkerFile.SCOPE)
    return (await registration?.pushManager.getSubscription()) != null
  } catch {
    return false
  }
}
