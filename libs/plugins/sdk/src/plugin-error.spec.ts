import { ErrorCodes } from '@platform/core/errors'

import { PluginError } from './plugin-error'

describe('PluginError', () => {
  it('says the code and nothing the provider said, because the message reaches the client and the logs', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    expect(error.code).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    expect(error.message).toBe('channel plugin failed: CHANNEL_CREDENTIALS_INVALID')
    expect(error.metadata).toBeUndefined()
  })
})
