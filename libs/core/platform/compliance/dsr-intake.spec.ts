import {
  dsrEmailHash,
  dsrIntakeSchema,
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
  it('opens what it sealed, with the address in the form the customers are compared in (trimmed, lower case)', () => {
    // The envelope is never shown: the search of the customers and the hash of the duplicate check read this form, and the address that
    // a reviewer sees is the one of the customer row
    expect(openDsrIntake(sealDsrIntake(intake, KEY), KEY)).toEqual({
      ...intake,
      email: 'ana.perez@example.com'
    })
  })

  it('opens the same identity whatever the case or the spaces the person typed', () => {
    const typed = (email: string) => openDsrIntake(sealDsrIntake({ ...intake, email }, KEY), KEY)
    expect(typed(' ANA.PEREZ@EXAMPLE.COM ')).toEqual(typed('ana.perez@example.com'))
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

describe('dsrIntakeSchema', () => {
  it('reads a pasted address with spaces and capitals as the lower-case address', () => {
    const parsed = dsrIntakeSchema.parse({ ...intake, email: '  Ana.Perez@Example.COM ' })
    expect(parsed.email).toBe('ana.perez@example.com')
  })

  it('refuses a body that is not an address, a kind or a language of the platform', () => {
    expect(dsrIntakeSchema.safeParse({ ...intake, email: 'not-an-address' }).success).toBe(false)
    expect(dsrIntakeSchema.safeParse({ ...intake, type: 'sell' }).success).toBe(false)
    expect(dsrIntakeSchema.safeParse({ ...intake, locale: 'fr' }).success).toBe(false)
  })
})
