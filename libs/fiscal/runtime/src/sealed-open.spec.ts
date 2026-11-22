import { randomBytes } from 'node:crypto'

import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher, DecryptionFailure } from '@platform/core/crypto'
import { SealedValueKind } from '@platform/core/domain'

import { openSealed } from './sealed-open'

// Step 7.3-S11a: what a sealed value that does not open writes in the log
describe('openSealed', () => {
  const cipher = new CredentialCipher(randomBytes(32))
  const logger = () => {
    const error = jest.fn()
    return { error, logger: { error } as unknown as PinoLogger }
  }

  it('gives back what it opened and logs nothing', () => {
    const { error, logger: log } = logger()
    const sealed = cipher.seal({ a: 'b' })
    expect(openSealed(cipher, log, sealed, SealedValueKind.RECEIVER, { documentId: 'd1' })).toEqual(
      {
        a: 'b'
      }
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('opens a value of the previous key during a rotation, and says nothing', () => {
    const { error, logger: log } = logger()
    const previous = randomBytes(32)
    const rotated = new CredentialCipher(randomBytes(32), previous)
    const sealed = new CredentialCipher(previous).seal({ a: 'b' })
    expect(
      openSealed(rotated, log, sealed, SealedValueKind.RECEIVER, { documentId: 'd1' })
    ).toEqual({
      a: 'b'
    })
    expect(error).not.toHaveBeenCalled()
  })

  it('logs the name, the cause as a code and the ids, and never the message or the bytes', () => {
    const { error, logger: log } = logger()
    const other = new CredentialCipher(randomBytes(32))
    const sealed = other.seal({ taxId: 'TAX-SECRET-77' })
    expect(() =>
      openSealed(cipher, log, sealed, SealedValueKind.RECEIVER, { documentId: 'd1' })
    ).toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    const calls = error.mock.calls as unknown as [Record<string, unknown>][]
    const fields = calls[0]?.[0] ?? {}
    expect(Object.keys(fields).sort()).toEqual(['documentId', 'errorName', 'failure', 'what'])
    expect(fields).toMatchObject({
      errorName: 'DecryptionError',
      failure: DecryptionFailure.KEY_MISMATCH,
      what: SealedValueKind.RECEIVER,
      documentId: 'd1'
    })
    expect(JSON.stringify(error.mock.calls)).not.toContain('TAX-SECRET')
  })

  it('says row_damaged for a value that is not a sealed one, and key_missing without a key', () => {
    const { error, logger: log } = logger()
    expect(() =>
      openSealed(cipher, log, Buffer.from([1, 2]), SealedValueKind.BUILT_PAYLOAD, {})
    ).toThrow()
    expect(() =>
      openSealed(
        new CredentialCipher(Buffer.alloc(0)),
        log,
        cipher.seal({ a: 'b' }),
        SealedValueKind.ISSUER_CREDENTIALS,
        { organizationId: 'o1' }
      )
    ).toThrow()
    const calls = error.mock.calls as unknown as [{ failure: string }][]
    const failures = calls.map(call => call[0].failure)
    expect(failures).toEqual([DecryptionFailure.ROW_DAMAGED, DecryptionFailure.KEY_MISSING])
  })

  it('stays quiet for a read that only lists, and still throws', () => {
    const { error, logger: log } = logger()
    expect(() =>
      openSealed(cipher, log, Buffer.from([1, 2]), SealedValueKind.RECEIVER, {}, true)
    ).toThrow()
    expect(error).not.toHaveBeenCalled()
  })
})
