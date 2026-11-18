import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { isRepeatableSend } from './send-refusal'

const failed = ErrorCodes.CHANNEL_MESSAGE_FAILED

describe('isRepeatableSend', () => {
  it('repeats a retryable failure whose outcome is known (a throttle)', () => {
    expect(isRepeatableSend(new PluginError(failed, { retryable: true, refused: true }))).toBe(true)
  })

  it('does not repeat a doubt when nothing deduplicates the send', () => {
    expect(
      isRepeatableSend(new PluginError(failed, { retryable: true, outcomeUnknown: true }))
    ).toBe(false)
  })

  it('repeats a doubt when the send carried a key the other side deduplicates', () => {
    expect(
      isRepeatableSend(
        new PluginError(failed, { retryable: true, outcomeUnknown: true, idempotent: true })
      )
    ).toBe(true)
  })

  it('never repeats what the plugin says will not change, key or not', () => {
    expect(
      isRepeatableSend(
        new PluginError(failed, { retryable: false, outcomeUnknown: true, idempotent: true })
      )
    ).toBe(false)
    expect(isRepeatableSend(new PluginError(failed))).toBe(false)
    expect(
      isRepeatableSend(new PluginError(failed, { outcomeUnknown: true, idempotent: true }))
    ).toBe(false)
  })

  it('does not repeat an error that is not the plugin’s', () => {
    expect(isRepeatableSend(new Error('timeout'))).toBe(false)
  })
})
