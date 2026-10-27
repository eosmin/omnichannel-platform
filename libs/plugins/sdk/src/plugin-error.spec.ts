import { ErrorCodes } from '@platform/core/errors'

import { PluginError } from './plugin-error'

describe('PluginError', () => {
  it('says the code and nothing the provider said, because the message reaches the client and the logs', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    expect(error.code).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    expect(error.message).toBe('channel plugin failed: CHANNEL_CREDENTIALS_INVALID')
    expect(error.metadata).toBeUndefined()
  })

  it('carries what the plugin says about trying again, and nothing when it says nothing', () => {
    expect(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED).retryable).toBeUndefined()
    expect(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true }).retryable).toBe(
      true
    )
  })
})
