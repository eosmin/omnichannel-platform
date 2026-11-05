import { ChannelHealthErrors, healthErrorOfReason } from '@platform/core/domain'
import { ChannelConnectFailureReasons } from '@platform/core/errors'

import { needsNewToken } from './health-reconnect'

// One line for every health error: a new one has to be placed here (the test below fails until it is)
const EXPECTED: Record<string, boolean> = {
  [ChannelHealthErrors.CHECK_FAILED]: false,
  [ChannelHealthErrors.CREDENTIALS_UNREADABLE]: true,
  [ChannelHealthErrors.INVALID_REPORT]: false,
  [ChannelHealthErrors.UNSPECIFIED]: false,
  [ChannelHealthErrors.TOKEN_REJECTED]: true,
  [ChannelHealthErrors.PERMISSION_MISSING]: true,
  [ChannelHealthErrors.OTHER_ACCOUNT]: true,
  [ChannelHealthErrors.ACCOUNT_NOT_LINKED]: true,
  [ChannelHealthErrors.REQUEST_REJECTED]: true
}

describe('needsNewToken', () => {
  it('has an answer written down for every health error', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(ChannelHealthErrors).sort())
  })

  it.each(Object.entries(EXPECTED))('says %s: %s', (error, expected) => {
    expect(needsNewToken(error)).toBe(expected)
  })

  it('says no for text of the provider that is not one of the names', () => {
    expect(needsNewToken('Your account is suspended')).toBe(false)
  })

  it('offers the button exactly for the failures the health check keeps as a verdict', () => {
    for (const reason of Object.values(ChannelConnectFailureReasons)) {
      const kept = healthErrorOfReason(reason)
      expect(needsNewToken(kept)).toBe(kept !== ChannelHealthErrors.CHECK_FAILED)
    }
  })
})
