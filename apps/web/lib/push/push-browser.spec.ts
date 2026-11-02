import { urlBase64ToUint8Array } from './push-browser'

describe('urlBase64ToUint8Array', () => {
  it('reads base64url with and without padding', () => {
    // "hello?>" is aGVsbG8_Pg in base64url, with the characters that differ from base64
    expect([...urlBase64ToUint8Array('aGVsbG8_Pg')]).toEqual([104, 101, 108, 108, 111, 63, 62])
  })

  it('reads a key of 65 bytes', () => {
    const key = Buffer.alloc(65, 255).toString('base64url')
    expect(urlBase64ToUint8Array(key)).toHaveLength(65)
  })
})
