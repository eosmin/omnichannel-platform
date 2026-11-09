import { parseMetaEnv } from './meta-env'

// What a deployed environment must also say, for the webhooks of Meta
const metaApp = {
  META_APP_SECRET: 's'.repeat(32),
  META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(24)
}
// The block of Meta is parsed on its own: only the variables of the plugin (and NODE_ENV) are read
const validEnv: Record<string, string> = {}

describe('parseMetaEnv', () => {
  describe('the Meta app in a deployed environment', () => {
    const deployed = {
      ...validEnv,
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_key',
      FRONTEND_URL: 'https://app.example.com',
      WIDGET_SCRIPT_URL: 'https://cdn.example.com/widget.js',
      TRUST_PROXY_HOPS: '1'
    }

    it.each(['META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'])(
      'refuses to boot without %s, which would refuse every webhook in silence',
      name => {
        expect(() => parseMetaEnv({ ...deployed, ...metaApp, [name]: undefined })).toThrow(
          new RegExp(name)
        )
      }
    )

    it.each(['META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'])('refuses a short %s', name => {
      expect(() => parseMetaEnv({ ...deployed, ...metaApp, [name]: 'short' })).toThrow(
        new RegExp(name)
      )
    })

    it('refuses one value for both: a verify token that is also the signing key', () => {
      const same = 's'.repeat(32)
      expect(() =>
        parseMetaEnv({ ...deployed, META_APP_SECRET: same, META_WEBHOOK_VERIFY_TOKEN: same })
      ).toThrow(/META_WEBHOOK_VERIFY_TOKEN/)
    })

    describe('the secret of a separate Instagram app', () => {
      const instagram = 'i'.repeat(32)

      it('is optional: a deployed environment boots without it', () => {
        expect(() => parseMetaEnv({ ...deployed, ...metaApp })).not.toThrow()
        expect(
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: undefined })
            .META_INSTAGRAM_APP_SECRET
        ).toBeUndefined()
      })

      it('counts an empty value as not set, as a .env line with nothing after the equal sign is', () => {
        expect(
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: '' })
            .META_INSTAGRAM_APP_SECRET
        ).toBeUndefined()
      })

      it('is read when set', () => {
        expect(
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: instagram })
            .META_INSTAGRAM_APP_SECRET
        ).toBe(instagram)
      })

      it('takes 16 characters and refuses 15, the same boundary as the main secret', () => {
        expect(() =>
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: 'i'.repeat(16) })
        ).not.toThrow()
        expect(() =>
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: 'i'.repeat(15) })
        ).toThrow(/META_INSTAGRAM_APP_SECRET/)
      })

      it('refuses a short one, which would sign nothing worth trusting', () => {
        expect(() =>
          parseMetaEnv({ ...deployed, ...metaApp, META_INSTAGRAM_APP_SECRET: 'short' })
        ).toThrow(/META_INSTAGRAM_APP_SECRET/)
      })

      it('refuses the verify token as its value: that one is shown to Meta in a form', () => {
        expect(() =>
          parseMetaEnv({
            ...deployed,
            ...metaApp,
            META_INSTAGRAM_APP_SECRET: metaApp.META_WEBHOOK_VERIFY_TOKEN
          })
        ).toThrow(/META_INSTAGRAM_APP_SECRET/)
      })

      it('refuses the value of the main secret: two apps cannot share a key, and then neither isolates the other', () => {
        expect(() =>
          parseMetaEnv({
            ...deployed,
            ...metaApp,
            META_INSTAGRAM_APP_SECRET: metaApp.META_APP_SECRET
          })
        ).toThrow(/META_INSTAGRAM_APP_SECRET/)
      })

      it('is not checked on a laptop, whatever it holds', () => {
        expect(() =>
          parseMetaEnv({ ...validEnv, META_INSTAGRAM_APP_SECRET: 'short' })
        ).not.toThrow()
        expect(() =>
          parseMetaEnv({
            ...validEnv,
            ...metaApp,
            META_INSTAGRAM_APP_SECRET: metaApp.META_APP_SECRET
          })
        ).not.toThrow()
      })
    })

    it('does not ask for them on a laptop', () => {
      expect(() => parseMetaEnv(validEnv)).not.toThrow()
    })

    // The host receives the access token of every connection
    it.each(['development', 'staging', 'production'])(
      'refuses a Graph host of its own in %s',
      nodeEnv => {
        expect(() =>
          parseMetaEnv({
            ...deployed,
            ...metaApp,
            NODE_ENV: nodeEnv,
            META_GRAPH_ORIGIN: 'http://localhost:8099'
          })
        ).toThrow(/META_GRAPH_ORIGIN/)
      }
    )

    it('lets a test environment point Graph at a fake host, and only over http(s)', () => {
      expect(
        parseMetaEnv({ ...validEnv, NODE_ENV: 'test', META_GRAPH_ORIGIN: 'http://localhost:8099/' })
          .META_GRAPH_ORIGIN
      ).toBe('http://localhost:8099')
      expect(() =>
        parseMetaEnv({ ...validEnv, NODE_ENV: 'test', META_GRAPH_ORIGIN: 'file:///etc/passwd' })
      ).toThrow(/META_GRAPH_ORIGIN/)
    })
  })

  it('defaults the Graph API version and accepts any vNN.N', () => {
    expect(parseMetaEnv(validEnv).META_GRAPH_API_VERSION).toBe('v23.0')
    for (const version of ['v23.0', 'v9.10', 'v100.0']) {
      expect(
        parseMetaEnv({ ...validEnv, META_GRAPH_API_VERSION: version }).META_GRAPH_API_VERSION
      ).toBe(version)
    }
  })

  it.each(['23.0', 'v23', 'v23.0/../x', 'v23.0?a=b', 'v23.0\n'])(
    'refuses %s as the Graph API version, because it goes into every url',
    version => {
      expect(() => parseMetaEnv({ ...validEnv, META_GRAPH_API_VERSION: version })).toThrow(
        /META_GRAPH_API_VERSION/
      )
    }
  )

  describe('META_OAUTH_REDIRECT_URI (Connect with Facebook)', () => {
    const callback = '/api/v1/channels/oauth/callback'
    const login = {
      ...validEnv,
      ...metaApp,
      META_APP_ID: '950161111253304',
      META_OAUTH_REDIRECT_URI: `http://localhost:8080${callback}`
    }
    const deployed = {
      ...validEnv,
      ...metaApp,
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_key',
      FRONTEND_URL: 'https://app.example.com',
      WIDGET_SCRIPT_URL: 'https://cdn.example.com/widget.js',
      TRUST_PROXY_HOPS: '1',
      META_APP_ID: '950161111253304'
    }

    it('is off when it is not set, which is how the button stays hidden', () => {
      expect(parseMetaEnv(validEnv).META_OAUTH_REDIRECT_URI).toBeUndefined()
      expect(
        parseMetaEnv({ ...validEnv, META_OAUTH_REDIRECT_URI: '' }).META_OAUTH_REDIRECT_URI
      ).toBe(undefined)
    })

    it('accepts the callback of the api on a laptop', () => {
      expect(parseMetaEnv(login).META_OAUTH_REDIRECT_URI).toBe(`http://localhost:8080${callback}`)
    })

    it('accepts an https callback in a deployed environment', () => {
      expect(() =>
        parseMetaEnv({ ...deployed, META_OAUTH_REDIRECT_URI: `https://api.example.com${callback}` })
      ).not.toThrow()
    })

    it.each([
      ['not an address', 'callback'],
      ['another scheme', `ftp://api.example.com${callback}`],
      ['the wrong path', 'https://api.example.com/api/v1/channels/oauth/other'],
      ['no version prefix', 'https://api.example.com/channels/oauth/callback'],
      ['a trailing slash', `https://api.example.com${callback}/`],
      ['a query, which Meta compares byte by byte', `https://api.example.com${callback}?a=1`],
      ['a fragment', `https://api.example.com${callback}#x`],
      ['credentials in the address', `https://user:pw@api.example.com${callback}`],
      ['a host in capitals, which Meta would not match', `https://API.example.com${callback}`],
      ['a default port written out', `https://api.example.com:443${callback}`],
      ['a dot segment', 'https://api.example.com/api/v1/x/../channels/oauth/callback']
    ])('refuses %s', (_why, value) => {
      expect(() => parseMetaEnv({ ...login, META_OAUTH_REDIRECT_URI: value })).toThrow(
        /META_OAUTH_REDIRECT_URI/
      )
    })

    it.each([
      ['http', `http://api.example.com${callback}`],
      ['localhost', `https://localhost${callback}`],
      ['a loopback address', `https://127.0.0.1${callback}`],
      ['the unspecified address', `https://0.0.0.0${callback}`],
      ['the IPv6 loopback', `https://[::1]${callback}`]
    ])(
      'refuses %s in a deployed environment, where Meta must reach a public https address',
      (_w, v) => {
        expect(() => parseMetaEnv({ ...deployed, META_OAUTH_REDIRECT_URI: v })).toThrow(
          /META_OAUTH_REDIRECT_URI/
        )
      }
    )

    it('needs the app id, a number, because the dialog names the app by it', () => {
      expect(() => parseMetaEnv({ ...login, META_APP_ID: undefined })).toThrow(/META_APP_ID/)
      expect(() => parseMetaEnv({ ...login, META_APP_ID: 'omni' })).toThrow(/META_APP_ID/)
    })

    it('needs the app secret, which exchanges the code for a token', () => {
      expect(() => parseMetaEnv({ ...login, META_APP_SECRET: undefined })).toThrow(
        /META_APP_SECRET/
      )
      expect(() => parseMetaEnv({ ...login, META_APP_SECRET: 'short' })).toThrow(/META_APP_SECRET/)
    })

    it('does not ask for the app id when the login is off, as before', () => {
      expect(() => parseMetaEnv({ ...validEnv, META_APP_ID: 'omni' })).not.toThrow()
    })
  })
})
