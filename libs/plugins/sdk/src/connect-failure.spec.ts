import { ChannelConnectFailureReasons, ErrorCodes } from '@platform/core/errors'

import { connectFailureReasonOf } from './connect-failure'
import { PluginError } from './plugin-error'

describe('connectFailureReasonOf', () => {
  it('is the reason of a failure of a plugin', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      reason: ChannelConnectFailureReasons.PERMISSION_MISSING
    })
    expect(connectFailureReasonOf(error)).toBe(ChannelConnectFailureReasons.PERMISSION_MISSING)
  })

  it.each([
    ['an error that is not of a plugin', new Error('Bearer secret')],
    ['a text', 'token_rejected'],
    ['nothing', undefined],
    ['a plugin error with no reason', new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)]
  ])('is nothing for %s', (_name, error) => {
    expect(connectFailureReasonOf(error)).toBeUndefined()
  })

  it('is nothing for a reason that is not of the list: a plugin of a third party cannot write on the screen', () => {
    const forged = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    Object.defineProperty(forged, 'reason', { value: 'your account is hacked, call 555' })
    expect(connectFailureReasonOf(forged)).toBeUndefined()
  })
})
