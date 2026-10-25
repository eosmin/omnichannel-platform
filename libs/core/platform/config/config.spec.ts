import { parseEnv } from './env-schema'

const validEnv: Record<string, string> = {
  API_URL: 'http://localhost:8080',
  DATABASE_URL: 'postgresql://platform:pw@localhost:6432/platform_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'platform-dev',
  SMTP_URL: 'smtp://localhost:1025'
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

describe('deployed environments', () => {
  const placeholders = {
    JWT_SECRET: 'change-me-to-at-least-32-characters-long-value',
    CREDENTIALS_ENCRYPTION_KEY: '0'.repeat(64)
  }

  it('accept the .env.example placeholders on a laptop', () => {
    expect(() => parseEnv({ ...validEnv, ...placeholders, NODE_ENV: 'development' })).not.toThrow()
    expect(() => parseEnv({ ...validEnv, ...placeholders, NODE_ENV: 'test' })).not.toThrow()
  })

  it.each(['staging', 'production'])('reject the placeholder secrets in %s', nodeEnv => {
    expect(() => parseEnv({ ...validEnv, ...placeholders, NODE_ENV: nodeEnv })).toThrow(
      /JWT_SECRET[\s\S]*CREDENTIALS_ENCRYPTION_KEY|CREDENTIALS_ENCRYPTION_KEY[\s\S]*JWT_SECRET/
    )
  })

  it('accept real secrets in production, sending through Resend', () => {
    expect(() =>
      parseEnv({ ...validEnv, NODE_ENV: 'production', RESEND_API_KEY: 're_key' })
    ).not.toThrow()
  })

  it.each(['staging', 'production'])('refuse to send through SMTP in %s', nodeEnv => {
    expect(() => parseEnv({ ...validEnv, NODE_ENV: nodeEnv })).toThrow(/RESEND_API_KEY/)
  })

  it('reports the missing key once, not once per rule', () => {
    const none: Record<string, string> = { ...validEnv, NODE_ENV: 'production' }
    delete none['SMTP_URL']
    try {
      parseEnv(none)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message.match(/RESEND_API_KEY/g)).toHaveLength(2) // The path of the issue and its text
      return
    }
    throw new Error('parseEnv accepted a production env without a transport')
  })
})

describe('email transport', () => {
  it('needs Resend or SMTP, and says which variables to set', () => {
    const none = { ...validEnv }
    delete none.SMTP_URL
    expect(() => parseEnv(none)).toThrow(/RESEND_API_KEY.*SMTP_URL/)
    expect(() => parseEnv({ ...none, RESEND_API_KEY: 're_key' })).not.toThrow()
  })
})

describe('EMAIL_FROM', () => {
  it('accepts a bare address and the "Name <address>" form', () => {
    expect(parseEnv(validEnv).EMAIL_FROM).toBe('noreply@platform.local')
    expect(parseEnv({ ...validEnv, EMAIL_FROM: 'ventas@mitienda.com' }).EMAIL_FROM).toBe(
      'ventas@mitienda.com'
    )
    expect(
      parseEnv({ ...validEnv, EMAIL_FROM: 'Mi Tienda <ventas@mitienda.com>' }).EMAIL_FROM
    ).toBe('Mi Tienda <ventas@mitienda.com>')
  })

  it('rejects a bad address, with or without a name', () => {
    for (const value of ['not-an-email', 'Mi Tienda <not-an-email>', 'a@b.com c@d.com', '<>']) {
      expect(() => parseEnv({ ...validEnv, EMAIL_FROM: value })).toThrow(/EMAIL_FROM/)
    }
  })
})

describe('ports', () => {
  it('reject an empty, fractional or out-of-range port', () => {
    for (const port of ['', ' ', '80.5', '0', '99999']) {
      expect(() => parseEnv({ ...validEnv, PORT: port })).toThrow(/PORT/)
    }
    expect(() => parseEnv({ ...validEnv, CLAMAV_PORT: '' })).toThrow(/CLAMAV_PORT/)
    expect(parseEnv({ ...validEnv, PORT: '65535' }).PORT).toBe(65535)
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
