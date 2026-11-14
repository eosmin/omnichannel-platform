import { PluginManifestLimits } from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { PluginScopes } from '@platform/plugins/sdk'

import { isNewerVersion, pluginManifestSchema } from './plugin-manifest'

// A manifest that is valid; each case changes one thing
function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme-pos',
    version: '1.0.0',
    name: 'Acme POS',
    description: 'Sends the orders of the store to the point of sale',
    author: { name: 'Acme Inc', email: 'support@acme.com', url: 'https://acme.com' },
    type: 'integration',
    icon: 'https://cdn.acme.com/pos.png',
    pricing: { model: 'free' },
    scopes: [PluginScopes.ORDERS_READ, PluginScopes.WEBHOOKS_WRITE],
    webhooks: {
      endpoint: 'https://acme.com/webhooks/platform',
      events: [Events.ORDER_CREATED],
      signatureHeader: 'X-Platform-Signature'
    },
    ui: { settings: 'https://acme.com/plugin/settings', widget: 'https://acme.com/plugin/widget' },
    widgets: [{ id: 'pos-info', name: 'POS', defaultWidth: 300, defaultHeight: 400 }],
    limits: { maxRequestsPerMinute: 60, maxWebhooksPerDay: 10000 },
    legal: { privacyPolicy: 'https://acme.com/privacy', termsOfService: 'https://acme.com/terms' },
    ...over
  }
}

const refused = (value: unknown): boolean => !pluginManifestSchema.safeParse(value).success
const pathsOf = (value: unknown): string[] => {
  const result = pluginManifestSchema.safeParse(value)
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
}

