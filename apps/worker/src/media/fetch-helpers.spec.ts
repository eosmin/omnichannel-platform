import { sniffImageType } from './fetch-helpers'

describe('sniffImageType', () => {
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['image/webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]]
  ])('reads %s from its first bytes', (type, bytes) => {
    expect(sniffImageType(Buffer.from(bytes))).toBe(type)
  })

  it.each([
    ['text', Buffer.from('<html>')],
    ['a RIFF that is not webp', Buffer.from('RIFF0000WAVE')],
    ['nothing', Buffer.alloc(0)]
  ])('reads none from %s', (_name, body) => {
    expect(sniffImageType(body)).toBeNull()
  })
})
