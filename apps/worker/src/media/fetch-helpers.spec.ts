import { keptContentType, sniffImageType } from './fetch-helpers'

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

describe('keptContentType', () => {
  it.each([
    ['a type the server declares', 'image/png', 'application/octet-stream', 'image/png'],
    [
      'the type of the webhook when the server does not know',
      'application/octet-stream',
      'image/jpeg',
      'image/jpeg'
    ],
    ['the type of the webhook when the server says nothing', '', 'audio/mp4', 'audio/mp4'],
    ['an m4a under its registered name', 'audio/x-m4a', 'application/octet-stream', 'audio/mp4'],
    ['an m4a that another alias names', 'audio/m4a', 'audio/mp4', 'audio/mp4'],
    [
      'a clip the server calls a video when the webhook said audio',
      'video/mp4',
      'audio/mp4',
      'audio/mp4'
    ],
    ['a real video', 'video/mp4', 'application/octet-stream', 'video/mp4'],
    ['a video whose webhook said video', 'video/mp4', 'video/mp4', 'video/mp4'],
    ['a raw aac', 'audio/aac', 'audio/mp4', 'audio/aac']
  ])('keeps %s', (_name, declared, webhook, kept) => {
    expect(keptContentType(declared, webhook)).toBe(kept)
  })

  it('does not turn a different type into audio because of the hint', () => {
    expect(keptContentType('application/pdf', 'audio/mp4')).toBe('application/pdf')
    expect(keptContentType('image/png', 'audio/mp4')).toBe('image/png')
  })
})
