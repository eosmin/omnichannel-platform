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
  has: (key: string) => boolean,
  params: Record<string, unknown> = {}
): NotificationTextKeys {
  const title = `${messageKey}.title`
  // A notification that carries who and whose (a mention) says it, where the text was written for it;
  // an older one, saved without them, keeps the plain text
  const withPeople = `${messageKey}.bodyWithPeople`
  const body =
    'author' in params && 'customer' in params && has(withPeople)
      ? withPeople
      : `${messageKey}.body`
  if (has(title) && has(body)) return { title, body }
  return { title: `${UNKNOWN_NOTIFICATION_KEY}.title`, body: `${UNKNOWN_NOTIFICATION_KEY}.body` }
}

// The badge of the bell: the count up to the cap, then "99+" (TDD_06 §8)
export function badgeLabel(count: number): string {
  return count > NotificationLimits.BADGE_CAP ? `${NotificationLimits.BADGE_CAP}+` : String(count)
}

// Characters that make a path read differently to the eye, to this check and to the browser: controls
// (a tab or a line feed is dropped by the URL parser, so "/<tab>/host" becomes "//host"), the invisible
// format ones (zero-width, bidi), any space and the backslash that some browsers read as a slash.
const UNSAFE_IN_PATH = /[\p{Cc}\p{Cf}\s\\]/u
// An encoded slash, backslash or dot in the path hides a segment that a server or a proxy may read as a
// real one. The query may hold them (`?next=%2Finbox`): it cannot change which page opens.
const ENCODED_SEPARATOR = /%(?:2f|5c|2e)/i

// Where a click goes: a path of this app only. The api writes it, but `//host` or another origin
// must never become a navigation.
export function safeActionPath(path: string | null): string | null {
  if (path === null || !path.startsWith('/') || path.startsWith('//')) return null
  if (UNSAFE_IN_PATH.test(path)) return null
  const [location = ''] = path.split(/[?#]/, 1)
  if (ENCODED_SEPARATOR.test(location)) return null
  // A dot segment climbs out of the page it names
  if (location.split('/').some(segment => segment === '.' || segment === '..')) return null
  // A path that starts with one slash, with no other slash, backslash or control character before the
  // first segment can only be read by the browser as a path of this origin
  return path
}
