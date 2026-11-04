import {
  type NotificationType,
  NotificationTypes,
  notificationMessageKey
} from './notification-constants'

// Where the link of a notification goes, which decides the words of the link in an email: "Open
// conversation" under a notification about a channel would be a false promise.
export const DigestLinkKinds = {
  CONVERSATION: 'conversation',
  CHANNELS: 'channels',
  TEAM: 'team',
  EXPORTS: 'exports',
  APP: 'app'
} as const
export type DigestLinkKind = (typeof DigestLinkKinds)[keyof typeof DigestLinkKinds]

// A function and not a table: a table of computed keys at the top of the module is kept by the
// bundler as code with effects and travels to every page of the web app through the barrel, even
// though only the worker and the email read it (it cost the inbox 0.8 KB of its budget).
function linkKindOfType(type: NotificationType): DigestLinkKind {
  switch (type) {
    case NotificationTypes.CONVERSATION_ASSIGNED:
    case NotificationTypes.CONVERSATION_MENTIONED:
    case NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE:
    case NotificationTypes.CONVERSATION_SNOOZE_EXPIRED:
    case NotificationTypes.CONVERSATION_REOPENED:
    case NotificationTypes.MESSAGE_RECEIVED:
    case NotificationTypes.MESSAGE_FAILED:
    case NotificationTypes.MEDIA_INFECTED:
    case NotificationTypes.MEDIA_UNSCANNABLE:
      return DigestLinkKinds.CONVERSATION
    case NotificationTypes.CHANNEL_DISCONNECTED:
      return DigestLinkKinds.CHANNELS
    case NotificationTypes.MEMBER_JOINED:
    case NotificationTypes.INVITATION_ACCEPTED:
      return DigestLinkKinds.TEAM
    case NotificationTypes.EXPORT_READY:
    case NotificationTypes.EXPORT_FAILED:
      return DigestLinkKinds.EXPORTS
    default:
      return DigestLinkKinds.APP
  }
}

// The kind of link of a notification, from its message key; a type with no entry opens the app
export function digestLinkKindOf(messageKey: string): DigestLinkKind {
  const type = (Object.values(NotificationTypes) as NotificationType[]).find(
    known => notificationMessageKey(known) === messageKey
  )
  return type === undefined ? DigestLinkKinds.APP : linkKindOfType(type)
}

export type BodyVariant = 'bodyRepeated' | 'bodyWithPeople' | 'bodyWithCustomer' | 'body'

// Which text of a notification to show. A notification that carries who and whose (a mention) says
// both, and one that carries only whose (the unassigned queue) names the customer, where the type has
// a text written for it; `count` above one asks for the text that says how many. A notification saved
// before the params, or a type without that text, keeps the plain `body`.
export function bodyVariantOf(
  params: Readonly<Record<string, unknown>>,
  count: number,
  hasVariant: (variant: Exclude<BodyVariant, 'body'>) => boolean
): BodyVariant {
  // A param that is not a text with something in it names nobody
  const hasCustomer = typeof params['customer'] === 'string' && params['customer'].trim() !== ''
  const named = 'author' in params && hasCustomer
  if (named && count > 1 && hasVariant('bodyRepeated')) return 'bodyRepeated'
  if (named && hasVariant('bodyWithPeople')) return 'bodyWithPeople'
  if (!('author' in params) && hasCustomer && hasVariant('bodyWithCustomer')) {
    return 'bodyWithCustomer'
  }
  return 'body'
}
