import {
  dsrEmailHash,
  dsrHashKeyOf,
  type DsrIntake,
  normalizeDsrEmail,
  openDsrIntake,
  sealDsrIntake
} from './dsr-intake'

const KEY = 'a'.repeat(64)
const intake: DsrIntake = {
  storeKey: 'k'.repeat(24),
  type: 'erasure' as DsrIntake['type'],
  email: 'Ana.Perez@Example.com',
  locale: 'es'
}

describe('normalizeDsrEmail and dsrEmailHash', () => {
  it('compares addresses trimmed and in lower case', () => {
    expect(normalizeDsrEmail('  Ana.Perez@Example.COM ')).toBe('ana.perez@example.com')
    const key = dsrHashKeyOf('secret')
    expect(dsrEmailHash(' Ana@Example.com', key)).toBe(dsrEmailHash('ana@example.com ', key))
  })

  it('hashes with a key: another key gives another hash and the hash holds no part of the address', () => {
    const a = dsrEmailHash('ana@example.com', dsrHashKeyOf('one'))
    expect(a).not.toBe(dsrEmailHash('ana@example.com', dsrHashKeyOf('two')))
    expect(a).not.toContain('ana')
  })
})

describe('sealDsrIntake and openDsrIntake', () => {
  it('opens what it sealed', () => {
    expect(openDsrIntake(sealDsrIntake(intake, KEY), KEY)).toEqual(intake)
  })

  it('never holds the address, the key of the store or the kind of request in the clear', () => {
    const sealed = sealDsrIntake(intake, KEY)
    const text = Buffer.from(sealed, 'base64').toString('latin1')
    for (const secret of ['ana.perez', 'example.com', intake.storeKey, 'erasure']) {
      expect(sealed.toLowerCase()).not.toContain(secret)
      expect(text.toLowerCase()).not.toContain(secret)
    }
  })

  it('refuses a payload sealed with another key, a tampered one and a malformed one', () => {
    const sealed = sealDsrIntake(intake, KEY)
    expect(openDsrIntake(sealed, 'b'.repeat(64))).toBeNull()
    const bytes = Buffer.from(sealed, 'base64')
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1
    expect(openDsrIntake(bytes.toString('base64'), KEY)).toBeNull()
    expect(openDsrIntake('not a payload', KEY)).toBeNull()
  })

  it('refuses a payload that opens but does not fit (a language the store does not speak)', () => {
    const odd = sealDsrIntake({ ...intake, locale: 'xx' as DsrIntake['locale'] }, KEY)
    expect(openDsrIntake(odd, KEY)).toBeNull()
  })
})
