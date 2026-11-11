import { CredentialCipher } from '@platform/core/crypto'

import { buildCarrierContext, CarrierCredentialsUnreadableError } from './carrier-context'

const cipher = new CredentialCipher(Buffer.alloc(32, 7))
const base = { id: 'c1', storeId: 's1' }

describe('buildCarrierContext', () => {
  it('opens the sealed credentials for the call and names the store and the connection', () => {
    const credentials = cipher.seal({ apiKey: 'k-123' })
    const context = buildCarrierContext(
      { ...base, credentials, contact: { account: 'main' } },
      cipher
    )
    expect(context).toEqual({
      storeId: 's1',
      connectionId: 'c1',
      credentials: { apiKey: 'k-123' },
      metadata: { account: 'main' }
    })
  })

  it('gives empty credentials to a connection that holds none, as the local courier', () => {
    const context = buildCarrierContext(
      { ...base, credentials: null, contact: { phone: '7000', prefix: 'JM' } },
      cipher
    )
    expect(context.credentials).toEqual({})
    expect(context.metadata).toEqual({ phone: '7000', prefix: 'JM' })
  })

  it.each([null, undefined, 'text', 4, ['a']])('reads %p as no settings', contact => {
    expect(buildCarrierContext({ ...base, credentials: null, contact }, cipher).metadata).toEqual(
      {}
    )
  })

  it('does not open credentials sealed with another key', () => {
    const other = new CredentialCipher(Buffer.alloc(32, 9))
    expect(() =>
      buildCarrierContext({ ...base, credentials: other.seal({ a: 1 }), contact: null }, cipher)
    ).toThrow(CarrierCredentialsUnreadableError)
  })
})
