import type { PinoLogger } from 'nestjs-pino'

import { ChannelOAuthKinds } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelOAuth,
  ChannelIdentityKinds,
  type ChannelPlugin
} from '@platform/plugins/sdk'

import { PluginRegistry } from './plugin-registry'

// The login of the third-party toy plugin: the part of its descriptor that the settings page draws a "connect
// with" button and an account picker from. A third party wrote it and an address built from it sends a person
// to another site, so each part is held to a shape at boot.
const TOY_ID = 'acme_chat'
const unused = (): never => {
  throw new Error('not used')
}

function login(overrides: Record<string, unknown> = {}): ChannelOAuth {
  return {
    kind: ChannelOAuthKinds.META_FACEBOOK_LOGIN,
    scopes: ['pages_show_list'],
    redirectUri: null,
    dialogOrigin: 'https://login.acme.test',
    providerName: { es: 'Acme', en: 'Acme' },
    linkedAccount: null,
    assetIdPattern: '^\\d{1,32}$',
    authorizationUrl: unused,
    exchangeCode: unused,
    grantedScopes: unused,
    listAssets: unused,
    credentialsFor: unused,
    ...overrides
  }
}

function toy(oauth: ChannelOAuth | undefined): ChannelPlugin {
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
    connectFields: [],
    receivesProviderWebhooks: true,
    oauth,
    connect: unused,
    disconnect: unused,
    healthCheck: unused,
    sendMessage: unused,
    sendMedia: unused,
    validateWebhookSignature: () => false,
    handleWebhook: () => Promise.resolve([])
  }
}

function registry(): PluginRegistry {
  return new PluginRegistry({ setContext: jest.fn(), info: jest.fn() } as unknown as PinoLogger)
}
function refusal(plugin: ChannelPlugin): unknown {
  try {
    registry().register(plugin)
  } catch (error) {
    return error
  }
  return null
}

