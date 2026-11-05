import {
  ChannelConnectFailureReasons,
  connectReasonOfCheck,
  isChannelConnectFailureReason
} from './channel-connect-failures'
import { PluginChecks } from './plugin-checks'

describe('the reasons a channel does not connect', () => {
  it('gives every local check of a plugin a reason of the list (a new check cannot be left without one)', () => {
    for (const check of Object.values(PluginChecks)) {
      expect(isChannelConnectFailureReason(connectReasonOfCheck(check))).toBe(true)
    }
  })

  it('says which reason each check has, so a change of wording of the owner is a change of code', () => {
    // Empty, too long or not text: the form blocks an empty one, so what reaches the check is "not a token"
    expect(connectReasonOfCheck(PluginChecks.CREDENTIALS_SHAPE)).toBe(
      ChannelConnectFailureReasons.TOKEN_MALFORMED
    )
    expect(connectReasonOfCheck(PluginChecks.TOKEN_NOT_HEADER_SAFE)).toBe(
      ChannelConnectFailureReasons.TOKEN_MALFORMED
    )
    expect(connectReasonOfCheck(PluginChecks.ACCOUNT_ID_MISMATCH)).toBe(
      ChannelConnectFailureReasons.OTHER_ACCOUNT
    )
    expect(connectReasonOfCheck(PluginChecks.ACCOUNT_NOT_FOUND)).toBe(
      ChannelConnectFailureReasons.ACCOUNT_NOT_LINKED
    )
    expect(connectReasonOfCheck(PluginChecks.SUBSCRIPTION_NOT_CONFIRMED)).toBe(
      ChannelConnectFailureReasons.SUBSCRIPTION_NOT_CONFIRMED
    )
  })

  it("says an answer of Meta that is not shaped as documented is Meta's oddity, not a wrong token", () => {
    for (const check of [PluginChecks.ACCOUNT_ID_NOT_NUMERIC, PluginChecks.ACCOUNT_SHAPE_INVALID]) {
      expect(connectReasonOfCheck(check)).toBe(
        ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
      )
    }
  })

  it('gives the checks of the Page the reasons the owner can act on', () => {
    expect(connectReasonOfCheck(PluginChecks.PAGE_ID_MISMATCH)).toBe(
      ChannelConnectFailureReasons.OTHER_ACCOUNT
    )
    expect(connectReasonOfCheck(PluginChecks.PAGE_ID_NOT_NUMERIC)).toBe(
      ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
    )
    for (const check of [
      PluginChecks.SUBSCRIPTION_READ_FAILED,
      PluginChecks.SUBSCRIPTION_SHAPE_INVALID,
      PluginChecks.SUBSCRIPTION_APP_UNKNOWN
    ]) {
      expect(connectReasonOfCheck(check)).toBe(ChannelConnectFailureReasons.SUBSCRIPTION_UNREADABLE)
    }
  })

  it('has names made of lowercase letters and underscores, each once', () => {
    const names = Object.values(ChannelConnectFailureReasons)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z_]*$/)
  })

  it.each([
    ['token_rejected', true],
    ['Bearer abc', false],
    ['', false],
    [undefined, false],
    [7, false]
  ])('believes %p only when it is a name of the list (%p)', (value, expected) => {
    expect(isChannelConnectFailureReason(value)).toBe(expected)
  })

  it('does not put a check it does not know in the message of its error', () => {
    expect(() => connectReasonOfCheck('Bearer-SECRET' as never)).toThrow(
      'a plugin check has no reason'
    )
    try {
      connectReasonOfCheck('Bearer-SECRET' as never)
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET')
    }
  })
})
