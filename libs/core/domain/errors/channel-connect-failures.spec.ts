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
    expect(connectReasonOfCheck(PluginChecks.CREDENTIALS_SHAPE)).toBe(
      ChannelConnectFailureReasons.TOKEN_MISSING
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
})
