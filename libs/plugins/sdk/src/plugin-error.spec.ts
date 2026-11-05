import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'

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

  describe('the reason a connection failed', () => {
    it('is the one the plugin gives', () => {
      const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        reason: ChannelConnectFailureReasons.TOKEN_REJECTED
      })
      expect(error.reason).toBe(ChannelConnectFailureReasons.TOKEN_REJECTED)
    })

    it('comes from the local check that refused, when the plugin names no reason', () => {
      const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH
      })
      expect(error.reason).toBe(ChannelConnectFailureReasons.OTHER_ACCOUNT)
    })

    it('is the one the plugin gives even when a check names another', () => {
      const error = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH,
        reason: ChannelConnectFailureReasons.PERMISSION_MISSING
      })
      expect(error.reason).toBe(ChannelConnectFailureReasons.PERMISSION_MISSING)
    })

    it("does not throw for a check name that is not of the list, nor put it in a message: a plugin can be a third party's", () => {
      const made = (): PluginError =>
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
          failedCheck: 'x-Bearer-SECRET' as never,
          retryable: false
        })
      expect(made).not.toThrow()
      expect(made().reason).toBeUndefined()
      expect(made().code).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(made().message).not.toContain('SECRET')
    })

    it('is none when nothing says it', () => {
      expect(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID).reason).toBeUndefined()
    })
  })
})
