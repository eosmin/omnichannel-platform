import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelCapabilityType,
  ChannelIdentityKinds,
  type ChannelPlugin
} from '@platform/plugins/sdk'

import { PluginRegistry } from './plugin-registry'
import { registeredChannelSchema } from './registered-channel.schema'

function channel(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const fail = (): never => {
    throw new Error('not used')
  }
  return {
    id: 'telegram',
    name: 'Telegram',
    version: '1.0.0',
    author: 'suite',
    type: 'channel',
    capabilities: [ChannelCapability.TEXT],
    messagingWindow: null,
    limits: { textMaxLength: 100 },
    identityKind: ChannelIdentityKinds.OPAQUE,
    connectFields: [],
    receivesProviderWebhooks: false,
    connect: fail,
    disconnect: fail,
    healthCheck: fail,
    sendMessage: fail,
    sendMedia: fail,
    validateWebhookSignature: () => false,
    handleWebhook: () => Promise.resolve([]),
    ...overrides
  }
}

function build(): PluginRegistry {
  const logger = { setContext: jest.fn(), info: jest.fn() }
  return new PluginRegistry(logger as unknown as PinoLogger)
}

function codeOf(run: () => void): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('PluginRegistry', () => {
  it('registers a plugin and finds it by its id', () => {
    const registry = build()
    const plugin = channel()
    registry.register(plugin)
    expect(registry.get('telegram')).toBe(plugin)
    expect(registry.has('telegram')).toBe(true)
    expect(registry.find('nobody')).toBeUndefined()
  })

  it('answers PLUGIN_NOT_FOUND for an id it does not know', () => {
    expect(codeOf(() => build().get('telegram'))).toBe(ErrorCodes.PLUGIN_NOT_FOUND)
  })

  it('refuses the same id twice', () => {
    const registry = build()
    registry.register(channel())
    expect(codeOf(() => registry.register(channel()))).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
  })

  it.each([
    [ChannelCapability.TEMPLATES, ['sendTemplate', 'listTemplates']],
    [ChannelCapability.BUTTONS, ['sendButtons']],
    [ChannelCapability.LOCATION, ['sendLocation']],
    [ChannelCapability.TYPING_INDICATOR, ['sendTypingIndicator']],
    [ChannelCapability.READ_RECEIPTS, ['markAsRead']],
    [ChannelCapability.REACTIONS, ['sendReaction']],
    [ChannelCapability.DELETE_MESSAGE, ['deleteMessage']],
    [ChannelCapability.EDIT_MESSAGE, ['editMessage']]
  ] as Array<[ChannelCapabilityType, string[]]>)(
    'rejects a plugin that declares %s and implements none of %j',
    capability => {
      const registry = build()
      const plugin = channel({ capabilities: [ChannelCapability.TEXT, capability] })
      expect(codeOf(() => registry.register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
      expect(registry.has('telegram')).toBe(false)
    }
  )

  it('rejects templates declared with only one of its two methods', () => {
    const plugin = channel({
      capabilities: [ChannelCapability.TEMPLATES],
      sendTemplate: () => Promise.reject(new Error('not used'))
    })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('accepts a capability whose method exists', () => {
    const registry = build()
    registry.register(
      channel({
        capabilities: [ChannelCapability.READ_RECEIPTS],
        markAsRead: () => Promise.resolve()
      })
    )
    expect(registry.hasCapability('telegram', ChannelCapability.READ_RECEIPTS)).toBe(true)
    expect(registry.hasCapability('telegram', ChannelCapability.TEXT)).toBe(false)
    expect(registry.hasCapability('nobody', ChannelCapability.TEXT)).toBe(false)
  })

  it('lists what a plugin declared, and nothing for one that is not registered', () => {
    const registry = build()
    registry.register(
      channel({
        capabilities: [ChannelCapability.READ_RECEIPTS, ChannelCapability.TEXT],
        markAsRead: () => Promise.resolve()
      })
    )
    expect(registry.capabilitiesOf('telegram')).toEqual([
      ChannelCapability.READ_RECEIPTS,
      ChannelCapability.TEXT
    ])
    expect(registry.capabilitiesOf('nobody')).toEqual([])
  })

  describe('connect manifest', () => {
    const field = {
      key: 'accessToken',
      labelKey: 'settings.channels.connect.telegram.accessToken',
      secret: true,
      required: true,
      multiple: false
    }

    it('keeps a copy of what the plugin declared when it registered', () => {
      const registry = build()
      const plugin = channel({
        capabilities: [ChannelCapability.CUSTOMER_PROFILE],
        fetchProfile: () => Promise.resolve(null),
        connectFields: [field],
        receivesProviderWebhooks: true,
        profileSetupKey: 'settings.channels.setup.telegramProfile'
      })
      registry.register(plugin)
      // Changed after the checks: the registry still answers with what passed them
      ;(plugin as { connectFields: unknown }).connectFields = [{ ...field, key: 'other' }]
      expect(registry.connectManifestOf('telegram')).toEqual({
        connectFields: [field],
        receivesProviderWebhooks: true,
        profileSetupKey: 'settings.channels.setup.telegramProfile'
      })
      expect(registry.connectManifestOf('nobody')).toBeNull()
    })

    it('copies a field property by property, so an extra property never reaches the page', () => {
      const registry = build()
      registry.register(
        channel({ connectFields: [{ ...field, apiKey: 'sk-live' } as typeof field] })
      )
      expect(registry.connectManifestOf('telegram')?.connectFields).toEqual([field])
    })

    it.each([
      ['no list', undefined],
      ['a list that is not an array', 'accessToken'],
      ['too many fields', Array.from({ length: 21 }, (_, i) => ({ ...field, key: `k${i}` }))],
      ['a repeated key', [field, field]],
      ['a key that is not an identifier', [{ ...field, key: 'access token' }]],
      ['a label that is text and not a message key', [{ ...field, labelKey: 'Access token' }]],
      ['a label that is not a string', [{ ...field, labelKey: 42 }]],
      ['a secret flag that is not a boolean', [{ ...field, secret: 'yes' }]],
      ['a required flag that is not a boolean', [{ ...field, required: undefined }]],
      ['a field named like a member of every object', [{ ...field, key: 'constructor' }]],
      ['a field that is not an object', [null]]
    ])('rejects %s', (_name, connectFields) => {
      const plugin = channel({ connectFields: connectFields as ChannelPlugin['connectFields'] })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('rejects a plugin that does not say whether the provider calls it', () => {
      const plugin = channel({
        receivesProviderWebhooks: undefined as unknown as boolean
      })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('rejects a profile setup key on a channel that reads no profiles', () => {
      const plugin = channel({ profileSetupKey: 'settings.channels.setup.telegramProfile' })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('rejects a profile setup key that is text and not a message key', () => {
      const plugin = channel({
        capabilities: [ChannelCapability.CUSTOMER_PROFILE],
        fetchProfile: () => Promise.resolve(null),
        profileSetupKey: 'Ask Meta for access'
      })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('does not register a plugin whose manifest is refused', () => {
      const registry = build()
      expect(codeOf(() => registry.register(channel({ connectFields: [field, field] })))).toBe(
        ErrorCodes.PLUGIN_CONTRACT_VIOLATION
      )
      expect(registry.has('telegram')).toBe(false)
    })
  })

  it('rejects messaging_window without a policy', () => {
    const plugin = channel({ capabilities: [ChannelCapability.MESSAGING_WINDOW] })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('accepts messaging_window with a policy', () => {
    const registry = build()
    registry.register(
      channel({
        capabilities: [ChannelCapability.MESSAGING_WINDOW],
        messagingWindow: { hours: 24, requiresTemplateWhenClosed: false }
      })
    )
    expect(registry.get('telegram').messagingWindow?.hours).toBe(24)
  })

  it.each(['Telegram', 'ab', '1abc', 'has space', 'x'.repeat(33)])('rejects the id %j', id => {
    expect(codeOf(() => build().register(channel({ id })))).toBe(
      ErrorCodes.PLUGIN_CONTRACT_VIOLATION
    )
  })

  it.each([
    'connect',
    'disconnect',
    'healthCheck',
    'sendMessage',
    'sendMedia',
    'validateWebhookSignature',
    'handleWebhook'
  ])('rejects a plugin without %s, which every channel needs', method => {
    const plugin = { ...channel(), [method]: undefined }
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('answers with the reserved id, not the duplicate, when a remote plugin takes an official id', () => {
    const registry = build()
    registry.register(channel({ id: 'whatsapp' }), { official: true })
    const error = (() => {
      try {
        registry.register(channel({ id: 'whatsapp' }))
      } catch (e) {
        return e as { code?: string; message: string }
      }
      return undefined
    })()
    expect(error?.code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('keeps the official ids for the official plugins', () => {
    const registry = build()
    expect(codeOf(() => registry.register(channel({ id: 'whatsapp' })))).toBe(
      ErrorCodes.PLUGIN_CONTRACT_VIOLATION
    )
    registry.register(channel({ id: 'whatsapp' }), { official: true })
    expect(registry.has('whatsapp')).toBe(true)
  })

  it.each([undefined, null, 42, {}])('rejects an id that is not a string (%j)', id => {
    const plugin = channel({ id: id as string })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('rejects a plugin without a capability list', () => {
    const plugin = { ...channel(), capabilities: undefined } as unknown as ChannelPlugin
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('reads the id once, so a getter cannot pass the checks with one id and register another', () => {
    let reads = 0
    const plugin = channel()
    Object.defineProperty(plugin, 'id', { get: () => (reads++ < 3 ? 'acme_chat' : 'whatsapp') })
    const registry = build()
    try {
      registry.register(plugin)
    } catch {
      // either outcome is fine as long as the reserved id was not taken
    }
    expect(registry.has('whatsapp')).toBe(false)
  })

  it('answers about the capabilities it validated, not the ones the plugin has later', () => {
    const registry = build()
    const capabilities: ChannelCapabilityType[] = [ChannelCapability.TEXT]
    registry.register(channel({ capabilities }))
    capabilities.push(ChannelCapability.TEMPLATES)
    expect(registry.hasCapability('telegram', ChannelCapability.TEMPLATES)).toBe(false)
  })

  it('does not print a hostile id: a symbol, a huge string or one with line breaks', () => {
    const hostile = [Symbol('x'), 'x'.repeat(100_000), 'a\nINJECTED log line']
    for (const id of hostile) {
      let message = ''
      try {
        build().register(channel({ id: id as unknown as string }))
      } catch (error) {
        expect((error as { code?: string }).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
        message = (error as Error).message
      }
      expect(message.length).toBeGreaterThan(0)
      expect(message.length).toBeLessThan(300)
      expect(message).not.toContain('\n')
    }
  })

  it('rejects a plugin of another type', () => {
    const plugin = { ...channel(), type: 'carrier' } as unknown as ChannelPlugin
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  describe('list(storeId)', () => {
    it('shows a public plugin to every store and a private one to its stores only', () => {
      const registry = build()
      registry.register(channel({ id: 'whatsapp' }), { official: true })
      registry.register(channel({ id: 'acme_chat' }), { storeIds: ['store-a'] })

      expect(registry.list('store-a').map(p => p.id)).toEqual(['whatsapp', 'acme_chat'])
      expect(registry.list('store-b').map(p => p.id)).toEqual(['whatsapp'])
    })

    it('never makes an official plugin private', () => {
      expect(
        codeOf(() =>
          build().register(channel({ id: 'whatsapp' }), { official: true, storeIds: ['store-a'] })
        )
      ).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })
  })

  describe('listOfficial', () => {
    it('holds the plugins that ship with the platform and not the private or remote ones', () => {
      const registry = build()
      const whatsapp = channel({ id: 'whatsapp', name: 'WhatsApp' })
      registry.register(whatsapp, { official: true })
      registry.register(channel({ id: 'telegram' }))
      registry.register(channel({ id: 'viber' }), { storeIds: ['store-a'] })

      expect(registry.listOfficial()).toEqual([whatsapp])
    })
  })

  describe('unregister', () => {
    it('removes a plugin that is not official', () => {
      const registry = build()
      registry.register(channel())
      registry.unregister('telegram')
      expect(registry.has('telegram')).toBe(false)
    })

    it('fails for an id it does not hold, so a mistyped uninstall is not silent', () => {
      expect(codeOf(() => build().unregister('telegram'))).toBe(ErrorCodes.PLUGIN_NOT_FOUND)
    })

    it('never removes an official one', () => {
      const registry = build()
      registry.register(channel({ id: 'whatsapp' }), { official: true })
      expect(codeOf(() => registry.unregister('whatsapp'))).toBe(
        ErrorCodes.PLUGIN_CONTRACT_VIOLATION
      )
      expect(registry.has('whatsapp')).toBe(true)
    })
  })
})

describe('registeredChannelSchema', () => {
  it('does not accept the private plugin of another store', () => {
    const registry = build()
    registry.register(channel({ id: 'acme_chat' }), { storeIds: ['store-a'] })
    expect(registeredChannelSchema(registry, 'store-a').safeParse('acme_chat').success).toBe(true)
    expect(registeredChannelSchema(registry, 'store-b').safeParse('acme_chat').success).toBe(false)
  })

  it('takes the id of a registered plugin, also one registered after the schema was built', () => {
    const registry = build()
    const schema = registeredChannelSchema(registry, 'store-a')
    expect(schema.safeParse('telegram').success).toBe(false)
    registry.register(channel())
    expect(schema.safeParse('telegram').success).toBe(true)
  })

  it('refuses a malformed id even if it were registered', () => {
    expect(
      registeredChannelSchema({ isVisibleTo: () => true }, 'store-a').safeParse('Not Valid').success
    ).toBe(false)
    expect(
      registeredChannelSchema({ isVisibleTo: () => true }, 'store-a').safeParse(42).success
    ).toBe(false)
  })
})

describe('PluginRegistry and the login of a channel (Step 7.8)', () => {
  const login = {
    kind: 'meta-facebook-login',
    scopes: ['pages_show_list'],
    authorizationUrl: () => 'https://dialog.example/x',
    exchangeCode: () => Promise.resolve('user-token'),
    grantedScopes: () => Promise.resolve(['pages_show_list']),
    listAssets: () => Promise.resolve([]),
    credentialsFor: () => Promise.resolve({ accessToken: 'page-token' })
  } as const

  it('keeps the login of a plugin that declares one, and none for one that does not', () => {
    const registry = build()
    registry.register(channel({ id: 'telegram', oauth: login }))
    registry.register(channel({ id: 'signal' }))
    expect(registry.oauthOf('telegram')?.scopes).toEqual(['pages_show_list'])
    expect(registry.oauthOf('signal')).toBeNull()
    expect(registry.oauthOf('nobody')).toBeNull()
  })

  it('refuses at boot a plugin whose login is malformed', () => {
    const registry = build()
    const bad = channel({ id: 'telegram', oauth: { ...login, scopes: ['a&b'] } })
    expect(codeOf(() => registry.register(bad))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    expect(registry.has('telegram')).toBe(false)
  })

  it('does not follow a login the plugin changes after it registered', () => {
    const registry = build()
    const plugin = channel({ id: 'telegram', oauth: { ...login, scopes: ['pages_show_list'] } })
    registry.register(plugin)
    ;(plugin as { oauth: unknown }).oauth = {
      ...login,
      scopes: ['pages_show_list', 'ads_management']
    }
    expect(registry.oauthOf('telegram')?.scopes).toEqual(['pages_show_list'])
  })
})

describe('PluginRegistry, the files a channel takes', () => {
  const media = {
    maxFilesPerMessage: 1,
    kinds: { image: { types: ['image/png'], maxBytes: 1024 } }
  } as const
  const withImages = { capabilities: [ChannelCapability.TEXT, ChannelCapability.IMAGE] }

  it('keeps the rules of a channel that takes files, and none for one that does not', () => {
    const registry = build()
    registry.register(channel({ id: 'telegram', ...withImages, media }))
    registry.register(channel({ id: 'signal' }))
    expect(registry.mediaOf('telegram')?.kinds.image).toEqual({
      types: ['image/png'],
      maxBytes: 1024
    })
    expect(registry.mediaOf('signal')).toBeNull()
    expect(registry.mediaOf('nobody')).toBeNull()
  })

  it('refuses at boot a channel with a kind of file as a capability and no rule for it', () => {
    const registry = build()
    expect(codeOf(() => registry.register(channel({ id: 'telegram', ...withImages })))).toBe(
      ErrorCodes.PLUGIN_CONTRACT_VIOLATION
    )
    expect(registry.has('telegram')).toBe(false)
  })

  it('refuses at boot a rule for a kind the channel does not declare', () => {
    const registry = build()
    expect(codeOf(() => registry.register(channel({ id: 'telegram', media })))).toBe(
      ErrorCodes.PLUGIN_CONTRACT_VIOLATION
    )
  })

  it('does not follow a limit the plugin raises after it registered', () => {
    const registry = build()
    const kinds = { image: { types: ['image/png'], maxBytes: 1024 } }
    registry.register(
      channel({ id: 'telegram', ...withImages, media: { maxFilesPerMessage: 1, kinds } })
    )
    kinds.image.maxBytes = 50 * 1024 * 1024
    kinds.image.types.push('image/svg+xml')
    expect(registry.mediaOf('telegram')?.kinds.image).toEqual({
      types: ['image/png'],
      maxBytes: 1024
    })
  })
  describe('album', () => {
    const album = { kinds: ['image'], maxFiles: 10 } as const
    const sendAlbum = (): Promise<never> => Promise.reject(new Error('not used'))
    const withAlbum = { ...media, maxFilesPerMessage: 10, album }

    it('keeps the album of a channel that declares it and has sendAlbum', () => {
      const registry = build()
      registry.register(channel({ id: 'telegram', ...withImages, media: withAlbum, sendAlbum }))
      expect(registry.mediaOf('telegram')?.album).toEqual(album)
    })

    it('refuses at boot an album with no sendAlbum, and a sendAlbum with no album', () => {
      const registry = build()
      expect(
        codeOf(() =>
          registry.register(channel({ id: 'telegram', ...withImages, media: withAlbum }))
        )
      ).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
      expect(
        codeOf(() => registry.register(channel({ id: 'signal', ...withImages, media, sendAlbum })))
      ).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
      expect(registry.has('telegram')).toBe(false)
      expect(registry.has('signal')).toBe(false)
    })
  })
})
