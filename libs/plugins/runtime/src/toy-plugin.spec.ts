import type { PinoLogger } from 'nestjs-pino'

import { MessageType } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { ChannelCapability, ChannelIdentityKinds, type ChannelPlugin } from '@platform/plugins/sdk'

import { PluginRegistry } from './plugin-registry'

// The third-party toy plugin: an id that no file of the platform names. Everything the core, the api and the
// web need to know about it has to come from what it declares (TDD_10 §6.7.2). This suite is the lock: it grows
// with each step of the channel-agnostic refactor, and a step that needs the core to learn the name of
// a channel fails here.
const TOY_ID = 'acme_chat'

function toyPlugin(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const fail = (): never => {
    throw new Error('not used')
  }
  return {
    id: TOY_ID,
    name: 'Acme Chat',
    version: '1.0.0',
    author: 'acme',
    type: 'channel',
    capabilities: [ChannelCapability.TEXT, ChannelCapability.REACTIONS],
    messagingWindow: null,
    connectFields: [],
    receivesProviderWebhooks: true,
    limits: { textMaxLength: 500 },
    identityKind: ChannelIdentityKinds.OPAQUE,
    sendReaction: () => Promise.resolve(),
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

function registry(): PluginRegistry {
  const logger = { setContext: jest.fn(), info: jest.fn() }
  return new PluginRegistry(logger as unknown as PinoLogger)
}

describe('a plugin of a third party that the platform has never heard of', () => {
  it('declares the longest text it takes, and the registry says it back', () => {
    const plugins = registry()
    plugins.register(toyPlugin())
    expect(plugins.limitsOf(TOY_ID)).toEqual({ textMaxLength: 500, caption: null })
    expect(plugins.identityKindOf(TOY_ID)).toBe(ChannelIdentityKinds.OPAQUE)
  })

  it('declares what it takes under a file and which kinds of file take none', () => {
    const plugins = registry()
    plugins.register(
      toyPlugin({
        limits: {
          textMaxLength: 500,
          caption: { maxLength: 200, withoutCaption: [MessageType.AUDIO] }
        }
      })
    )
    expect(plugins.limitsOf(TOY_ID)?.caption).toEqual({
      maxLength: 200,
      withoutCaption: [MessageType.AUDIO]
    })
  })

  it('takes a caption of null and a caption as long as the text', () => {
    const plugins = registry()
    plugins.register(
      toyPlugin({
        limits: { textMaxLength: 100, caption: null } as unknown as ChannelPlugin['limits']
      })
    )
    expect(plugins.limitsOf(TOY_ID)?.caption).toBeNull()
    const other = registry()
    other.register(
      toyPlugin({
        limits: { textMaxLength: 100, caption: { maxLength: 100, withoutCaption: [] } }
      })
    )
    expect(other.limitsOf(TOY_ID)?.caption?.maxLength).toBe(100)
  })

  it('keeps one copy of the kinds, read once, and nobody can change what it kept', () => {
    const plugins = registry()
    const kinds = [MessageType.AUDIO, MessageType.AUDIO]
    plugins.register(
      toyPlugin({
        limits: { textMaxLength: 100, caption: { maxLength: 50, withoutCaption: kinds } }
      })
    )
    const kept = plugins.limitsOf(TOY_ID)
    expect(kept?.caption?.withoutCaption).toEqual([MessageType.AUDIO])
    expect(Object.isFrozen(kept)).toBe(true)
    expect(Object.isFrozen(kept?.caption)).toBe(true)
    expect(Object.isFrozen(kept?.caption?.withoutCaption)).toBe(true)
    kinds.push(MessageType.VIDEO)
    expect(plugins.limitsOf(TOY_ID)?.caption?.withoutCaption).toEqual([MessageType.AUDIO])
  })

  it('answers nothing for a plugin that is not registered', () => {
    const plugins = registry()
    expect(plugins.limitsOf(TOY_ID)).toBeNull()
    expect(plugins.identityKindOf(TOY_ID)).toBeNull()
  })

  it.each([
    ['no limits', { limits: undefined }],
    ['a text of zero', { limits: { textMaxLength: 0 } }],
    ['a text of a fraction', { limits: { textMaxLength: 1.5 } }],
    ['a text above what the platform stores', { limits: { textMaxLength: 1_000_000 } }],
    [
      'a caption longer than its text',
      { limits: { textMaxLength: 100, caption: { maxLength: 200, withoutCaption: [] } } }
    ],
    [
      'a kind that is not a kind of message',
      {
        limits: {
          textMaxLength: 100,
          caption: { maxLength: 50, withoutCaption: ['bogus' as MessageType] }
        }
      }
    ],
    ['a text limit that is not a number', { limits: { textMaxLength: Number.NaN } }],
    ['a text limit that is infinite', { limits: { textMaxLength: Infinity } }],
    [
      'a kind that carries no caption because it is not a file',
      {
        limits: {
          textMaxLength: 100,
          caption: { maxLength: 50, withoutCaption: [MessageType.TEXT] }
        }
      }
    ],
    [
      'a hole in the kinds without caption',
      {
        limits: {
          textMaxLength: 100,
          // eslint-disable-next-line no-sparse-arrays -- the hostile shape under test
          caption: { maxLength: 50, withoutCaption: [, MessageType.AUDIO] as MessageType[] }
        }
      }
    ],
    ['an identity kind that does not exist', { identityKind: 'phone-ish' }]
  ])('refuses %s at boot', (_name, overrides) => {
    const plugins = registry()
    let refusal: unknown
    try {
      plugins.register(toyPlugin(overrides as Partial<ChannelPlugin>))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(PlatformException)
    expect((refusal as PlatformException).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('is not changed by a plugin that edits its declaration after it registered', () => {
    const plugins = registry()
    const limits = { textMaxLength: 500 }
    plugins.register(toyPlugin({ limits }))
    limits.textMaxLength = 999_999
    expect(plugins.limitsOf(TOY_ID)?.textMaxLength).toBe(500)
  })
})
