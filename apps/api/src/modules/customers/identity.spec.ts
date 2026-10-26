import { ChannelType } from '@platform/core/domain'

import { normalizeChannelIdentity } from './identity'

describe('normalizeChannelIdentity', () => {
  it('compares a WhatsApp number as digits with the country code', () => {
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '+503 7123-4567')).toBe('50371234567')
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '7123-4567')).toBe('50371234567')
    expect(normalizeChannelIdentity(ChannelType.WHATSAPP, '12')).toBeNull()
  })

  // A valid address of exactly the given length: a local part of 64, then labels of up to 63
  function addressOfLength(length: number): string {
    const rest = length - 64 - 1 // what the domain has: labels joined by dots, ending in .com
    const labels: string[] = []
    let left = rest - '.com'.length
    while (left > 0) {
      const label = Math.min(63, left - (left > 63 ? 1 : 0))
      labels.push('b'.repeat(label))
      left -= label + 1
    }
    return `${'a'.repeat(64)}@${labels.join('.')}.com`
  }

  it('accepts a handle of the longest size and refuses one a character longer', () => {
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, 'x'.repeat(255))).toBe('x'.repeat(255))
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, 'x'.repeat(256))).toBeNull()
  })

  it('accepts an e-mail handle of 254 characters and refuses one of 255', () => {
    expect(addressOfLength(254)).toHaveLength(254)
    expect(addressOfLength(255)).toHaveLength(255)
    expect(normalizeChannelIdentity(ChannelType.EMAIL, addressOfLength(254))).toBe(
      addressOfLength(254)
    )
    expect(normalizeChannelIdentity(ChannelType.EMAIL, addressOfLength(255))).toBeNull()
  })

  it('compares an e-mail address in lower case', () => {
    expect(normalizeChannelIdentity(ChannelType.EMAIL, ' Ana@Example.COM ')).toBe('ana@example.com')
    expect(normalizeChannelIdentity(ChannelType.EMAIL, 'not an address')).toBeNull()
  })

  it('keeps the page-scoped id of the other channels as it came', () => {
    expect(normalizeChannelIdentity(ChannelType.INSTAGRAM, ' 17841400 ')).toBe('17841400')
    expect(normalizeChannelIdentity(ChannelType.WEB_WIDGET, '')).toBeNull()
  })
})
