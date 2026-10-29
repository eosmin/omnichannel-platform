import { ChannelType } from '@platform/core/domain'

import { normalizeChannelIdentity } from './identity'

describe('normalizeChannelIdentity', () => {
  it('compares a WhatsApp number as digits with the country code', () => {
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '+503 7123-4567')).toBe('50371234567')
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '7123-4567')).toBe('50371234567')
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '12')).toBeNull()
  })

  it('accepts a handle of the longest size and refuses one a character longer', () => {
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, 'x'.repeat(255))).toBe('x'.repeat(255))
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, 'x'.repeat(256))).toBeNull()
  })

  it('keeps the page-scoped id of the other channels as it came', () => {
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, ' 17841400 ')).toBe('17841400')
    expect(normalizeChannelIdentity(ChannelType.WEB_WIDGET, '')).toBeNull()
  })
})
