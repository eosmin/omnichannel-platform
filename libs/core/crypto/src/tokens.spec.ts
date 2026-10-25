import { generateToken, hashToken } from './tokens'

describe('generateToken', () => {
  it('has 256 bits by default, written in a URL-safe alphabet', () => {
    const token = generateToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes in base64url, no padding
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()))
    expect(tokens.size).toBe(1000)
  })

  it('takes the size in bytes', () => {
    expect(Buffer.from(generateToken(16), 'base64url')).toHaveLength(16)
  })
})

describe('hashToken', () => {
  it('is the SHA-256 of the token in hex, the same every time', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })

  it('differs for another token and does not contain the token', () => {
    const token = generateToken()
    expect(hashToken(token)).not.toBe(hashToken(`${token}x`))
    expect(hashToken(token)).not.toContain(token)
  })
})
