import { ChannelHealthErrors, ChannelHealthLimits } from '@platform/core/domain'

import { storedHealthReason } from './stored-health-reason'

describe('storedHealthReason', () => {
  it('keeps no reason as no reason, and a code of the closed list as it is', () => {
    expect(storedHealthReason(null)).toBeNull()
    expect(storedHealthReason(ChannelHealthErrors.TOKEN_REJECTED)).toBe(
      ChannelHealthErrors.TOKEN_REJECTED
    )
  })

  it('cleans what an earlier version stored: tags, credentials and size', () => {
    expect(storedHealthReason('<b>expired</b> access_token=abc123')).toBe(
      'expired access_token=[redacted]'
    )
    expect(storedHealthReason('x'.repeat(5000))).toHaveLength(ChannelHealthLimits.ERROR_MAX_LENGTH)
  })

  it('falls back to unspecified when nothing is left', () => {
    expect(storedHealthReason('<b></b>')).toBe(ChannelHealthErrors.UNSPECIFIED)
    expect(storedHealthReason('\u200b\u200b')).toBe(ChannelHealthErrors.UNSPECIFIED)
  })
})
