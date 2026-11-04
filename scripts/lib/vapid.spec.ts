import { createECDH } from 'node:crypto'

import { setVapidDetails } from 'web-push'

import { isBase64UrlOfBytes, PushLimits } from '@platform/core/notifications'

import { generateVapidPair, vapidReport } from './vapid'

describe('vapidReport', () => {
  const keys = generateVapidPair()
  const report = vapidReport(keys)

  it('prints the pair in the shape the api, the worker and the web build read', () => {
    expect(report).toContain(`VAPID_PUBLIC_KEY=${keys.publicKey}\n`)
    expect(report).toContain(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`)
    expect(report).toContain(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}\n`)
  })

  it('prints the private key once and says it is a secret', () => {
    expect(report.split(keys.privateKey)).toHaveLength(2)
    expect(report).toMatch(/secret/i)
  })

  it('makes a pair the env schema accepts', () => {
    expect(isBase64UrlOfBytes(keys.publicKey, PushLimits.VAPID_PUBLIC_BYTES)).toBe(true)
    expect(isBase64UrlOfBytes(keys.privateKey, PushLimits.VAPID_PRIVATE_BYTES)).toBe(true)
  })

  it('makes a public key that is the uncompressed point of the private key', () => {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'))
    const point = ecdh.getPublicKey()
    expect(point[0]).toBe(0x04)
    expect(point.toString('base64url')).toBe(keys.publicKey)
  })

  it('makes a different pair every time', () => {
    expect(generateVapidPair().privateKey).not.toBe(keys.privateKey)
  })

  it('makes a pair the web-push library accepts', () => {
    expect(() => {
      setVapidDetails('mailto:noreply@platform.local', keys.publicKey, keys.privateKey)
    }).not.toThrow()
  })

  it('has no quotes and no angle brackets, so a line can be pasted into any .env file', () => {
    for (const line of report.split('\n').filter(l => /^[A-Z_]+=/.test(l))) {
      expect(line).not.toMatch(/["'<>\s]/)
    }
  })
})
