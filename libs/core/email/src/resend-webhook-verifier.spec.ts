import { createHmac } from 'node:crypto'

import { Logger } from '@nestjs/common'

import { PlatformException } from '@platform/core/errors'

import { ResendWebhookVerifier } from './resend-webhook-verifier'

const secretBytes = Buffer.from('a-secret-of-some-length-for-the-test')
const secret = `whsec_${secretBytes.toString('base64')}`
const body = Buffer.from(JSON.stringify({ type: 'email.opened', data: { email_id: 'e1' } }))

// The Standard Webhooks signature Resend sends: HMAC-SHA256 of "<id>.<timestamp>.<body>"
function sign(id: string, timestamp: string, payload: Buffer): string {
  const digest = createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${payload.toString('utf8')}`)
    .digest('base64')
  return `v1,${digest}`
}
const nowSeconds = (): string => String(Math.floor(Date.now() / 1000))

// The HTTP status of the PlatformException that the call throws
function statusOfRejection(call: () => unknown): number | undefined {
  try {
    call()
  } catch (error) {
    return error instanceof PlatformException ? error.statusCode : undefined
  }
  return undefined
}

describe('ResendWebhookVerifier', () => {
  const verifier = new ResendWebhookVerifier(secret)

  it('returns the event when the signature matches the raw body', () => {
    const timestamp = nowSeconds()
    const event = verifier.verify(body, {
      id: 'msg_1',
      timestamp,
      signature: sign('msg_1', timestamp, body)
    })
    expect(event).toMatchObject({ type: 'email.opened' })
  })

  it('rejects a body that changed after it was signed', () => {
    const timestamp = nowSeconds()
    const signature = sign('msg_1', timestamp, body)
    expect(() =>
      verifier.verify(Buffer.from('{"type":"email.bounced"}'), {
        id: 'msg_1',
        timestamp,
        signature
      })
    ).toThrow(PlatformException)
  })

  it('logs why it refused a signature, without the secret or the body', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const timestamp = nowSeconds()
    expect(
      statusOfRejection(() =>
        verifier.verify(body, { id: 'msg_1', timestamp, signature: 'v1,not-the-signature' })
      )
    ).toBe(401)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('resend webhook refused')
    expect(logged).not.toContain(secret)
    expect(logged).not.toContain('email_id')
    warn.mockRestore()
  })

  it('rejects a timestamp too old to be a fresh delivery (replay)', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 3600)
    expect(() =>
      verifier.verify(body, { id: 'msg_1', timestamp, signature: sign('msg_1', timestamp, body) })
    ).toThrow(PlatformException)
  })

  it('rejects missing headers and a missing raw body with a 401', () => {
    expect(statusOfRejection(() => verifier.verify(body, {}))).toBe(401)
    expect(
      statusOfRejection(() =>
        verifier.verify(undefined, { id: 'a', timestamp: 'b', signature: 'c' })
      )
    ).toBe(401)
  })

  it('rejects everything when no secret is configured', () => {
    const timestamp = nowSeconds()
    expect(
      statusOfRejection(() =>
        new ResendWebhookVerifier(undefined).verify(body, {
          id: 'msg_1',
          timestamp,
          signature: sign('msg_1', timestamp, body)
        })
      )
    ).toBe(401)
  })
})
