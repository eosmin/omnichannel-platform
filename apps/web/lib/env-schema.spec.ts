import { parseWebEnv } from './env-schema'

const validWebEnv = {
  NEXT_PUBLIC_API_URL: 'http://localhost:8080',
  NEXT_PUBLIC_WS_URL: 'http://localhost:8080',
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

  it('exposes nothing that is not NEXT_PUBLIC_', () => {
    expect(Object.keys(parseWebEnv(validWebEnv)).every(key => key.startsWith('NEXT_PUBLIC_'))).toBe(
      true
    )
  })
})
