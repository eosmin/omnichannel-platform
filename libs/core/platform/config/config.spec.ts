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
      parseEnv({
        ...validEnv,
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_key',
        FRONTEND_URL: 'https://app.example.com',
        TRUST_PROXY_HOPS: '1'
      })
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

describe('SESSION_MAX_AGE', () => {
  it('is 30 days by default, read in seconds', () => {
    expect(parseEnv(validEnv).SESSION_MAX_AGE).toBe(2_592_000)
    expect(parseEnv({ ...validEnv, SESSION_MAX_AGE: '14d' }).SESSION_MAX_AGE).toBe(1_209_600)
  })

  it('cannot be shorter than one refresh token, or the cap would cut every login short', () => {
    expect(() =>
      parseEnv({ ...validEnv, REFRESH_TOKEN_EXPIRES_IN: '7d', SESSION_MAX_AGE: '3d' })
    ).toThrow(/SESSION_MAX_AGE/)
  })

  it('may equal the refresh token: a login that never outlives one token', () => {
    expect(() =>
      parseEnv({ ...validEnv, REFRESH_TOKEN_EXPIRES_IN: '7d', SESSION_MAX_AGE: '7d' })
    ).not.toThrow()
  })

  it.each(['30', 'month', '-1d'])('refuses %j, naming the variable', value => {
    expect(() => parseEnv({ ...validEnv, SESSION_MAX_AGE: value })).toThrow(/SESSION_MAX_AGE/)
  })

  it('cannot be longer than a year: past that it is no cap, and the date overflows', () => {
    expect(parseEnv({ ...validEnv, SESSION_MAX_AGE: '365d' }).SESSION_MAX_AGE).toBe(31_536_000)
    expect(() => parseEnv({ ...validEnv, SESSION_MAX_AGE: '366d' })).toThrow(/365 days/)
    expect(() => parseEnv({ ...validEnv, SESSION_MAX_AGE: '99999999d' })).toThrow(/SESSION_MAX_AGE/)
  })
})

describe('session lifetimes and the proxy', () => {
  it('reads the token lifetimes in seconds, with the defaults of the TDD', () => {
    const env = parseEnv(validEnv)
    expect(env.JWT_EXPIRES_IN).toBe(900)
    expect(env.REFRESH_TOKEN_EXPIRES_IN).toBe(604_800)
    expect(
      parseEnv({ ...validEnv, JWT_EXPIRES_IN: '5m', REFRESH_TOKEN_EXPIRES_IN: '1d' })
    ).toMatchObject({
      JWT_EXPIRES_IN: 300,
      REFRESH_TOKEN_EXPIRES_IN: 86_400
    })
  })

  it.each(['15', '1w', 'fifteen', '-5m'])('refuses the lifetime %j, naming the variable', value => {
    expect(() => parseEnv({ ...validEnv, JWT_EXPIRES_IN: value })).toThrow(/JWT_EXPIRES_IN/)
  })

  it('trusts no proxy by default, and takes a number of hops', () => {
    expect(parseEnv(validEnv).TRUST_PROXY_HOPS).toBe(0)
    expect(parseEnv({ ...validEnv, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1)
    expect(() => parseEnv({ ...validEnv, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/)
    expect(() => parseEnv({ ...validEnv, TRUST_PROXY_HOPS: '2.5' })).toThrow(/TRUST_PROXY_HOPS/)
    // Believing more proxies than exist lets a client choose its own address
    expect(() => parseEnv({ ...validEnv, TRUST_PROXY_HOPS: '6' })).toThrow(/TRUST_PROXY_HOPS/)
  })
})

describe('TRUST_PROXY_HOPS in a deployed environment', () => {
  const deployed = {
    ...validEnv,
    RESEND_API_KEY: 're_key',
    FRONTEND_URL: 'https://app.example.com'
  }

  it.each(['staging', 'production'])(
    'must be set in %s, because forgetting it makes every client share the proxy address',
    nodeEnv => {
      expect(() => parseEnv({ ...deployed, NODE_ENV: nodeEnv })).toThrow(/TRUST_PROXY_HOPS/)
    }
  )

  it.each(['0', '1'])('accepts %s once it is said, 0 included (no proxy in front)', hops => {
    const env = parseEnv({ ...deployed, NODE_ENV: 'production', TRUST_PROXY_HOPS: hops })

    expect(env.TRUST_PROXY_HOPS).toBe(Number(hops))
  })

  it('is not demanded outside a deployed environment', () => {
    expect(() => parseEnv({ ...deployed, NODE_ENV: 'development' })).not.toThrow()
  })

  it('reports it by name, with what to put on Railway', () => {
    expect(() => parseEnv({ ...deployed, NODE_ENV: 'production' })).toThrow(/Railway/)
  })
})

describe('FRONTEND_URL in a deployed environment', () => {
  const deployed = {
    ...validEnv,
    NODE_ENV: 'production',
    RESEND_API_KEY: 're_key',
    TRUST_PROXY_HOPS: '1'
  }

  it('keeps its laptop default outside a deployed environment', () => {
    expect(parseEnv(validEnv).FRONTEND_URL).toBe('http://localhost:3000')
  })

  it.each([
    ['the laptop default', undefined],
    ['localhost', 'https://localhost:3000'],
    ['a loopback address', 'https://127.0.0.1'],
    ['plain http', 'http://app.example.com']
  ])('refuses %s, because the magic links point there', (_name, value) => {
    const source = value === undefined ? deployed : { ...deployed, FRONTEND_URL: value }

    expect(() => parseEnv(source)).toThrow(/FRONTEND_URL/)
  })

  it('defaults the Graph API version and accepts any vNN.N', () => {
    expect(parseEnv(validEnv).META_GRAPH_API_VERSION).toBe('v23.0')
    for (const version of ['v23.0', 'v9.10', 'v100.0']) {
      expect(
        parseEnv({ ...validEnv, META_GRAPH_API_VERSION: version }).META_GRAPH_API_VERSION
      ).toBe(version)
    }
  })

  it.each(['23.0', 'v23', 'v23.0/../x', 'v23.0?a=b', 'v23.0\n'])(
    'refuses %s as the Graph API version, because it goes into every url',
    version => {
      expect(() => parseEnv({ ...validEnv, META_GRAPH_API_VERSION: version })).toThrow(
        /META_GRAPH_API_VERSION/
      )
    }
  )

  it('accepts the https address of the web app', () => {
    expect(() => parseEnv({ ...deployed, FRONTEND_URL: 'https://app.example.com' })).not.toThrow()
  })
})
