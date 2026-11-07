import { FILE_SIGNATURE_WINDOW_BYTES, matchesDeclaredType, SIGNATURE_TYPES } from './file-signature'
import { AllAllowedContentTypes } from './upload-constants'

const bytes = (...values: (number | string)[]): Buffer =>
  Buffer.concat(
    values.map(value =>
      typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value, 'latin1')
    )
  )
const pad = (head: Buffer): Buffer => Buffer.concat([head, Buffer.alloc(32)])

const JPEG = pad(bytes(0xff, 0xd8, 0xff, 0xe0))
const PNG = pad(bytes(0x89, 'PNG\r\n', 0x1a, '\n'))
const GIF = pad(bytes('GIF89a'))
const WEBP = pad(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))
const WAV = pad(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))
const MP4 = pad(bytes(0, 0, 0, 0x18, 'ftypmp42'))
const MOV = pad(bytes(0, 0, 0, 0x14, 'ftypqt  '))
const M4A = pad(bytes(0, 0, 0, 0x20, 'ftypM4A '))
const AAC_ADTS = pad(bytes(0xff, 0xf1, 0x50))
const MP3_ID3 = pad(bytes('ID3', 3, 0))
const MP3_FRAME = pad(bytes(0xff, 0xfb, 0x90))
const OGG = pad(bytes('OggS', 0))
const PDF = pad(bytes('%PDF-1.7\n'))
const ZIP = pad(bytes('PK', 3, 4))
const TEXT = Buffer.from('hello, a plain text file\n', 'utf8')
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8')

describe('matchesDeclaredType', () => {
  it.each([
    ['image/jpeg', JPEG],
    ['image/png', PNG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['video/mp4', MP4],
    ['video/quicktime', MOV],
    ['audio/mpeg', MP3_ID3],
    ['audio/mpeg', MP3_FRAME],
    ['audio/ogg', OGG],
    ['audio/wav', WAV],
    ['audio/mp4', M4A],
    ['audio/mp4', MP4],
    ['audio/aac', AAC_ADTS],
    ['application/pdf', PDF],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
    ['text/plain', TEXT]
  ])('accepts a real %s', (type, body) => {
    expect(matchesDeclaredType(type, body)).toBe(true)
  })

  it('has a rule for every type an upload may declare', () => {
    expect([...AllAllowedContentTypes].filter(type => !SIGNATURE_TYPES.includes(type))).toEqual([])
  })

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])(
    'refuses an HTML page declared as %s (a fake.png)',
    type => {
      expect(matchesDeclaredType(type, HTML)).toBe(false)
    }
  )

  it.each([
    ['image/png', JPEG],
    ['image/jpeg', PNG],
    ['image/webp', WAV],
    ['audio/wav', WEBP],
    ['video/mp4', PDF],
    ['application/pdf', ZIP],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', PDF],
    ['audio/mpeg', HTML],
    ['audio/mp4', HTML],
    ['audio/mp4', MP3_ID3],
    ['audio/aac', HTML],
    ['audio/aac', MP3_FRAME],
    ['audio/aac', M4A]
  ])('refuses the bytes of another type declared as %s', (type, body) => {
    expect(matchesDeclaredType(type, body)).toBe(false)
  })

  it('refuses an empty file and a head that stops inside the signature', () => {
    expect(matchesDeclaredType('image/png', Buffer.alloc(0))).toBe(false)
    expect(matchesDeclaredType('image/png', bytes(0x89, 'PNG'))).toBe(false)
    expect(matchesDeclaredType('text/plain', Buffer.alloc(0))).toBe(false)
  })

  it('refuses a text file with a NUL byte, which is a binary one', () => {
    expect(matchesDeclaredType('text/plain', Buffer.from([0x61, 0x00, 0x62]))).toBe(false)
  })

  it('accepts a text in UTF-16 with its byte order mark', () => {
    expect(matchesDeclaredType('text/plain', Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(true)
    expect(matchesDeclaredType('text/plain', Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe(true)
  })

  it('does not take a name of Object.prototype for a type with a rule', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(matchesDeclaredType(name, Buffer.from('x'))).toBe(false)
    }
  })

  it('refuses a type it has no rule for', () => {
    expect(matchesDeclaredType('text/html', HTML)).toBe(false)
    expect(matchesDeclaredType('image/svg+xml', Buffer.from('<svg/>'))).toBe(false)
  })

  it('reads a window of a size the bucket can be asked for', () => {
    expect(FILE_SIGNATURE_WINDOW_BYTES).toBeGreaterThanOrEqual(1024)
  })
})
