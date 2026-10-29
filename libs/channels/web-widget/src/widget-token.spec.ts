import { createHmac } from 'node:crypto'

import { signVisitorToken, verifyVisitorToken, widgetTokenKey } from './widget-token'

const key = widgetTokenKey('s'.repeat(32))
const claims = { siteKey: 'pk_widget_abc', visitorId: '3f2c1a9e-4b7d-4c1e-9a55-0d1e2f3a4b5c' }
const now = new Date('2026-10-29T12:00:00Z')

describe('visitor token', () => {
  it('gives back the claims it was signed with, and when it expires', () => {
    expect(verifyVisitorToken(key, signVisitorToken(key, claims, now), now)).toEqual({
      ...claims,
      expiresAt: now.getTime() + 3600 * 1000
    })
  })

  it('expires after its time to live', () => {
    const token = signVisitorToken(key, claims, now)
    const later = new Date(now.getTime() + 3600 * 1000)
    expect(verifyVisitorToken(key, token, new Date(later.getTime() - 1000))).toMatchObject(claims)
    expect(verifyVisitorToken(key, token, later)).toBeNull()
  })

  it('refuses a token signed with another secret', () => {
    const other = widgetTokenKey('t'.repeat(32))
    expect(verifyVisitorToken(key, signVisitorToken(other, claims, now), now)).toBeNull()
  })

  it('refuses a token whose claims were changed', () => {
    const [, signature = ''] = signVisitorToken(key, claims, now).split('.')
    const forged = Buffer.from(
      JSON.stringify({ c: 'pk_widget_other', v: claims.visitorId, exp: 9_999_999_999 })
    ).toString('base64url')
    expect(verifyVisitorToken(key, `${forged}.${signature}`, now)).toBeNull()
  })

  it('accepts one encoding of a signature only', () => {
    const token = signVisitorToken(key, claims, now)
    expect(verifyVisitorToken(key, `${token}=`, now)).toBeNull()
    expect(verifyVisitorToken(key, `${token}A`, now)).toBeNull()
  })

  it('refuses what is not a token, and says nothing about why', () => {
    for (const value of [undefined, null, 5, '', 'a', 'a.b.c', '.', 'e30.e30']) {
      expect(verifyVisitorToken(key, value, now)).toBeNull()
    }
  })

  it('refuses a signed token whose claims have the wrong shape', () => {
    const payload = Buffer.from(
      JSON.stringify({ c: 'x', v: 'not-a-uuid', exp: 9_999_999_999 })
    ).toString('base64url')
    const signature = createHmac('sha256', key).update(payload).digest('base64url')
    expect(verifyVisitorToken(key, `${payload}.${signature}`, now)).toBeNull()
  })
})
