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
