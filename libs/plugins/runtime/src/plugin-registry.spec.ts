import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelCapabilityType,
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
    [ChannelCapability.READ_RECEIPTS, ['markAsRead']]
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
