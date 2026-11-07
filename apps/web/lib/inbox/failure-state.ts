import { DeliveryStatus } from '@platform/core/domain'

// How a reply that failed stands, from what the api knows of it (`failureDefinitive`):
// - `definitive`: it is known not to have gone out (the channel refused it, or it never left). It can be sent
//   again or discarded, and it is drawn as a failure.
// - `unconfirmed`: it may have reached the customer (a timeout, an answer that never came). It can only be
//   sent again, with the warning that the customer may receive it twice, and it is drawn as "could not
//   confirm", not as a refusal.
// A view from an api that does not say (`undefined`) is treated as unconfirmed: the safe reading.
export type FailureState = 'definitive' | 'unconfirmed'

export function failureStateOf(message: {
  deliveryStatus: string | null
  failureDefinitive?: boolean | null | undefined
}): FailureState | null {
  if (message.deliveryStatus !== String(DeliveryStatus.FAILED)) return null
  return message.failureDefinitive === true ? 'definitive' : 'unconfirmed'
}

export interface FailureNote {
  // `reason`: why the channel said it failed (its code, drawn as a sentence); `failed`: that it failed, when
  // no reason is known; `unconfirmed`: that it could not be confirmed whether the customer received it
  kind: 'reason' | 'failed' | 'unconfirmed'
  tone: 'red' | 'amber'
}

// What is said under a failed reply. The reason is ALWAYS said when the channel gave one, in either state
// (a reply that "could not be confirmed" still failed for a reason the agent needs to read: "WhatsApp does
// not accept this type of file"); the amber state adds that delivery could not be confirmed.
export function failureNotesOf(message: {
  deliveryStatus: string | null
  deliveryError: string | null
  failureDefinitive?: boolean | null | undefined
}): FailureNote[] {
  const state = failureStateOf(message)
  if (state === null) return []
  const reason: FailureNote = {
    kind: message.deliveryError === null ? 'failed' : 'reason',
    tone: state === 'definitive' ? 'red' : 'amber'
  }
  if (state === 'definitive') return [reason]
  // Without a reason, "it failed" would only repeat the amber note below it
  return message.deliveryError === null
    ? [{ kind: 'unconfirmed', tone: 'amber' }]
    : [reason, { kind: 'unconfirmed', tone: 'amber' }]
}
