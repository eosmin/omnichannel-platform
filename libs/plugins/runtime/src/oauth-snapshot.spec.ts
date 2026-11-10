import { ChannelOAuthKinds } from '@platform/core/domain'
import type { ChannelOAuth, ChannelPlugin } from '@platform/plugins/sdk'

import { snapshotChannelOAuth } from './oauth-snapshot'

const CALLBACK = 'https://api.example.test/api/v1/channels/oauth/callback'

function oauth(overrides: Partial<ChannelOAuth> = {}): ChannelOAuth {
  return {
    kind: ChannelOAuthKinds.AUTHORIZATION_CODE_WITH_ASSETS,
    scopes: ['pages_show_list', 'pages_messaging'],
    redirectUri: CALLBACK,
    dialogOrigin: 'https://login.example.test',
    providerName: { es: 'Ejemplo', en: 'Example' },
    linkedAccount: null,
    assetIdPattern: '^\\d{1,32}$',
    authorizationUrl: () => 'https://dialog.example/x',
    exchangeCode: () => Promise.resolve('user-token'),
    grantedScopes: () => Promise.resolve(['pages_show_list']),
    listAssets: () => Promise.resolve([]),
    credentialsFor: () => Promise.resolve({ accessToken: 'page-token' }),
    ...overrides
  }
}

function plugin(declared: unknown): ChannelPlugin {
  return { id: 'messenger', oauth: declared } as unknown as ChannelPlugin
}

// What the official plugins with this kind of login ask for: the ceiling of anyone else's
const CEILING = new Set(['pages_show_list', 'pages_messaging', 'pages_manage_metadata'])

function refuses(
  declared: unknown,
  ceiling: ReadonlySet<string> | null = CEILING
): string | undefined {
  try {
    snapshotChannelOAuth(plugin(declared), 'messenger', () => ceiling, CALLBACK)
  } catch (error) {
    return (error as { message?: string }).message
  }
  return undefined
}

describe('snapshotChannelOAuth', () => {
  it('is null for a plugin with no login, which is nearly all of them', () => {
    expect(snapshotChannelOAuth(plugin(undefined), 'whatsapp', () => null, CALLBACK)).toBeNull()
  })

  it('keeps what a well formed login declares', () => {
    const snapshot = snapshotChannelOAuth(plugin(oauth()), 'messenger', () => CEILING, CALLBACK)
    expect(snapshot?.kind).toBe('authorization-code-with-assets')
    expect(snapshot?.scopes).toEqual(['pages_show_list', 'pages_messaging'])
  })

  it('copies the scopes, so a list the plugin keeps changing grows nothing nobody checked', () => {
    const declared = oauth()
    const scopes = declared.scopes as string[]
    const snapshot = snapshotChannelOAuth(plugin(declared), 'messenger', () => CEILING, CALLBACK)
    scopes.push('ads_management')
    expect(snapshot?.scopes).toEqual(['pages_show_list', 'pages_messaging'])
    expect(Object.isFrozen(snapshot?.scopes)).toBe(true)
  })

  it('calls the functions it saw at registration, not the ones the plugin swaps in later', async () => {
    const declared = oauth({
      listAssets: () => Promise.resolve([{ id: '1', name: 'A', linkedAccount: null }])
    })
    const snapshot = snapshotChannelOAuth(plugin(declared), 'messenger', () => CEILING, CALLBACK)
    ;(declared as { listAssets: unknown }).listAssets = () => Promise.resolve([])
    await expect(snapshot?.listAssets({ userToken: 't' })).resolves.toHaveLength(1)
  })

  it.each([
    ['null', null],
    ['text', 'meta'],
    ['a list', []],
    ['a number', 1]
  ])('refuses a login that is %s', (_name, declared) => {
    expect(refuses(declared)).toMatch(/oauth/)
  })

  it('refuses a kind that is not one of the flows the core knows', () => {
    expect(refuses(oauth({ kind: 'whatsapp-embedded-signup' as never }))).toMatch(/kind/)
    expect(refuses({ ...oauth(), kind: undefined })).toMatch(/kind/)
  })

  it.each([
    ['no scopes', []],
    ['scopes that are not a list', 'pages_show_list'],
    ['a scope that is not a permission name', ['pages_show_list&x=1']],
    ['an empty scope', ['']],
    ['an uppercase scope', ['Pages_Show_List']],
    ['a scope that is not text', [1]],
    ['a repeated scope', ['pages_show_list', 'pages_show_list']],
    ['a permission the kind of login may not ask for', ['pages_show_list', 'ads_management']],
    ['a publishing permission', ['pages_manage_posts']],
    ['too many scopes', Array.from({ length: 21 }, (_v, i) => `scope_${'a'.repeat(i)}`)]
  ])('refuses %s', (_name, scopes) => {
    expect(refuses({ ...oauth(), scopes })).toMatch(/scopes/)
  })

  describe('the ceiling of the permissions', () => {
    it('holds an official plugin (no ceiling) only to the shape of a permission name', () => {
      const scopes = ['pages_show_list', 'a_permission_only_this_provider_has']
      expect(
        snapshotChannelOAuth(plugin(oauth({ scopes })), 'messenger', () => null, CALLBACK)?.scopes
      ).toEqual(scopes)
      expect(refuses({ ...oauth(), scopes: ['Not A Name'] }, null)).toMatch(/scopes/)
    })

    it('lets any other plugin ask for what the official ones ask, or less', () => {
      const snapshot = snapshotChannelOAuth(
        plugin(oauth({ scopes: ['pages_messaging'] })),
        'acme_chat',
        () => CEILING,
        CALLBACK
      )
      expect(snapshot?.scopes).toEqual(['pages_messaging'])
    })

    it('refuses any other plugin that asks for one permission more than the official ones', () => {
      expect(
        refuses(oauth({ scopes: ['pages_show_list', 'a_permission_nobody_official_asks'] }))
      ).toMatch(/scopes/)
    })

    it('refuses any other plugin when no official plugin has that kind of login', () => {
      expect(refuses(oauth(), new Set())).toMatch(/scopes/)
    })
  })

  it.each(['authorizationUrl', 'exchangeCode', 'grantedScopes', 'listAssets', 'credentialsFor'])(
    'refuses a login without %s',
    name => {
      expect(refuses({ ...oauth(), [name]: undefined })).toMatch(new RegExp(name))
      expect(refuses({ ...oauth(), [name]: 'not a function' })).toMatch(new RegExp(name))
    }
  )

  it('names the plugin by a printable id and never prints the declaration', () => {
    const message = refuses({ ...oauth(), scopes: ['pages_show_list&secret=abc'] })
    expect(message).toContain('"messenger"')
    expect(message).not.toContain('secret=abc')
  })
})

