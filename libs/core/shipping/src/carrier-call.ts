import { ShipmentLimits } from '@platform/core/domain'
import { CarrierUnavailableError } from '@platform/plugins/sdk'

import { mayRetryCreate } from './shipment-rules'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// A call to a carrier gives up after the deadline: the outcome is then unknown, as for a lost connection
export function withDeadline<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CarrierUnavailableError('the carrier did not answer in time')),
      ShipmentLimits.PROVIDER_TIMEOUT_MS
    )
    Promise.resolve()
      .then(run)
      .then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      )
  })
}

// Asks again with the same key while the carrier promises that is safe (TDD_17 §4.5 step 6); any other call is made once
export async function callCreate<T>(idempotent: boolean, run: () => Promise<T>): Promise<T> {
  let attempt = 1
  for (;;) {
    try {
      return await withDeadline(run)
    } catch (error) {
      // Any answer but "unavailable" to a repeated call is not "nothing was made": the first attempt may have made the guide,
      // and a carrier that keeps its promise only half would refuse the repeat as a duplicate or rate-limit it
      if (attempt > 1 && !(error instanceof CarrierUnavailableError)) {
        throw new CarrierUnavailableError(
          'the carrier answered a repeated call with an error: the first one may have made the guide'
        )
      }
      if (attempt >= ShipmentLimits.IDEMPOTENT_ATTEMPTS || !mayRetryCreate(error, idempotent)) {
        throw error
      }
      await wait(ShipmentLimits.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
      attempt += 1
    }
  }
}
