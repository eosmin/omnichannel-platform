import {
  DecryptionError,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  parseEncryptionKey
} from './aes-gcm'

const KEY = parseEncryptionKey('11'.repeat(32))
const OTHER_KEY = parseEncryptionKey('22'.repeat(32))

describe('aes-gcm', () => {
  it('round-trips text, including non-ASCII', () => {
    const text = '{"token":"abc","nombre":"Año ñandú 日本"}'
    expect(decrypt(encrypt(text, KEY), KEY)).toBe(text)
  })

  it('round-trips the empty string', () => {
    expect(decrypt(encrypt('', KEY), KEY)).toBe('')
  })

  it('never produces the same bytes twice for the same input', () => {
    expect(encrypt('same', KEY).equals(encrypt('same', KEY))).toBe(false)
  })

  it('does not contain the plaintext', () => {
    expect(encrypt('super-secret-value', KEY).toString('utf8')).not.toContain('super-secret-value')
  })

  it('starts with the format version', () => {
    expect(encrypt('x', KEY)[0]).toBe(1)
  })

  it('refuses another key', () => {
    expect(() => decrypt(encrypt('x', KEY), OTHER_KEY)).toThrow(DecryptionError)
  })

  it('refuses altered data in the body, the IV and the tag', () => {
    const original = encrypt('hello world', KEY)
    for (const index of [1, 13, original.length - 1]) {
      const altered = Buffer.from(original)
      altered[index] = (altered[index] ?? 0) ^ 0xff
      expect(() => decrypt(altered, KEY)).toThrow(DecryptionError)
    }
  })

  it('refuses a payload that is too short or has an unknown version', () => {
    expect(() => decrypt(Buffer.alloc(10), KEY)).toThrow('payload too short')
    const unknown = encrypt('x', KEY)
    unknown[0] = 9
    expect(() => decrypt(unknown, KEY)).toThrow('unknown format version')
  })

  it('accepts a plain Uint8Array, as Prisma returns Bytes', () => {
    expect(decrypt(new Uint8Array(encrypt('x', KEY)), KEY)).toBe('x')
  })

  it('parses only a 64 character hex key', () => {
    expect(parseEncryptionKey('ab'.repeat(32))).toHaveLength(32)
    expect(() => parseEncryptionKey('abc')).toThrow('64 hex characters')
    expect(() => parseEncryptionKey('zz'.repeat(32))).toThrow('64 hex characters')
  })

  it('rejects a key of the wrong size', () => {
    expect(() => encrypt('x', Buffer.alloc(16))).toThrow('32 bytes')
    expect(() => decrypt(Buffer.alloc(40), Buffer.alloc(16))).toThrow('32 bytes')
  })

  it('round-trips a JSON value', () => {
    const credentials = { accessToken: 'tok', nested: { ids: [1, 2] } }
    expect(decryptJson(encryptJson(credentials, KEY), KEY)).toEqual(credentials)
  })
})