describe('the address a login sends the browser back to', () => {
  const declare = (redirectUri: unknown) => oauth({ redirectUri } as Partial<ChannelOAuth>)

  it('is kept when it is exactly the callback of this platform', () => {
    expect(
      snapshotChannelOAuth(plugin(declare(CALLBACK)), 'messenger', () => null, CALLBACK)
        ?.redirectUri
    ).toBe(CALLBACK)
  })

  it('may be none, which is a login that is off', () => {
    expect(
      snapshotChannelOAuth(plugin(declare(null)), 'messenger', () => null, CALLBACK)?.redirectUri
    ).toBeNull()
    expect(
      snapshotChannelOAuth(plugin(declare(null)), 'messenger', () => null, undefined)?.redirectUri
    ).toBeNull()
  })

  // The code of a person is worth a token: every address that is not the callback exactly is refused at
  // registration, whoever declared it and however close it looks
  it.each([
    ['another site', 'https://evil.example/api/v1/channels/oauth/callback'],
    ['a look-alike host', 'https://api.example.test.evil.example/api/v1/channels/oauth/callback'],
    ['a sibling subdomain', 'https://api2.example.test/api/v1/channels/oauth/callback'],
    ['another port', 'https://api.example.test:8443/api/v1/channels/oauth/callback'],
    [
      'a login in the address',
      'https://user:secret@api.example.test/api/v1/channels/oauth/callback'
    ],
    ['another scheme', 'http://api.example.test/api/v1/channels/oauth/callback'],
    ['a path outside the prefix', 'https://api.example.test/channels/oauth/callback'],
    ['another route', 'https://api.example.test/api/v1/channels/oauth/other'],
    ['a query', `${CALLBACK}?next=https://evil.example`],
    ['a fragment', `${CALLBACK}#x`],
    ['a trailing slash', `${CALLBACK}/`],
    ['an upper case host', 'https://API.example.test/api/v1/channels/oauth/callback'],
    ['nothing at all (not even null)', undefined],
    ['text that is not an address', 'callback'],
    ['a value that is not text', 7]
  ])('is refused when it is %s', (_name, redirectUri) => {
    expect(refuses(declare(redirectUri))).toContain('redirect address')
  })

  it('is refused when the platform does not know its own address, unless the login is off', () => {
    expect(() =>
      snapshotChannelOAuth(plugin(declare(CALLBACK)), 'messenger', () => null, undefined)
    ).toThrow('redirect address')
  })
})
