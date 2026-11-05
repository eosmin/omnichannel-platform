import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'

import { PluginError } from './plugin-error'
import { pluginFailureLog } from './plugin-failure-log'

describe('pluginFailureLog', () => {
  it('gives the error name, the numeric codes of the provider and the check that failed', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      retryable: false,
      providerCode: 100,
      providerSubcode: 33,
      failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
    })

    expect(pluginFailureLog(error)).toEqual({
      errorName: 'PluginError',
      errorCode: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      providerCode: 100,
      providerSubcode: 33,
      failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED,
      reason: ChannelConnectFailureReasons.SUBSCRIPTION_NOT_CONFIRMED
    })
  })

  it('gives the reason of the closed list, and drops one that is not of it', () => {
    const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      reason: ChannelConnectFailureReasons.TOKEN_REJECTED
    })
    expect(pluginFailureLog(error).reason).toBe(ChannelConnectFailureReasons.TOKEN_REJECTED)
    const forged = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    Object.defineProperty(forged, 'reason', { value: 'Bearer secret' })
    expect(pluginFailureLog(forged)).not.toHaveProperty('reason')
  })

  it('leaves out what is not there', () => {
    expect(pluginFailureLog(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED))).toEqual({
      errorName: 'PluginError',
      errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
    })
  })

  it('gives only the name of an error that is not a plugin error, never its message', () => {
    expect(pluginFailureLog(new TypeError('Bearer secret'))).toEqual({ errorName: 'TypeError' })
    expect(pluginFailureLog('x')).toEqual({ errorName: 'unknown' })
  })

  it('drops a code that is not an integer and a check that is not one of ours (a plugin may be third-party)', () => {
    const forged = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    Object.assign(forged, {
      providerCode: 'Bearer secret',
      providerSubcode: 1.5,
      failedCheck: 'the token is EAAB-secret',
      code: 'Bearer EAAB-secret'
    })

    expect(pluginFailureLog(forged)).toEqual({ errorName: 'PluginError' })
  })

  it('drops a name that is not a class name: it is writable, so a plugin could put the token in it', () => {
    const forged = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    forged.name = 'Bearer EAAB-secret'
    const plain = new Error('x')
    plain.name = 'token EAAB-secret'

    expect(pluginFailureLog(forged).errorName).toBe('Error')
    expect(pluginFailureLog(plain)).toEqual({ errorName: 'Error' })
  })
})
