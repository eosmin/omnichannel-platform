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

const LinkKindOfType: Partial<Record<NotificationType, DigestLinkKind>> = {
  [NotificationTypes.CONVERSATION_ASSIGNED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.CONVERSATION_MENTIONED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.CONVERSATION_SNOOZE_EXPIRED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.CONVERSATION_REOPENED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.MESSAGE_RECEIVED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.MESSAGE_FAILED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.MEDIA_INFECTED]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.MEDIA_UNSCANNABLE]: DigestLinkKinds.CONVERSATION,
  [NotificationTypes.CHANNEL_DISCONNECTED]: DigestLinkKinds.CHANNELS,
  [NotificationTypes.MEMBER_JOINED]: DigestLinkKinds.TEAM,
  [NotificationTypes.INVITATION_ACCEPTED]: DigestLinkKinds.TEAM,
  [NotificationTypes.EXPORT_READY]: DigestLinkKinds.EXPORTS,
  [NotificationTypes.EXPORT_FAILED]: DigestLinkKinds.EXPORTS
}

// The kind of link of a notification, from its message key; a type with no entry opens the app
export function digestLinkKindOf(messageKey: string): DigestLinkKind {
  const type = (Object.values(NotificationTypes) as NotificationType[]).find(
    known => notificationMessageKey(known) === messageKey
  )
  return (type === undefined ? undefined : LinkKindOfType[type]) ?? DigestLinkKinds.APP
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
