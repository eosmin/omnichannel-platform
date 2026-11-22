import { PluginIdempotency } from '@platform/core/domain'

import { canonicalJson, idempotencyKeyOf, requestFingerprint } from './plugin-idempotency'

describe('idempotencyKeyOf', () => {
  it('takes visible ASCII of 1 to the limit', () => {
    expect(idempotencyKeyOf('a')).toBe('a')
    expect(idempotencyKeyOf('order-7f3a/2027:01~x')).toBe('order-7f3a/2027:01~x')
    const longest = 'k'.repeat(PluginIdempotency.KEY_MAX_LENGTH)
    expect(idempotencyKeyOf(longest)).toBe(longest)
  })

  it('refuses what the table would refuse', () => {
    expect(idempotencyKeyOf(undefined)).toBeNull()
    expect(idempotencyKeyOf('')).toBeNull()
    expect(idempotencyKeyOf('k'.repeat(PluginIdempotency.KEY_MAX_LENGTH + 1))).toBeNull()
    expect(idempotencyKeyOf('two words')).toBeNull()
    expect(idempotencyKeyOf('a, b')).toBeNull()
    expect(idempotencyKeyOf('tab\there')).toBeNull()
    expect(idempotencyKeyOf('café')).toBeNull()
    expect(idempotencyKeyOf('line\nbreak')).toBeNull()
    expect(idempotencyKeyOf(['a', 'b'])).toBeNull()
  })
})

describe('canonicalJson', () => {
  it('does not depend on the order of the keys, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 })
    )
  })

  it('keeps the order of an array and tells different values apart', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }))
  })
})

describe('requestFingerprint', () => {
  const base = { method: 'POST', originalUrl: '/api/v1/plugin-api/orders', body: { a: 1, b: 2 } }

  it('is the same for the same request, whatever the order of the body', () => {
    expect(requestFingerprint({ ...base, body: { b: 2, a: 1 } })).toBe(requestFingerprint(base))
  })

  it('changes with the method, the address (path and query) and the body', () => {
    const fingerprint = requestFingerprint(base)
    expect(requestFingerprint({ ...base, method: 'PUT' })).not.toBe(fingerprint)
    expect(requestFingerprint({ ...base, originalUrl: `${base.originalUrl}/other` })).not.toBe(
      fingerprint
    )
    expect(requestFingerprint({ ...base, originalUrl: `${base.originalUrl}?x=1` })).not.toBe(
      fingerprint
    )
    expect(requestFingerprint({ ...base, body: { a: 1, b: 3 } })).not.toBe(fingerprint)
    expect(requestFingerprint({ ...base, body: undefined })).not.toBe(fingerprint)
  })
})
