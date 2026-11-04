import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { providerCodesOf } from './provider-codes'

describe('providerCodesOf', () => {
  it('gives the numeric code and subcode a plugin kept from the provider, for the log', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
      retryable: false,
      providerCode: 131053,
      providerSubcode: 2494073
    })

    expect(providerCodesOf(error)).toEqual({ providerCode: 131053, providerSubcode: 2494073 })
  })

  it('leaves out what is not there, and gives nothing for an error that is not a plugin error', () => {
    expect(providerCodesOf(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED))).toEqual({})
    expect(providerCodesOf(new Error('Bearer secret'))).toEqual({})
    expect(providerCodesOf('x')).toEqual({})
  })
})
