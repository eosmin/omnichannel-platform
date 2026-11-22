import {
  consentHashKeyIdOf,
  consentHashKeyNameOf,
  consentHashKeyOf,
  hashClientAddress
} from './consent-hash'

const JWT_SECRET = 'j'.repeat(32)
const OWN_KEY = 'k'.repeat(40)

describe('consentHashKeyOf', () => {
  it('uses the own key when there is one, and names it', () => {
    expect(consentHashKeyOf({ jwtSecret: JWT_SECRET, consentHashKey: OWN_KEY })).toEqual({
      key: OWN_KEY,
      id: consentHashKeyNameOf(OWN_KEY)
    })
  })

  it('derives a key from the signing secret, with no id, when there is none (a laptop, a test run)', () => {
    const derived = consentHashKeyOf({
      jwtSecret: JWT_SECRET,
      consentHashKey: undefined
    })
    expect(derived.id).toBeNull()
    expect(derived.key).toMatch(/^[0-9a-f]{64}$/)
    // Never the signing secret itself, and not the same for another secret
    expect(derived.key).not.toBe(JWT_SECRET)
    expect(
      consentHashKeyOf({
        jwtSecret: 'x'.repeat(32),
        consentHashKey: undefined
      }).key
    ).not.toBe(derived.key)
  })

  it('keeps the derivation that rows written before the own key were made with', () => {
    // A fixed vector: HMAC-SHA256(JWT_SECRET, 'cookie-consent-ip-hash-key:v1'). If this changes, every old hash stops being checkable
    expect(consentHashKeyOf({ jwtSecret: JWT_SECRET, consentHashKey: undefined }).key).toBe(
      '0d1c2e00a6dbd2ee02b040f6d7c89c4af0b8af12f775029fe9c452620554229b'
    )
  })
})

describe('consentHashKeyNameOf', () => {
  it('names a key by the key, so a rotation cannot keep the old name', () => {
    expect(consentHashKeyNameOf(OWN_KEY)).toMatch(/^k[0-9a-f]{8}$/)
    expect(consentHashKeyNameOf(OWN_KEY)).toBe(consentHashKeyNameOf(OWN_KEY))
    expect(consentHashKeyNameOf('z'.repeat(40))).not.toBe(consentHashKeyNameOf(OWN_KEY))
    expect(consentHashKeyNameOf(OWN_KEY)).not.toContain(OWN_KEY.slice(0, 8))
  })
})

describe('hashClientAddress', () => {
  it('writes bare hex for the derived key and `<id>:<hex>` for an own key', () => {
    const derived = { key: 'a'.repeat(64), id: null }
    const own = { key: OWN_KEY, id: 'kab12cd34' }
    expect(hashClientAddress('203.0.113.7', derived)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashClientAddress('203.0.113.7', own)).toMatch(/^kab12cd34:[0-9a-f]{64}$/)
  })

  it('is the same for the same address and key, and differs by address and by key', () => {
    const own = { key: OWN_KEY, id: 'kab12cd34' }
    expect(hashClientAddress('203.0.113.7', own)).toBe(hashClientAddress('203.0.113.7', own))
    expect(hashClientAddress('203.0.113.8', own)).not.toBe(hashClientAddress('203.0.113.7', own))
    expect(hashClientAddress('203.0.113.7', { key: 'z'.repeat(40), id: 'kab12cd34' })).not.toBe(
      hashClientAddress('203.0.113.7', own)
    )
  })

  it('never contains the address', () => {
    expect(hashClientAddress('203.0.113.7', { key: OWN_KEY, id: 'kab12cd34' })).not.toContain('203')
  })
})

describe('consentHashKeyIdOf', () => {
  const hex = 'ab'.repeat(32)

  it('reads which key made a stored hash', () => {
    expect(consentHashKeyIdOf(hex)).toBeNull()
    expect(consentHashKeyIdOf(`c2:${hex}`)).toBe('c2')
  })

  it('answers undefined for what is not a hash of ours', () => {
    expect(consentHashKeyIdOf('')).toBeUndefined()
    expect(consentHashKeyIdOf('c2:short')).toBeUndefined()
    expect(consentHashKeyIdOf(`C2:${hex}`)).toBeUndefined()
    expect(consentHashKeyIdOf(`${hex}:${hex}`)).toBeUndefined()
  })
})