describe('the login descriptor of a plugin nobody named', () => {
  it('keeps what it declared, frozen, and the asset id as a pattern', () => {
    const plugins = registry()
    plugins.register(
      toy(
        login({
          linkedAccount: {
            required: true,
            label: { es: 'Cuenta: @{username}', en: 'Account: @{username}' },
            missingLabel: { es: 'Sin cuenta', en: 'No account' }
          }
        })
      )
    )
    const kept = plugins.oauthDescriptorOf(TOY_ID)
    expect(kept).toEqual({
      dialogOrigin: 'https://login.acme.test',
      providerName: { es: 'Acme', en: 'Acme' },
      linkedAccount: {
        required: true,
        label: { es: 'Cuenta: @{username}', en: 'Account: @{username}' },
        missingLabel: { es: 'Sin cuenta', en: 'No account' }
      },
      assetIdPattern: '^\\d{1,32}$'
    })
    expect(Object.isFrozen(kept)).toBe(true)
    expect(plugins.oauthOf(TOY_ID)?.assetId.test('12345')).toBe(true)
    expect(plugins.oauthOf(TOY_ID)?.assetId.test('12a')).toBe(false)
  })

  it('takes a label with a space beside the placeholder', () => {
    for (const es of [
      'Cuenta de {username}',
      '{username} en la red',
      '@{username}',
      'Cuenta: {username}.',
      '{username}: Instagram'
    ]) {
      const plugins = registry()
      plugins.register(
        toy(
          login({
            linkedAccount: {
              required: false,
              label: { es, en: es },
              missingLabel: { es: 'Sin cuenta', en: 'None' }
            }
          })
        )
      )
      expect(plugins.oauthDescriptorOf(TOY_ID)?.linkedAccount?.label.es).toBe(es)
    }
  })

  it('has none for a plugin without a login, or not registered', () => {
    const plugins = registry()
    plugins.register(toy(undefined))
    expect(plugins.oauthDescriptorOf(TOY_ID)).toBeNull()
    expect(registry().oauthDescriptorOf(TOY_ID)).toBeNull()
  })

  const hostile: [string, Record<string, unknown>][] = [
    ['a dialog address that is plain http', { dialogOrigin: 'http://login.acme.test' }],
    ['a dialog address with a path', { dialogOrigin: 'https://login.acme.test/dialog' }],
    ['a dialog address with a query', { dialogOrigin: 'https://login.acme.test?x=1' }],
    ['a dialog address with credentials', { dialogOrigin: 'https://u:p@login.acme.test' }],
    ['a dialog address with a port', { dialogOrigin: 'https://login.acme.test:8443' }],
    ['a dialog address with a wildcard', { dialogOrigin: 'https://*.acme.test' }],
    ['a dialog address that is an address', { dialogOrigin: 'https://10.0.0.1' }],
    ['a dialog address on a private network', { dialogOrigin: 'https://login.corp.internal' }],
    ['a dialog address in upper case', { dialogOrigin: 'https://LOGIN.acme.test' }],
    ['a dialog address that is a script', { dialogOrigin: 'javascript:alert(1)' }],
    ['a dialog address that is not text', { dialogOrigin: { href: 'https://x.test' } }],
    ['a provider name with markup', { providerName: { es: '<b>x</b>', en: 'x' } }],
    ['a provider name that is a link', { providerName: { es: 'x', en: 'https://evil.test' } }],
    ['a provider name missing a language', { providerName: { es: 'x' } }],
    [
      'a linked account with a placeholder that is not allowed',
      {
        linkedAccount: {
          required: true,
          label: { es: '{token}', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    [
      'a linked account with a label with markup',
      {
        linkedAccount: {
          required: false,
          label: { es: '<i>@{username}</i>', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    [
      'a linked account whose required flag is not a boolean',
      {
        linkedAccount: {
          required: 'yes',
          label: { es: 'x', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    ['a pattern that is not text', { assetIdPattern: /^\d+$/ }],
    ['a pattern with nested quantifiers', { assetIdPattern: '^(a+)+$' }],
    ['a pattern with an alternation', { assetIdPattern: '^(a|aa)+$' }],
    ['a pattern that is not anchored', { assetIdPattern: '\\d{1,32}' }],
    ['a pattern with an open end', { assetIdPattern: '^\\d+$' }],
    ['a pattern with a huge bound', { assetIdPattern: '^\\d{1,5000}$' }],
    ['a pattern that matches the empty string', { assetIdPattern: '^\\d{0,32}$' }],
    [
      'a label that joins the name to a link',
      {
        linkedAccount: {
          required: false,
          label: { es: 'go.{username}', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    [
      'a label that makes a scheme of the name',
      {
        linkedAccount: {
          required: false,
          label: { es: 'javascript{username}:alert', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    [
      'a label with a second name that completes a scheme',
      {
        linkedAccount: {
          required: false,
          label: { es: 'Cuenta {username}: javascript{username}:alert', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    [
      'a label that ends in a scheme',
      {
        linkedAccount: {
          required: false,
          label: { es: 'tel{username}:', en: 'x' },
          missingLabel: { es: 'x', en: 'x' }
        }
      }
    ],
    ['a range across classes of character', { assetIdPattern: '^[0-z]{1,10}$' }],
    ['a range from capitals to lower case', { assetIdPattern: '^[A-z]{1,10}$' }],
    ['a pattern that is not a pattern', { assetIdPattern: '^[$' }],
    ['a pattern that is huge', { assetIdPattern: `^${'\\d'.repeat(10_000)}$` }]
  ]
  it.each(hostile)('refuses %s at boot', (_name, overrides) => {
    const error = refusal(toy(login(overrides)))
    expect(error).toBeInstanceOf(PlatformException)
    expect((error as PlatformException).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('refuses a login with no descriptor at all', () => {
    const rest: Record<string, unknown> = { ...login() }
    for (const key of ['dialogOrigin', 'providerName', 'linkedAccount', 'assetIdPattern']) {
      delete rest[key]
    }
    const error = refusal(toy(rest as unknown as ChannelOAuth))
    expect((error as PlatformException).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('takes the patterns of a short run of one class of character', () => {
    for (const ok of ['^\\d{1,32}$', '^[A-Za-z0-9_-]{4,64}$', '^\\w{1,20}$', '^[0-9]{5}$']) {
      const plugins = registry()
      plugins.register(toy(login({ assetIdPattern: ok })))
      expect(plugins.oauthDescriptorOf(TOY_ID)?.assetIdPattern).toBe(ok)
    }
  })
})
