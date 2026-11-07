import { DeliveryStatus } from '@platform/core/domain'

export type ReactionState = 'pending' | 'failed'

// Where a reaction of the team stands toward the channel. Waiting is not a problem: it is the normal
// moment between the click and the answer of the channel, and drawing it as a warning made every
// reaction flash a triangle on a healthy network. Only a refusal is a failure.
export function reactionStateOf(reaction: { deliveryStatus: string | null }): ReactionState | null {
  if (reaction.deliveryStatus === String(DeliveryStatus.QUEUED)) return 'pending'
  if (reaction.deliveryStatus === String(DeliveryStatus.FAILED)) return 'failed'
  return null
}

// What the chip of an emoji shows: a failure wins over waiting, and waiting gets a clock, not a warning
export function groupStateOf(
  reactions: readonly { deliveryStatus: string | null }[]
): ReactionState | null {
  const states = reactions.map(reactionStateOf)
  if (states.includes('failed')) return 'failed'
  return states.includes('pending') ? 'pending' : null
}
