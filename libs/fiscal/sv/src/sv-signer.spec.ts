import type { SvFetch } from './sv-http'
import { officialSigner, signerBaseUrl, type SvSigned } from './sv-signer'

const answer =
  (status: number, body: unknown): SvFetch =>
  () =>
    Promise.resolve({
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    })

const sign = (fetcher: SvFetch): Promise<SvSigned> =>
  officialSigner({ baseUrl: 'http://signer:8113/', fetch: fetcher, timeoutMs: 500 }).sign({
    nit: '06140101011011',
    privateKeyPassword: 'Key-Password-5678',
    document: { a: 1 }
  })

describe('the official signing service', () => {
  it('gives back the signed document when it answers OK with three parts', async () => {
    expect(await sign(answer(200, { status: 'OK', body: 'a.b.c' }))).toEqual({
      kind: 'signed',
      jws: 'a.b.c'
    })
  })

  it('is unavailable when OK holds anything that is not a signed document, or the answer is not its own', async () => {
    for (const fetcher of [
      answer(200, { status: 'OK', body: 'not-a-jws' }),
      answer(200, { status: 'OK', body: 'a.b' }),
      answer(200, { status: 'OK', body: 'a..c' }),
      answer(200, { status: 'OK', body: 'a b.c.d' }),
      answer(200, { status: 'OK', body: '' }),
      answer(200, 'text'),
      answer(500, { status: 'OK', body: 'a.b.c' }),
      answer(200, {})
    ]) {
      expect(await sign(fetcher)).toEqual({ kind: 'unavailable' })
    }
  })

  it('says the credentials are wrong for the codes that say it, written as text or as a number', async () => {
    for (const codigo of ['803', 803, '809', 809]) {
      expect(
        await sign(answer(200, { status: 'ERROR', body: { codigo, mensaje: ['x'] } }))
      ).toMatchObject({
        kind: 'rejected'
      })
    }
  })

  it('does not blame the credentials for the state of the service: no certificate, a file that is not there, an uncatalogued error', async () => {
    for (const codigo of ['801', 802, '804', '810', 811, '812', 'ZZ']) {
      expect(await sign(answer(200, { status: 'ERROR', body: { codigo } }))).toEqual({
        kind: 'unavailable'
      })
    }
  })

  it('is unavailable when the call cannot be made', async () => {
    expect(await sign(() => Promise.reject(new Error('down')))).toEqual({ kind: 'unavailable' })
  })

  it('takes the address as a base with no trailing slash, and refuses credentials in it or a scheme that is not http', () => {
    expect(signerBaseUrl('http://signer:8113/')).toBe('http://signer:8113')
    expect(signerBaseUrl('https://signer.example.com/sign//')).toBe(
      'https://signer.example.com/sign'
    )
    expect(() => signerBaseUrl('http://user:pw@signer:8113')).toThrow()
    expect(() => signerBaseUrl('file:///tmp/x')).toThrow()
  })
})
