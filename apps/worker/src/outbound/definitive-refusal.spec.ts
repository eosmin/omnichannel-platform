import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { isDefinitiveRefusal } from './definitive-refusal'

describe('isDefinitiveRefusal', () => {
  it('is true for a provider that answered that it refused, and for a check of the plugin before sending', () => {
    expect(
      isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { refused: true }))
    ).toBe(true)
    expect(isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_FILE_TOO_LARGE))).toBe(true)
    expect(isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED))).toBe(
      true
    )
  })

  it('is false for a plugin that says nothing, whatever its code, and for any error that is not a plugin’s', () => {
    expect(isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED))).toBe(false)
    expect(isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))).toBe(false)
    expect(
      isDefinitiveRefusal(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
    ).toBe(false)
    expect(isDefinitiveRefusal(new Error('socket hang up'))).toBe(false)
    expect(isDefinitiveRefusal(undefined)).toBe(false)
  })

  it('is false when the outcome is unknown, even for one that claims a refusal or a local code', () => {
    expect(
      isDefinitiveRefusal(
        new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { refused: true, outcomeUnknown: true })
      )
    ).toBe(false)
    expect(
      isDefinitiveRefusal(
        new PluginError(ErrorCodes.CHANNEL_FILE_TOO_LARGE, { outcomeUnknown: true })
      )
    ).toBe(false)
  })
})
