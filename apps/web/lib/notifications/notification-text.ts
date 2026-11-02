import { NotificationLimits } from '@platform/core/notifications'

// The text of a notification is its message key plus `.title` / `.body` (`notificationMessageKey`).
// A key this page has no text for (a server newer than the page) draws under the generic one, not as
// a raw key.
export const UNKNOWN_NOTIFICATION_KEY = 'notifications.unknown'

export interface NotificationTextKeys {
  title: string
  body: string
}

export function notificationTextKeys(
  messageKey: string,
  has: (key: string) => boolean
): NotificationTextKeys {
  const title = `${messageKey}.title`
  const body = `${messageKey}.body`
  if (has(title) && has(body)) return { title, body }
  return { title: `${UNKNOWN_NOTIFICATION_KEY}.title`, body: `${UNKNOWN_NOTIFICATION_KEY}.body` }
}

// The badge of the bell: the count up to the cap, then "99+" (TDD_06 §8)
export function badgeLabel(count: number): string {
  return count > NotificationLimits.BADGE_CAP ? `${NotificationLimits.BADGE_CAP}+` : String(count)
}

// Where a click goes: a path of this app only. The api writes it, but `//host` or another origin
// must never become a navigation.
export function safeActionPath(path: string | null): string | null {
  if (path === null || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return null
  }
  return path
}
