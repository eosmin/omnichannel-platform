import { NotificationSeverity, type PushPayload } from '@platform/core/notifications'

// What the service worker does with a push and with a click on its notification, kept apart from
// the worker's globals so it can be tested. Nothing here touches `self`.

const START_PATH = '/'

// The body of a push is JSON written by our worker, but the worker of the browser takes whatever
// arrives: anything that is not the shape of a PushPayload is dropped, never shown
export function parsePushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const { notificationId, title, body, tag, severity, actionPath } = value
  if (
    typeof notificationId !== 'string' ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof tag !== 'string' ||
    typeof severity !== 'string' ||
    (actionPath !== null && typeof actionPath !== 'string')
  ) {
    return null
  }
  return {
    notificationId,
    title,
    body,
    tag,
    // A severity this page does not know (a newer server) is drawn like an information
    severity: (Object.values(NotificationSeverity) as string[]).includes(severity)
      ? (severity as PushPayload['severity'])
      : NotificationSeverity.INFO,
    actionPath
  }
}

export interface NotificationData {
  actionPath: string | null
  notificationId: string
}

export interface PushDisplay {
  title: string
  options: {
    body: string
    // Same tag replaces the notification of the same thing on the device
    tag: string
    // An error stays until the person acts on it
    requireInteraction: boolean
    data: NotificationData
  }
}

export function pushDisplayOf(payload: PushPayload): PushDisplay {
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.tag,
      requireInteraction: payload.severity === NotificationSeverity.ERROR,
      data: { actionPath: payload.actionPath, notificationId: payload.notificationId }
    }
  }
}

// The page a click opens. The path comes from the server, but a notification is a door into the
// app: only a path of this origin goes through, anything else (another site, a `//host`, a
// `javascript:` url) opens the start page.
export function targetPathOf(actionPath: unknown, origin: string): string {
  if (typeof actionPath !== 'string' || !actionPath.startsWith('/')) return START_PATH
  let url: URL
  try {
    url = new URL(actionPath, origin)
  } catch {
    return START_PATH
  }
  if (url.origin !== origin) return START_PATH
  return `${url.pathname}${url.search}${url.hash}`
}

export function actionPathOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { actionPath } = data as Record<string, unknown>
  return typeof actionPath === 'string' ? actionPath : null
}

export interface WindowClientLike {
  url: string
  focus: () => Promise<unknown>
  navigate: (url: string) => Promise<unknown>
}

export interface ClientsLike {
  matchAll: () => Promise<readonly WindowClientLike[]>
  openWindow: (url: string) => Promise<unknown>
}

// Reuses a window of the app when there is one (it goes to the page and takes the focus), and opens
// a new one when there is not
export async function openNotificationTarget(
  clients: ClientsLike,
  target: string,
  origin: string
): Promise<void> {
  const windows = await clients.matchAll()
  const own = windows.find(client => new URL(client.url).origin === origin)
  if (own === undefined) {
    await clients.openWindow(target)
    return
  }
  // navigate() is refused for a window the worker does not control (the tab that registered it):
  // then a new window opens at the page, so the click never lands on the wrong one
  try {
    await own.navigate(target)
  } catch {
    await clients.openWindow(target)
    return
  }
  await own.focus()
}
