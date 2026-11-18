import { ChannelHealthErrors, ChannelHealthLimits } from '@platform/core/domain'

import { pluginHealthReason, storedHealthReason } from './stored-health-reason'

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

describe('pluginHealthReason', () => {
  it('keeps the words of a plugin, cleaned', () => {
    expect(pluginHealthReason('<b>expired</b>')).toBe('expired')
  })

  it('never lets a plugin pass for one of our codes: the exact name is kept in brackets', () => {
    for (const code of Object.values(ChannelHealthErrors)) {
      expect(pluginHealthReason(code)).toBe(`[${code}]`)
      expect(pluginHealthReason(code)).not.toBe(code)
    }
  })

  it('says unspecified when nothing is left', () => {
    expect(pluginHealthReason('\u200b')).toBe(ChannelHealthErrors.UNSPECIFIED)
  })
})
