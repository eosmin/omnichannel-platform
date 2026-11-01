import { parseWebEnv } from './env-schema'

const validWebEnv = {
  NEXT_PUBLIC_API_URL: 'http://localhost:8080',
  NEXT_PUBLIC_WS_URL: 'http://localhost:8080',
  NEXT_PUBLIC_STORAGE_URL: 'http://localhost:8333',
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: 'http://localhost:4200/v1/widget.js'
}

describe('parseWebEnv', () => {
  it('accepts the public variables and leaves the optional ones undefined', () => {
    const env = parseWebEnv(validWebEnv)
    expect(env.NEXT_PUBLIC_API_URL).toBe('http://localhost:8080')
    expect(env.NEXT_PUBLIC_SENTRY_DSN).toBeUndefined()
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
