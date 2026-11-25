import { CredentialCipher } from '@platform/core/crypto'

import {
  newDsrExportPassword,
  openDsrExportPassword,
  sealDsrExportPassword
} from './dsr-export-password'

const keyA = Buffer.alloc(32, 1)
const keyB = Buffer.alloc(32, 2)

describe('the password of a data export', () => {
  it('is 192 random bits as text, new each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newDsrExportPassword()))
    expect(seen.size).toBe(50)
    for (const password of seen) expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('is sealed, opens for its own request and for no other', () => {
    const cipher = new CredentialCipher(keyA)
    const sealed = sealDsrExportPassword(cipher, 'req-1', 'a-secret-password')
    expect(Buffer.from(sealed).includes(Buffer.from('a-secret-password'))).toBe(false)
    expect(openDsrExportPassword(cipher, 'req-1', sealed)).toBe('a-secret-password')
    expect(() => openDsrExportPassword(cipher, 'req-2', sealed)).toThrow()
  })

  it('uses a new nonce each time it is sealed', () => {
    const cipher = new CredentialCipher(keyA)
    const first = sealDsrExportPassword(cipher, 'req-1', 'same')
    const second = sealDsrExportPassword(cipher, 'req-1', 'same')
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('fails closed when altered or opened with a wrong key, and opens with the previous key of a rotation', () => {
    const sealed = sealDsrExportPassword(new CredentialCipher(keyA), 'req-1', 'pw')
    const altered = Buffer.from(sealed)
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1
    expect(() => openDsrExportPassword(new CredentialCipher(keyA), 'req-1', altered)).toThrow()
    expect(() => openDsrExportPassword(new CredentialCipher(keyB), 'req-1', sealed)).toThrow()
    expect(openDsrExportPassword(new CredentialCipher(keyB, keyA), 'req-1', sealed)).toBe('pw')
  })
})