describe('pluginManifestSchema', () => {
  it('accepts a complete manifest and a minimal one', () => {
    expect(pluginManifestSchema.safeParse(manifest()).success).toBe(true)
    expect(
      pluginManifestSchema.safeParse({
        id: 'tiny',
        version: '0.1.0',
        name: 'Tiny',
        description: 'Reads orders',
        author: { name: 'Me', email: 'me@example.com' },
        type: 'integration',
        pricing: { model: 'free' },
        scopes: []
      }).success
    ).toBe(true)
  })

  it('copies what it reads, so a key that is not in the schema never reaches the row', () => {
    const parsed = pluginManifestSchema.parse(manifest())
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(manifest()).sort())
  })

  it.each(['extra', 'channel', 'commandSecret'])('refuses the unknown key %s at the top', key => {
    expect(refused(manifest({ [key]: {} }))).toBe(true)
  })

  it('refuses an unknown key inside a nested block', () => {
    expect(refused(manifest({ author: { name: 'A', email: 'a@b.co', admin: true } }))).toBe(true)
    expect(refused(manifest({ pricing: { model: 'free', priceCents: 0 } }))).toBe(true)
  })

  describe('type and pricing', () => {
    it.each(['channel', 'carrier', 'other'])('refuses type %s', type => {
      expect(pathsOf(manifest({ type }))).toContain('type')
    })

    it.each(['paid', 'plan_gated', 'FREE'])('refuses the pricing model %s', model => {
      expect(pathsOf(manifest({ pricing: { model } }))).toContain('pricing.model')
    })
  })

  describe('id and version', () => {
    it.each(['ab', 'Acme', '1acme', 'a b', 'a'.repeat(33), '', 'acme.pos', '../x'])(
      'refuses the id %j',
      id => {
        expect(pathsOf(manifest({ id }))).toContain('id')
      }
    )

    it.each([
      '1',
      '1.0',
      'v1.0.0',
      '1.0.0-beta',
      '01.0.0',
      '1.0.0+build',
      '',
      '1.0.0 ',
      '99999999999999999999.0.0',
      '1.1234567890.0'
    ])('refuses the version %j', version => {
      expect(pathsOf(manifest({ version }))).toContain('version')
    })
  })

  describe('texts', () => {
    it.each(['<b>x</b>', 'a\nb', ' padded', 'a\u0000b', '', 'x'.repeat(101)])(
      'refuses the name %j',
      name => {
        expect(pathsOf(manifest({ name }))).toContain('name')
      }
    )

    it('refuses a description over its ceiling', () => {
      expect(
        refused(
          manifest({ description: 'x'.repeat(PluginManifestLimits.DESCRIPTION_MAX_LENGTH + 1) })
        )
      ).toBe(true)
    })

    it('refuses an email that is not one', () => {
      for (const email of ['nobody', 'a@b', 'a b@c.co', '<a@b.co>', 'a@b.co, c@d.co']) {
        expect(refused(manifest({ author: { name: 'A', email } }))).toBe(true)
      }
    })
  })

  describe('names in each language', () => {
    it('accepts a plain text in es and en', () => {
      const parsed = pluginManifestSchema.parse(manifest({ names: { es: 'Mi POS', en: 'My POS' } }))
      expect(parsed.names).toEqual({ es: 'Mi POS', en: 'My POS' })
    })

    it.each([
      { es: 'Solo español' },
      { en: 'English only' },
      { es: '<b>x</b>', en: 'x' },
      { es: 'x', en: 'x'.repeat(101) },
      'text',
      null,
      []
    ])('refuses %j', names => {
      expect(pathsOf(manifest({ names }))).toContain('names')
    })

    it('copies the object it read, so nothing else a pasted one carries survives', () => {
      const pasted = { es: 'Mi POS', en: 'My POS', fr: 'Mon POS' }
      const parsed = pluginManifestSchema.parse(manifest({ names: pasted }))
      expect(parsed.names).toEqual({ es: 'Mi POS', en: 'My POS' })
      expect(parsed.names).not.toBe(pasted)
    })
  })

  describe('addresses', () => {
    const bad = [
      'http://acme.com/hook',
      'https://user:pw@acme.com/hook',
      'https://acme.com:8443/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/hook',
      'https://[::1]/hook',
      'javascript:alert(1)',
      'ftp://acme.com',
      'not a url',
      `https://acme.com/${'a'.repeat(PluginManifestLimits.URL_MAX_LENGTH)}`
    ]

    it.each(bad)('refuses %s as the webhook endpoint', endpoint => {
      expect(
        refused(
          manifest({
            webhooks: { endpoint, events: [Events.ORDER_CREATED], signatureHeader: 'X-Sig' }
          })
        )
      ).toBe(true)
    })

    it.each(['icon', 'ui.settings', 'ui.widget', 'legal.privacyPolicy', 'author.url'])(
      'checks the address at %s too',
      path => {
        const value = manifest()
        const [head, tail] = path.split('.') as [string, string | undefined]
        if (tail === undefined) value[head] = 'http://acme.com/x'
        else (value[head] as Record<string, unknown>)[tail] = 'http://acme.com/x'
        expect(pathsOf(value)).toContain(path)
      }
    )
  })

  describe('scopes', () => {
    it('accepts every scope that exists, once each', () => {
      expect(
        pluginManifestSchema.safeParse(manifest({ scopes: Object.values(PluginScopes) })).success
      ).toBe(true)
    })

    it.each([
      ['an unknown scope', ['orders:delete']],
      ['a scope of a channel plugin that does not exist yet', ['channel:events']],
      ['a repeated scope', [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_READ]],
      ['an administrator wildcard', ['*']],
      ['a scope that is not a string', [1]]
    ])('refuses %s', (_name, scopes) => {
      expect(refused(manifest({ scopes }))).toBe(true)
    })
  })

  describe('webhooks', () => {
    it.each([
      ['no events', []],
      ['an unknown event', ['order.exploded']],
      ['a repeated event', [Events.ORDER_CREATED, Events.ORDER_CREATED]]
    ])('refuses %s', (_name, events) => {
      expect(
        refused(
          manifest({
            webhooks: { endpoint: 'https://acme.com/h', events, signatureHeader: 'X-Sig' }
          })
        )
      ).toBe(true)
    })

    it.each(['', '1X', 'X Sig', 'X-Sig\r\nSet-Cookie: a=b', 'x'.repeat(65)])(
      'refuses the signature header %j',
      signatureHeader => {
        expect(
          refused(
            manifest({
              webhooks: {
                endpoint: 'https://acme.com/h',
                events: [Events.ORDER_CREATED],
                signatureHeader
              }
            })
          )
        ).toBe(true)
      }
    )
  })

  describe('widgets and limits', () => {
    it('refuses widgets with no widget address', () => {
      expect(refused(manifest({ ui: { settings: 'https://acme.com/s' } }))).toBe(true)
      expect(refused(manifest({ ui: undefined }))).toBe(true)
    })

    it('refuses a repeated widget id, sizes out of range and too many widgets', () => {
      const one = { id: 'w-one', name: 'W', defaultWidth: 300, defaultHeight: 400 }
      expect(refused(manifest({ widgets: [one, one] }))).toBe(true)
      expect(refused(manifest({ widgets: [{ ...one, defaultWidth: 10 }] }))).toBe(true)
      expect(refused(manifest({ widgets: [{ ...one, defaultHeight: 99999 }] }))).toBe(true)
      expect(refused(manifest({ widgets: [{ ...one, refreshInterval: 5 }] }))).toBe(true)
      const many = Array.from({ length: PluginManifestLimits.MAX_WIDGETS + 1 }, (_, index) => ({
        ...one,
        id: `w-${String(index).padStart(2, '0')}`
      }))
      expect(refused(manifest({ widgets: many }))).toBe(true)
    })

    it.each([
      { maxRequestsPerMinute: 0 },
      { maxRequestsPerMinute: PluginManifestLimits.MAX_REQUESTS_PER_MINUTE + 1 },
      { maxRequestsPerMinute: 1.5 },
      { maxWebhooksPerDay: -1 },
      { maxWebhooksPerDay: PluginManifestLimits.MAX_WEBHOOKS_PER_DAY + 1 },
      { maxRequestsPerMinute: '60' }
    ])('refuses the limits %j', limits => {
      expect(refused(manifest({ limits }))).toBe(true)
    })
  })

  it('refuses what is not an object', () => {
    for (const value of [null, undefined, 'x', 1, [], [manifest()]])
      expect(refused(value)).toBe(true)
  })
})

describe('isNewerVersion', () => {
  it.each([
    ['1.0.1', '1.0.0', true],
    ['1.1.0', '1.0.9', true],
    ['2.0.0', '1.99.99', true],
    ['1.0.10', '1.0.9', true],
    ['1.0.0', '1.0.0', false],
    ['1.0.0', '1.0.1', false],
    ['0.9.0', '1.0.0', false],
    ['1.0.0-beta', '0.9.0', false],
    ['x', '1.0.0', false]
  ])('%s over %s is %s', (next, current, expected) => {
    expect(isNewerVersion(next, current)).toBe(expected)
  })
})
