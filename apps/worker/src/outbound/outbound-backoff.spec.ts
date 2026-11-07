import { OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { outboundBackoff } from './outbound-backoff'
import { SendAttemptFailed } from './send-refusal'

describe('outboundBackoff', () => {
  it('doubles from 5 seconds after an ordinary failure', () => {
    const error = new SendAttemptFailed(ErrorCodes.CHANNEL_MESSAGE_FAILED, new Error('x'))
    expect([1, 2, 3, 4].map(n => outboundBackoff(n, 'outbound', error))).toEqual([
      5000, 10_000, 20_000, 40_000
    ])
  })

  it('doubles from 15 seconds after a throttle, and the receipt of the last attempt still finds its message', () => {
    const error = new SendAttemptFailed(
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      new Error('x'),
      'a reaction'
    )
    const waits = [1, 2, 3, 4].map(n => outboundBackoff(n, 'outbound', error))
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000])
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(OutboundLimits.RECEIPT_WAIT_MS)
  })

  it('treats an error that is not ours as an ordinary failure', () => {
    expect(outboundBackoff(1, 'outbound', new Error('x'))).toBe(5000)
    expect(outboundBackoff(1, 'outbound')).toBe(5000)
  })
})
