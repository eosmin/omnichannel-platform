import { parseEnv } from './env-schema'

const validEnv: Record<string, string> = {
  API_URL: 'http://localhost:8080',
  DATABASE_URL: 'postgresql://platform:pw@localhost:6432/platform_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'platform-dev'
}

describe('parseEnv', () => {
  it('accepts the required variables and applies the defaults', () => {
    const env = parseEnv(validEnv)
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(8080)
    expect(env.S3_FORCE_PATH_STYLE).toBe(false)
    expect(env.BULL_BOARD_ENABLED).toBe(false)
    expect(env.CLAMAV_PORT).toBe(3310)
  })

  it('coerces numbers and parses string booleans', () => {
    const env = parseEnv({
      ...validEnv,
      PORT: '9090',
      S3_FORCE_PATH_STYLE: 'true',
      BULL_BOARD_ENABLED: 'false'
    })
    expect(env.PORT).toBe(9090)
    expect(env.S3_FORCE_PATH_STYLE).toBe(true)
    expect(env.BULL_BOARD_ENABLED).toBe(false)
  })

  it('refuses to start without a required variable, naming it', () => {
    const withoutDatabase = { ...validEnv }
    delete withoutDatabase.DATABASE_URL
    expect(() => parseEnv(withoutDatabase)).toThrow(/DATABASE_URL/)
  })

  it('rejects a short JWT secret and a key that is not 32 bytes of hex', () => {
    expect(() => parseEnv({ ...validEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/)
    expect(() => parseEnv({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'zz'.repeat(32) })).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY/
    )
  })

  it('treats an empty optional URL as invalid, which is why .env.example comments them out', () => {
    expect(() => parseEnv({ ...validEnv, SENTRY_DSN: '' })).toThrow(/SENTRY_DSN/)
    expect(parseEnv(validEnv).SENTRY_DSN).toBeUndefined()
  })

  it('has no billing, AI, OAuth or staff variables', () => {
    const env = parseEnv(validEnv)
    expect(
      Object.keys(env).filter(key =>
        /^(STRIPE_|GOOGLE_|STAFF_|ANTHROPIC_|OPENAI_|FEATURE_)/.test(key)
      )
    ).toEqual([])
  })
})

describe('BULL_BOARD_ADMIN_EMAILS', () => {
  it('defaults to nobody', () => {
    expect(parseEnv(validEnv).BULL_BOARD_ADMIN_EMAILS).toEqual([])
    expect(parseEnv({ ...validEnv, BULL_BOARD_ADMIN_EMAILS: '' }).BULL_BOARD_ADMIN_EMAILS).toEqual(
      []
    )
  })

  it('splits, trims and lowercases a comma-separated list', () => {
    const env = parseEnv({
      ...validEnv,
      BULL_BOARD_ADMIN_EMAILS: ' Owner@Example.com ,ops@example.com,, '
    })
    expect(env.BULL_BOARD_ADMIN_EMAILS).toEqual(['owner@example.com', 'ops@example.com'])
  })

  it('rejects an entry that is not an email', () => {
    expect(() => parseEnv({ ...validEnv, BULL_BOARD_ADMIN_EMAILS: 'not-an-email' })).toThrow()
  })
})
