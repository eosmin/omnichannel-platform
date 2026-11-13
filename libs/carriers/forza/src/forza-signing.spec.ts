import { createHmac } from 'node:crypto'

import { decodeForzaPayload, signForzaRequest } from './forza-signing'

const FAKE_SECRET = 'fake-secret-key-0123456789abcdef'

describe('signForzaRequest', () => {
  it('sends the request as base64 and signs that same JSON with HMAC-SHA256 in base64', () => {
    const { payload, signature } = signForzaRequest('SomeMethod', { A: 1 }, FAKE_SECRET)
    const json = Buffer.from(payload, 'base64').toString('utf8')
    expect(JSON.parse(json)).toEqual({ Method: 'SomeMethod', Params: { A: 1 } })
    expect(signature).toBe(createHmac('sha256', FAKE_SECRET).update(json).digest('base64'))
    expect(signature).toHaveLength(44)
  })

  it('signs differently with another key', () => {
    const one = signForzaRequest('M', {}, FAKE_SECRET)
    const other = signForzaRequest('M', {}, `${FAKE_SECRET}x`)
    expect(one.signature).not.toBe(other.signature)
  })
})

describe('decodeForzaPayload', () => {
  it('reads base64 JSON and answers null for anything else', () => {
    const payload = Buffer.from(JSON.stringify({ StatusCode: 200 })).toString('base64')
    expect(decodeForzaPayload(payload)).toEqual({ StatusCode: 200 })
    expect(decodeForzaPayload('not base64 json')).toBeNull()
  })
})
