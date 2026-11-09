import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { ChannelCapability, ChannelIdentityKinds, type ChannelPlugin } from '@platform/plugins/sdk'

import { PluginRegistry } from './plugin-registry'

// The descriptor of the third-party toy plugin: what the web draws a channel from, with no channel named in
// core, api or web. A third party wrote it, so every part is held to a shape at boot and refused otherwise.
const TOY_ID = 'acme_chat'

function toy(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const fail = (): never => {
    throw new Error('not used')
  }
  return {
    id: TOY_ID,
    name: 'Acme Chat',
    version: '1.0.0',
    author: 'acme',
    type: 'channel',
    capabilities: [ChannelCapability.TEXT],
    messagingWindow: null,
    limits: { textMaxLength: 500 },
    identityKind: ChannelIdentityKinds.OPAQUE,
    connectFields: [
      {
        key: 'apiKey',
        label: { es: 'Clave de Acme', en: 'Acme API key' },
        secret: true,
        required: true,
        multiple: false
      }
    ],
    receivesProviderWebhooks: true,
    displayName: { es: 'Acme Chat', en: 'Acme Chat' },
    iconKey: 'message-square',
    imageHosts: { avatar: ['https://img.acme.test'], media: [] },
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

function refusal(plugin: ChannelPlugin): unknown {
  try {
    registry().register(plugin)
  } catch (error) {
    return error
  }
  return null
}

describe('the descriptor of a plugin nobody named', () => {
  it('keeps what it declared, and the field labels as text of its own', () => {
    const plugins = registry()
    plugins.register(toy({ anonymousCustomers: true, managementSurface: 'embed_snippet' }))

    expect(plugins.descriptorOf(TOY_ID)).toEqual({
      displayName: { es: 'Acme Chat', en: 'Acme Chat' },
      iconKey: 'message-square',
      anonymousCustomers: true,
      managementSurface: 'embed_snippet',
      helpSteps: [],
      imageHosts: { avatar: ['https://img.acme.test'], media: [] }
    })
    expect(plugins.connectManifestOf(TOY_ID)?.connectFields[0]).toMatchObject({
      key: 'apiKey',
      labelKey: null,
      label: { es: 'Clave de Acme', en: 'Acme API key' },
      secret: true
    })
  })

  it('names itself by its name, with a generic icon, when it declares nothing', () => {
    const plugins = registry()
    plugins.register(toy({ displayName: undefined, iconKey: undefined, imageHosts: undefined }))
    expect(plugins.descriptorOf(TOY_ID)).toEqual({
      displayName: { es: 'Acme Chat', en: 'Acme Chat' },
      iconKey: 'message-square',
      anonymousCustomers: false,
      managementSurface: null,
      helpSteps: [],
      imageHosts: { avatar: [], media: [] }
    })
  })

  it('is named by its id when its name is not plain text: the name was never held to a shape', () => {
    const plugins = registry()
    plugins.register(toy({ displayName: undefined, name: 'Acme <b>Chat</b>' }))
    expect(plugins.descriptorOf(TOY_ID)?.displayName).toEqual({ es: TOY_ID, en: TOY_ID })
  })

  it('answers nothing for a plugin that is not registered', () => {
    expect(registry().descriptorOf(TOY_ID)).toBeNull()
  })

  const hostile: [string, Partial<ChannelPlugin>][] = [
    ['a name with markup', { displayName: { es: 'Acme <b>', en: 'Acme' } }],
    ['a name with a link', { displayName: { es: 'Acme', en: 'see https://evil.test' } }],
    ['a name in markdown', { displayName: { es: 'Acme', en: '[x](javascript:alert(1))' } }],
    ['a name with a line break', { displayName: { es: 'Acme\nChat', en: 'Acme' } }],
    ['a name with an interpolation', { displayName: { es: '{x}', en: 'Acme' } }],
    ['a name too long', { displayName: { es: 'a'.repeat(81), en: 'Acme' } }],
    ['a name missing a language', { displayName: { es: 'Acme' } as never }],
    ['an empty name', { displayName: { es: ' ', en: 'Acme' } }],
    ['a name that is a braille blank', { displayName: { es: '\u2800', en: 'Acme' } }],
    ['a name with a hangul filler', { displayName: { es: 'Acme', en: '\u3164' } }],
    ['a name with a no-break space', { displayName: { es: 'Acme\u00a0Chat', en: 'Acme' } }],
    ['a name with no letter or digit', { displayName: { es: '...', en: 'Acme' } }],
    ['a name that is a bare domain', { displayName: { es: 'evil.com', en: 'Acme' } }],
    ['a help step with a mailto', { connectHelp: [{ es: 'escribe a mailto:x', en: 'write' }] }],
    ['a help step that is huge', { connectHelp: [{ es: 'a'.repeat(5_000_000), en: 'x' }] }],
    ['a list of help steps that is huge', { connectHelp: { length: 2 ** 32 - 1 } as never }],
    [
      'a list of hosts that is huge',
      { imageHosts: { avatar: { length: 2 ** 32 - 1 } as never, media: [] } }
    ],
    [
      'a field named by a key and by a text',
      {
        connectFields: [
          {
            key: 'a',
            labelKey: 'settings.channels.connect.acme.a',
            label: { es: 'a', en: 'a' },
            secret: false,
            required: true,
            multiple: false
          }
        ]
      }
    ],
    [
      'an image host on a private network',
      { imageHosts: { avatar: ['https://img.corp.internal'], media: [] } }
    ],
    ['an icon outside the closed set', { iconKey: 'skull' as never }],
    ['an icon with a path', { iconKey: '../../x' as never }],
    ['a surface that does not exist', { managementSurface: 'iframe' as never }],
    ['an anonymous flag that is not a boolean', { anonymousCustomers: 'yes' as never }],
    [
      'a field with neither key nor label',
      {
        connectFields: [{ key: 'a', secret: false, required: true, multiple: false }]
      }
    ],
    [
      'a field label with markup',
      {
        connectFields: [
          {
            key: 'a',
            label: { es: '<img src=x>', en: 'a' },
            secret: false,
            required: true,
            multiple: false
          }
        ]
      }
    ],
    ['a help step with a link', { connectHelp: [{ es: 'abre https://evil.test', en: 'open it' }] }],
    [
      'too many help steps',
      {
        connectHelp: Array.from({ length: 9 }, () => ({ es: 'paso', en: 'step' }))
      }
    ],
    [
      'an image host with a wildcard for everything',
      { imageHosts: { avatar: ['https://*'], media: [] } }
    ],
    [
      'an image host that is plain http',
      { imageHosts: { avatar: ['http://img.acme.test'], media: [] } }
    ],
    [
      'an image host with a port',
      { imageHosts: { avatar: ['https://img.acme.test:8443'], media: [] } }
    ],
    [
      'an image host with credentials',
      { imageHosts: { avatar: ['https://u:p@img.acme.test'], media: [] } }
    ],
    [
      'an image host with a path',
      { imageHosts: { avatar: ['https://img.acme.test/x'], media: [] } }
    ],
    [
      'an image host in the middle of a wildcard',
      { imageHosts: { avatar: ['https://img.*.acme.test'], media: [] } }
    ],
    [
      'an image host that is a bare top level domain',
      { imageHosts: { avatar: ['https://*.com'], media: [] } }
    ],
    [
      'an image host with an uppercase letter',
      { imageHosts: { avatar: ['https://IMG.acme.test'], media: [] } }
    ],
    [
      'an image host that is an address',
      { imageHosts: { avatar: ['https://127.0.0.1'], media: [] } }
    ],
    [
      'too many image hosts',
      {
        imageHosts: {
          avatar: Array.from({ length: 9 }, (_, i) => `https://h${i}.acme.test`),
          media: []
        }
      }
    ],
    [
      'an image host that is a script',
      { imageHosts: { avatar: ['https://x.test; script-src *'], media: [] } }
    ]
  ]
  it.each(hostile)('refuses %s at boot', (_name, overrides) => {
    const error = refusal(toy(overrides))
    expect(error).toBeInstanceOf(PlatformException)
    expect((error as PlatformException).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('takes a wildcard for the subdomains of a host from an official plugin only', () => {
    const hosts = { avatar: ['https://*.cdn.acme.test'], media: ['https://img.acme.test'] }
    const official = registry()
    official.register(toy({ imageHosts: hosts }), { official: true })
    expect(official.descriptorOf(TOY_ID)?.imageHosts).toEqual(hosts)
    // A host that many tenants share must never be widened to all of them by a third party
    for (const shared of ['https://*.github.io', 'https://*.s3.amazonaws.com', 'https://*.co.uk']) {
      const error = refusal(toy({ imageHosts: { avatar: [shared], media: [] } }))
      expect((error as PlatformException).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    }
  })

  it('is frozen: nobody who asks the registry can change what it kept', () => {
    const plugins = registry()
    plugins.register(toy())
    const kept = plugins.descriptorOf(TOY_ID)
    expect(Object.isFrozen(kept)).toBe(true)
    expect(Object.isFrozen(kept?.displayName)).toBe(true)
    expect(Object.isFrozen(kept?.imageHosts.avatar)).toBe(true)
  })

  it('does not follow a plugin that edits its declaration after it registered', () => {
    const plugins = registry()
    const hosts = { avatar: ['https://img.acme.test'], media: [] as string[] }
    plugins.register(toy({ imageHosts: hosts }))
    hosts.avatar.push('https://evil.test')
    expect(plugins.descriptorOf(TOY_ID)?.imageHosts.avatar).toEqual(['https://img.acme.test'])
  })
})
