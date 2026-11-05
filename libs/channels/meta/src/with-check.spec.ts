import { ErrorCodes, PluginChecks } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { withCheck } from './with-check'

describe('withCheck', () => {
  it('names the check and keeps what the failure came with', () => {
    const original = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
      retryable: true,
      outcomeUnknown: true,
      providerCode: 4,
      providerSubcode: 2
    })
    expect(withCheck(original, PluginChecks.SUBSCRIPTION_READ_FAILED)).toMatchObject({
      code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
      retryable: true,
      outcomeUnknown: true,
      providerCode: 4,
      providerSubcode: 2,
      failedCheck: PluginChecks.SUBSCRIPTION_READ_FAILED
    })
  })

  it('keeps a check the failure already carried: it is the more exact cause', () => {
    const original = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      retryable: false,
      failedCheck: PluginChecks.TOKEN_NOT_HEADER_SAFE
    })
    expect(withCheck(original, PluginChecks.SUBSCRIPTION_APP_UNKNOWN)).toMatchObject({
      failedCheck: PluginChecks.TOKEN_NOT_HEADER_SAFE
    })
  })

  it('leaves an error that is not a plugin error as it is', () => {
    const original = new Error('boom')
    expect(withCheck(original, PluginChecks.SUBSCRIPTION_READ_FAILED)).toBe(original)
  })

  it('leaves retryable unset when the failure said nothing about it', () => {
    const original = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(
      (withCheck(original, PluginChecks.SUBSCRIPTION_READ_FAILED) as PluginError).retryable
    ).toBeUndefined()
  })

  it('adds nothing the failure did not have', () => {
    const named = withCheck(
      new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }),
      PluginChecks.SUBSCRIPTION_READ_FAILED
    ) as PluginError
    expect(named.retryable).toBe(false)
    expect(named.outcomeUnknown).toBe(false)
    expect(named.providerCode).toBeUndefined()
    expect(named.providerSubcode).toBeUndefined()
  })
})
