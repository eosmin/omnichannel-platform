import {
  ChannelConnectFieldLimits,
  ChannelIds,
  ChannelPluginScopes,
  ChannelManifestLimits,
  ManifestChannelCapabilities,
  PluginManifestLimits,
  PluginWidgetLimits
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { allowLocalCommandsUrl } from '@platform/core/url-safety'
import { PluginScopes } from '@platform/plugins/sdk'

import { isNewerVersion, manifestWebhookOf, pluginManifestSchema } from './plugin-manifest'

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
    it.each(['carrier', 'other'])('refuses type %s', type => {
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

    it('refuses a third language instead of dropping it without a word', () => {
      expect(pathsOf(manifest({ names: { es: 'Mi POS', en: 'My POS', fr: 'Mon POS' } }))).toContain(
        'names'
      )
    })

    it('copies the object it read', () => {
      const pasted = { es: 'Mi POS', en: 'My POS' }
      const parsed = pluginManifestSchema.parse(manifest({ names: pasted }))
      expect(parsed.names).toEqual(pasted)
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
        pluginManifestSchema.safeParse(
          manifest({
            scopes: Object.values(PluginScopes).filter(
              scope => !Object.values<string>(ChannelPluginScopes).includes(scope)
            )
          })
        ).success
      ).toBe(true)
    })

    it.each([
      ['an unknown scope', ['orders:delete']],
      ['a scope of a channel that does not exist', ['channel:other']],
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

    it.each([
      '',
      '1X',
      'X Sig',
      'X-Sig\r\nSet-Cookie: a=b',
      'x'.repeat(65),
      'Host',
      'content-length',
      'Authorization',
      'COOKIE',
      'Transfer-Encoding',
      'Proxy-Anything',
      'Sec-Fetch-Site',
      'X-Forwarded-For'
    ])('refuses the signature header %j', signatureHeader => {
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
    })
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
      const many = Array.from(
        { length: PluginWidgetLimits.WIDGETS_PER_PLUGIN_MAX + 1 },
        (_, index) => ({
          ...one,
          id: `w-${String(index).padStart(2, '0')}`
        })
      )
      expect(refused(manifest({ widgets: many }))).toBe(true)
    })

    // What the reader of a widget list drops without a word must not register: the plugin would vanish from the list
    it.each([
      ['defaultWidth', 199, 200, 600, 601],
      ['defaultHeight', 99, 100, 800, 801],
      ['refreshInterval', 4999, 5000, 3_600_000, 3_600_001]
    ])('holds %s to the limits of the reader at both edges', (key, below, low, high, above) => {
      const one = { id: 'w-one', name: 'W', defaultWidth: 300, defaultHeight: 400 }
      for (const value of [below, above])
        expect(refused(manifest({ widgets: [{ ...one, [key]: value }] }))).toBe(true)
      for (const value of [low, high])
        expect(refused(manifest({ widgets: [{ ...one, [key]: value }] }))).toBe(false)
    })

    it('refuses what the reader of the widget list would drop: a size the panel cannot hold, a quick refresh, six widgets, an address with a query', () => {
      const one = { id: 'w-one', name: 'W', defaultWidth: 300, defaultHeight: 400 }
      expect(refused(manifest({ widgets: [{ ...one, defaultWidth: 1000 }] }))).toBe(true)
      expect(refused(manifest({ widgets: [{ ...one, defaultHeight: 900 }] }))).toBe(true)
      expect(refused(manifest({ widgets: [{ ...one, refreshInterval: 1000 }] }))).toBe(true)
      const six = Array.from({ length: 6 }, (_, index) => ({ ...one, id: `w-${index}` }))
      expect(refused(manifest({ widgets: six }))).toBe(true)
      expect(refused(manifest({ widgets: [] }))).toBe(true)
      expect(
        refused(
          manifest({ ui: { settings: 'https://acme.com/s', widget: 'https://acme.com/w?x=1' } })
        )
      ).toBe(true)
      expect(
        refused(
          manifest({
            widgets: [{ ...one, defaultWidth: 600, defaultHeight: 800, refreshInterval: 5000 }]
          })
        )
      ).toBe(false)
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

// The manifest of a channel plugin (TDD_10 §6.7.2); each case changes one thing
function channelManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return manifest({
    id: 'acme-chat',
    type: 'channel',
    scopes: [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS],
    capabilities: ['text', 'image', 'reply_to', 'delivery_receipts'],
    channel: {
      label: 'Acme Chat',
      commandsUrl: 'https://acme.com/platform/commands',
      messagingWindow: { hours: 24 }
    },
    widgets: undefined,
    ui: undefined,
    ...over
  })
}

describe('pluginManifestSchema, channel plugins', () => {
  it('accepts a channel manifest, with and without a window', () => {
    expect(pluginManifestSchema.safeParse(channelManifest()).success).toBe(true)
    expect(
      pluginManifestSchema.safeParse(
        channelManifest({
          channel: { label: 'Acme Chat', commandsUrl: 'https://acme.com/platform/commands' }
        })
      ).success
    ).toBe(true)
  })

  it('keeps the channel block and the capabilities it checked', () => {
    const parsed = pluginManifestSchema.parse(channelManifest())
    expect(parsed.channel?.messagingWindow).toEqual({ hours: 24 })
    expect(parsed.capabilities).toEqual(['text', 'image', 'reply_to', 'delivery_receipts'])
  })

  it('accepts caption_per_file when it is declared and never grants it when it is not', () => {
    const declared = pluginManifestSchema.parse(
      channelManifest({ capabilities: ['text', 'image', 'caption_per_file'] })
    )
    expect(declared.capabilities).toContain('caption_per_file')
    const plain = pluginManifestSchema.parse(channelManifest({ capabilities: ['text', 'image'] }))
    expect(plain.capabilities).not.toContain('caption_per_file')
    expect(
      pluginManifestSchema.parse(channelManifest({ capabilities: undefined })).capabilities
    ).toBeUndefined()
  })

  it('accepts every capability a remote channel may declare, and none that it may not', () => {
    expect(
      pluginManifestSchema.safeParse(
        channelManifest({ capabilities: [...ManifestChannelCapabilities] })
      ).success
    ).toBe(true)
    for (const capability of [
      'location',
      'templates',
      'buttons',
      'list_picker',
      'reactions',
      'messaging_window',
      'names_inbound_files',
      'nothing'
    ]) {
      expect(refused(channelManifest({ capabilities: [capability] }))).toBe(true)
    }
  })

  it('refuses a repeated capability', () => {
    expect(refused(channelManifest({ capabilities: ['text', 'text'] }))).toBe(true)
  })

  it('needs the channel block, and a plugin with another type may not carry it', () => {
    expect(pathsOf(channelManifest({ channel: undefined }))).toContain('channel')
    expect(
      pathsOf(manifest({ channel: { label: 'A', commandsUrl: 'https://acme.com/c' } }))
    ).toContain('channel')
    expect(pathsOf(manifest({ capabilities: ['text'] }))).toContain('capabilities')
  })

  it('needs both channel scopes', () => {
    expect(refused(channelManifest({ scopes: [PluginScopes.CHANNEL_EVENTS] }))).toBe(true)
    expect(refused(channelManifest({ scopes: [PluginScopes.CHANNEL_CONNECTIONS] }))).toBe(true)
    expect(refused(channelManifest({ scopes: [] }))).toBe(true)
  })

  it('keeps the two channel scopes from an integration plugin', () => {
    expect(refused(manifest({ scopes: [PluginScopes.CHANNEL_EVENTS] }))).toBe(true)
    expect(refused(manifest({ scopes: [PluginScopes.CHANNEL_CONNECTIONS] }))).toBe(true)
  })

  it('may ask for other scopes besides the two', () => {
    expect(
      pluginManifestSchema.safeParse(
        channelManifest({
          scopes: [
            PluginScopes.CHANNEL_CONNECTIONS,
            PluginScopes.CHANNEL_EVENTS,
            PluginScopes.CONVERSATIONS_READ
          ]
        })
      ).success
    ).toBe(true)
  })

  describe('a commands url on this machine, for the suites (PLUGIN_ALLOW_LOCAL_COMMANDS_URL)', () => {
    afterEach(() => {
      allowLocalCommandsUrl({ nodeEnv: 'test', flag: false })
    })
    const local = (url: string) =>
      refused(channelManifest({ channel: { label: 'Acme Chat', commandsUrl: url } }))

    it('is refused by default', () => {
      expect(local('http://localhost:4000/commands')).toBe(true)
    })

    it('is accepted with NODE_ENV=test and the switch on, and a private address is not', () => {
      allowLocalCommandsUrl({ nodeEnv: 'test', flag: true })
      expect(local('http://localhost:4000/commands')).toBe(false)
      expect(local('http://127.0.0.1:4000/commands')).toBe(false)
      expect(local('http://10.0.0.5/commands')).toBe(true)
    })

    it.each(['production', 'staging', 'development'])(
      'is still refused in %s, even with the switch on',
      nodeEnv => {
        allowLocalCommandsUrl({ nodeEnv, flag: true })
        expect(local('http://localhost:4000/commands')).toBe(true)
        expect(local('http://127.0.0.1:4000/commands')).toBe(true)
      }
    )
  })

  it.each(Object.values(ChannelIds))('refuses the id of the official channel %s', id => {
    expect(pathsOf(channelManifest({ id }))).toContain('id')
  })

  it.each([
    [
      'a label of more than the limit',
      { label: 'x'.repeat(ChannelManifestLimits.LABEL_MAX_LENGTH + 1) }
    ],
    ['an empty label', { label: '' }],
    ['a label with markup', { label: '<b>Acme</b>' }],
    ['a label on two lines', { label: 'Acme\nChat' }],
    ['a commands url that is not https', { commandsUrl: 'http://acme.com/c' }],
    ['a commands url on the private network', { commandsUrl: 'https://10.0.0.5/c' }],
    ['a commands url with credentials', { commandsUrl: 'https://user:pass@acme.com/c' }],
    ['a commands url on localhost', { commandsUrl: 'https://localhost/c' }],
    ['a window of zero hours', { messagingWindow: { hours: 0 } }],
    [
      'a window beyond the ceiling',
      { messagingWindow: { hours: ChannelManifestLimits.MAX_WINDOW_HOURS + 1 } }
    ],
    ['a window of fractions of an hour', { messagingWindow: { hours: 1.5 } }],
    [
      'a window that wants templates',
      { messagingWindow: { hours: 24, requiresTemplateWhenClosed: true } }
    ],
    ['an unknown key', { album: { kinds: ['image'], maxFiles: 10 } }]
  ])('refuses %s', (_name, block) => {
    expect(
      refused(
        channelManifest({
          channel: {
            label: 'Acme Chat',
            commandsUrl: 'https://acme.com/platform/commands',
            ...block
          }
        })
      )
    ).toBe(true)
  })

  it('accepts the window at its two bounds', () => {
    for (const hours of [
      ChannelManifestLimits.MIN_WINDOW_HOURS,
      ChannelManifestLimits.MAX_WINDOW_HOURS
    ]) {
      expect(
        pluginManifestSchema.safeParse(
          channelManifest({
            channel: {
              label: 'Acme Chat',
              commandsUrl: 'https://acme.com/platform/commands',
              messagingWindow: { hours }
            }
          })
        ).success
      ).toBe(true)
    }
  })

  describe('the connection fields', () => {
    const withFields = (connectFields: unknown) =>
      channelManifest({
        channel: {
          label: 'Acme Chat',
          commandsUrl: 'https://acme.com/platform/commands',
          connectFields
        }
      })
    const field = (over: Record<string, unknown> = {}) => ({
      key: 'accountName',
      label: { es: 'Nombre de la cuenta', en: 'Account name' },
      secret: false,
      required: true,
      multiple: false,
      ...over
    })

    it('keeps the label of each field in both languages', () => {
      const parsed = pluginManifestSchema.parse(withFields([field()]))
      expect(parsed.channel?.connectFields?.[0]?.label).toEqual({
        es: 'Nombre de la cuenta',
        en: 'Account name'
      })
    })

    it.each([
      ['a label in one language', field({ label: { en: 'Account name' } })],
      ['a label that is a message key', field({ label: 'channels.fields.token' })],
      ['a label with markup', field({ label: { es: '<i>Nombre</i>', en: 'Name' } })],
      ['a label with a control character', field({ label: { es: 'Nombre\u0000', en: 'Name' } })],
      [
        'a label past the limit',
        field({
          label: {
            es: 'x'.repeat(PluginManifestLimits.FIELD_LABEL_MAX_LENGTH + 1),
            en: 'Name'
          }
        })
      ],
      ['a label key beside the text', field({ labelKey: 'channels.fields.token' })],
      ['a key that is not an identifier', field({ key: '1 bad' })],
      ['a key the platform reserves', field({ key: 'constructor' })],
      ['a key longer than the limit', field({ key: `a${'b'.repeat(64)}` })],
      ['a field flag that is not a boolean', field({ secret: 'yes' })],
      ['a field with a flag missing', field({ required: undefined })]
    ])('refuses %s', (_name, bad) => {
      expect(refused(withFields([bad]))).toBe(true)
    })

    it('refuses a repeated key and more fields than the limit', () => {
      expect(refused(withFields([field(), field()]))).toBe(true)
      const many = Array.from({ length: ChannelConnectFieldLimits.MAX_FIELDS + 1 }, (_, index) =>
        field({ key: `k${index}` })
      )
      expect(refused(withFields(many))).toBe(true)
      expect(refused(withFields(many.slice(0, ChannelConnectFieldLimits.MAX_FIELDS)))).toBe(false)
    })
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

describe('manifestWebhookOf', () => {
  it('reads the events and the signature header of a stored manifest', () => {
    expect(
      manifestWebhookOf({
        webhooks: {
          endpoint: 'https://acme.example/hook',
          events: ['message.received', 7, 'order.created'],
          signatureHeader: 'X-Acme-Signature'
        }
      })
    ).toEqual({
      events: ['message.received', 'order.created'],
      signatureHeader: 'X-Acme-Signature'
    })
  })

  it('reads nothing from a manifest with no webhooks, a damaged block or a header the transport owns', () => {
    expect(manifestWebhookOf(null)).toBeNull()
    expect(manifestWebhookOf({})).toBeNull()
    expect(manifestWebhookOf({ webhooks: 'x' })).toBeNull()
    expect(manifestWebhookOf({ webhooks: { events: 'a', signatureHeader: 'X-A' } })).toBeNull()
    expect(
      manifestWebhookOf({ webhooks: { events: ['order.created'], signatureHeader: 'Host' } })
    ).toBeNull()
    expect(
      manifestWebhookOf({ webhooks: { events: ['order.created'], signatureHeader: 'a b' } })
    ).toBeNull()
  })
})

describe('the webhooks block of the manifest', () => {
  const base = (webhooks: Record<string, unknown>) => ({
    ...manifest(),
    webhooks: { endpoint: 'https://acme.example/hook', ...webhooks }
  })

  it('refuses a signature header the platform sets on every delivery, in any case', () => {
    for (const signatureHeader of ['X-Platform-Event', 'x-platform-delivery']) {
      const result = pluginManifestSchema.safeParse(
        base({ events: [Events.ORDER_CREATED], signatureHeader })
      )
      expect(result.success).toBe(false)
      expect(
        manifestWebhookOf({ webhooks: { events: [Events.ORDER_CREATED], signatureHeader } })
      ).toBeNull()
    }
  })

  it('refuses an event a plugin is never sent: the revocation, a channel event', () => {
    for (const event of [Events.PLUGIN_REVOKED, Events.CHANNEL_DISCONNECTED]) {
      const result = pluginManifestSchema.safeParse(
        base({ events: [event], signatureHeader: 'X-Sig' })
      )
      expect(result.success).toBe(false)
    }
  })

  it('accepts the events of a return, which a plugin follows through returns:read', () => {
    const webhooks = {
      endpoint: 'https://acme.com/webhooks/platform',
      events: [Events.RETURN_REQUESTED],
      signatureHeader: 'X-Platform-Signature'
    }

    expect(
      pluginManifestSchema.safeParse(
        manifest({ scopes: [PluginScopes.RETURNS_READ, PluginScopes.WEBHOOKS_WRITE], webhooks })
      ).success
    ).toBe(true)
  })
})
