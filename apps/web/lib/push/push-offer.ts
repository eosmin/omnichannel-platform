export const PushOffer = {
  // Ask the person, once
  ASK: 'ask',
  // The browser already allows it: register it again for whoever is signed in, with no question
  SYNC: 'sync',
  NONE: 'none'
} as const
export type PushOfferType = (typeof PushOffer)[keyof typeof PushOffer]

// TDD_06 §7.3: never on first load; once, after the agent resolves a conversation. A browser that
// said no, or cannot do push, is left alone. A browser that said yes registers again silently,
// because another person may have used it since.
export function pushOfferFor(input: {
  permission: NotificationPermission | null
  alreadyOffered: boolean
}): PushOfferType {
  if (input.permission === 'granted') return PushOffer.SYNC
  if (input.permission === 'default' && !input.alreadyOffered) return PushOffer.ASK
  return PushOffer.NONE
}
