import { parseWebEnv } from './env-schema'

const validWebEnv = {
  NEXT_PUBLIC_API_URL: 'http://localhost:8080',
  NEXT_PUBLIC_WS_URL: 'http://localhost:8080',
  NEXT_PUBLIC_STORAGE_URL: 'http://localhost:8333',
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: 'http://localhost:4200/v1/widget.js'
}

// A public key of the shape `pnpm vapid:generate` prints (the one the CI builds the web image with is no secret): 65 bytes, 87 characters
const vapidPublicKey =
  'BPJNI2b9XNUaMZdiMw-lw1t8o9c5IKKEydv4knzKkzklkUoVSQUsoRa2VLL7zfUv1NFEL891XQZ1zv8YSckI_k8'

describe('parseWebEnv', () => {
  it('accepts the public variables and leaves the optional ones undefined', () => {
    const env = parseWebEnv(validWebEnv)
    expect(env.NEXT_PUBLIC_API_URL).toBe('http://localhost:8080')
    expect(env.NEXT_PUBLIC_SENTRY_DSN).toBeUndefined()
  })

  it('takes an empty VAPID key, as a Docker build without one sets it, for no key', () => {
    expect(
      parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_VAPID_PUBLIC_KEY: '' }).NEXT_PUBLIC_VAPID_PUBLIC_KEY
    ).toBeUndefined()
    expect(
      parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapidPublicKey })
        .NEXT_PUBLIC_VAPID_PUBLIC_KEY
    ).toBe(vapidPublicKey)
  })

  it('refuses a VAPID key that is not the public half of a pair, at build and not in the browser', () => {
    for (const key of [
      'abc',
      vapidPublicKey.slice(1),
      `${vapidPublicKey}A`,
      `A${vapidPublicKey.slice(1)}`,
      `${vapidPublicKey.slice(0, 40)}+${vapidPublicKey.slice(41)}`,
      ` ${vapidPublicKey}`
    ]) {
      expect(() => parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_VAPID_PUBLIC_KEY: key })).toThrow(
        /NEXT_PUBLIC_VAPID_PUBLIC_KEY/
      )
    }
  })

  it('fails naming the missing variable', () => {
    expect(() => parseWebEnv({ NEXT_PUBLIC_API_URL: 'http://localhost:8080' })).toThrow(
      /NEXT_PUBLIC_WS_URL/
    )
  })

  it('accepts a ws url for the websocket and refuses other schemes', () => {
    expect(
      parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_WS_URL: 'wss://realtime.example.com' })
        .NEXT_PUBLIC_WS_URL
    ).toBe('wss://realtime.example.com')
    expect(() =>
      parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_WS_URL: 'ftp://x.example.com' })
    ).toThrow(/NEXT_PUBLIC_WS_URL/)
    expect(() =>
      parseWebEnv({ ...validWebEnv, NEXT_PUBLIC_API_URL: 'wss://api.example.com' })
    ).toThrow(/NEXT_PUBLIC_API_URL/)
  })

  it('exposes nothing that is not NEXT_PUBLIC_', () => {
    expect(Object.keys(parseWebEnv(validWebEnv)).every(key => key.startsWith('NEXT_PUBLIC_'))).toBe(
      true
    )
  })
})
