import { createHmac } from 'node:crypto'

import { answerMetaHandshake, isValidMetaSignature } from './meta-webhook'

const SECRET = 'app-secret-for-tests'
const BODY = '{"object":"whatsapp_business_account","entry":[]}'

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('isValidMetaSignature', () => {
  it('accepts the signature of the raw body', () => {
    expect(isValidMetaSignature(BODY, sign(BODY), SECRET)).toBe(true)
  })

  it('accepts the hex in upper case', () => {
    const upper = `sha256=${sign(BODY).slice('sha256='.length).toUpperCase()}`
    expect(isValidMetaSignature(BODY, upper, SECRET)).toBe(true)
  })

  it('accepts a body with non-ASCII text the way the api hands it over (Buffer decoded as UTF-8)', () => {
    const body = '{"text":"¿Cuánto cuesta el envío? 🙂 日本語"}'
    const asReceived = Buffer.from(body, 'utf8').toString()
    expect(isValidMetaSignature(asReceived, sign(body), SECRET)).toBe(true)
  })

  it('refuses a body that changed by one byte', () => {
    expect(isValidMetaSignature(`${BODY} `, sign(BODY), SECRET)).toBe(false)
  })

  it('refuses a signature made with another secret', () => {
    expect(isValidMetaSignature(BODY, sign(BODY, 'other'), SECRET)).toBe(false)
  })

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['no prefix', sign(BODY).slice('sha256='.length)],
    ['the sha1 prefix', sign(BODY).replace('sha256=', 'sha1=')],
    ['a short digest', 'sha256=abcd'],
    ['a digest that is not hex', `sha256=${'z'.repeat(64)}`],
    ['a long digest', `${sign(BODY)}00`]
  ])('refuses %s without throwing', (_name, header) => {
    expect(isValidMetaSignature(BODY, header, SECRET)).toBe(false)
  })

  it('refuses everything when the app has no secret, even a signature made with an empty one', () => {
    expect(isValidMetaSignature(BODY, sign(BODY, ''), undefined)).toBe(false)
    expect(isValidMetaSignature(BODY, sign(BODY, ''), '')).toBe(false)
  })
})

describe('answerMetaHandshake', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'verify-me',
    'hub.challenge': '1158201444'
  }

  it('answers the challenge for the right mode and token', () => {
    expect(answerMetaHandshake(query, 'verify-me')).toBe('1158201444')
  })

  it('refuses a wrong token, a longer one and a missing one', () => {
    expect(answerMetaHandshake({ ...query, 'hub.verify_token': 'nope' }, 'verify-me')).toBeNull()
    expect(
      answerMetaHandshake({ ...query, 'hub.verify_token': 'verify-me!' }, 'verify-me')
    ).toBeNull()
    const withoutToken = { ...query, 'hub.verify_token': undefined } as unknown as Record<
      string,
      string
    >
    expect(answerMetaHandshake(withoutToken, 'verify-me')).toBeNull()
  })

  it('refuses query values that are not strings, as Express builds them for ?a[]=x, without throwing', () => {
    const forged = (key: string, value: unknown): Record<string, string> => ({
      ...query,
      [key]: value
    })
    expect(answerMetaHandshake(forged('hub.verify_token', ['verify-me']), 'verify-me')).toBeNull()
    expect(answerMetaHandshake(forged('hub.verify_token', { a: 'b' }), 'verify-me')).toBeNull()
    expect(answerMetaHandshake(forged('hub.challenge', ['42']), 'verify-me')).toBeNull()
    expect(answerMetaHandshake(forged('hub.mode', ['subscribe']), 'verify-me')).toBeNull()
  })

  it('refuses another mode', () => {
    expect(answerMetaHandshake({ ...query, 'hub.mode': 'unsubscribe' }, 'verify-me')).toBeNull()
  })

  it('refuses when the platform has no verify token, even for an empty one', () => {
    expect(answerMetaHandshake({ ...query, 'hub.verify_token': '' }, undefined)).toBeNull()
    expect(answerMetaHandshake({ ...query, 'hub.verify_token': '' }, '')).toBeNull()
  })

  it.each(['<script>alert(1)</script>', '12ab', '', '1'.repeat(21), '-5'])(
    'does not echo a challenge that is not an integer (%s)',
    challenge => {
      expect(answerMetaHandshake({ ...query, 'hub.challenge': challenge }, 'verify-me')).toBeNull()
    }
  )
})
