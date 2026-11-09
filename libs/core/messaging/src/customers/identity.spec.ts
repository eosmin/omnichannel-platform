import { ChannelIdentityKinds } from '@platform/core/domain'

import { normalizeChannelIdentity } from './identity'

describe('normalizeChannelIdentity', () => {
  it('compares a WhatsApp number as digits with the country code', () => {
    expect(normalizeChannelIdentity(ChannelIdentityKinds.PHONE, '+503 7123-4567')).toBe(
      '50371234567'
    )
    expect(normalizeChannelIdentity(ChannelIdentityKinds.PHONE, '7123-4567')).toBe('50371234567')
    expect(normalizeChannelIdentity(ChannelIdentityKinds.PHONE, '12')).toBeNull()
  })

  it('accepts a handle of the longest size and refuses one a character longer', () => {
    expect(normalizeChannelIdentity(ChannelIdentityKinds.OPAQUE, 'x'.repeat(255))).toBe(
      'x'.repeat(255)
    )
    expect(normalizeChannelIdentity(ChannelIdentityKinds.OPAQUE, 'x'.repeat(256))).toBeNull()
  })

  it('keeps the page-scoped id of the other channels as it came', () => {
    expect(normalizeChannelIdentity(ChannelIdentityKinds.OPAQUE, ' 17841400 ')).toBe('17841400')
    expect(normalizeChannelIdentity(ChannelIdentityKinds.OPAQUE, '')).toBeNull()
  })
})
