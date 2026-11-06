import { ChannelOAuthKinds } from '@platform/core/domain'
import type { ChannelOAuth, ChannelPlugin } from '@platform/plugins/sdk'

import { snapshotChannelOAuth } from './oauth-snapshot'

function oauth(overrides: Partial<ChannelOAuth> = {}): ChannelOAuth {
  return {
    kind: ChannelOAuthKinds.META_FACEBOOK_LOGIN,
    scopes: ['pages_show_list', 'pages_messaging'],
    grantedScopes: () => Promise.resolve(['pages_show_list']),
    listAssets: () => Promise.resolve([]),
    credentialsFor: () => Promise.resolve({ accessToken: 'page-token' }),
    ...overrides
  }
}

function plugin(declared: unknown): ChannelPlugin {
  return { id: 'messenger', oauth: declared } as unknown as ChannelPlugin
}

function refuses(declared: unknown): string | undefined {
  try {
    snapshotChannelOAuth(plugin(declared), 'messenger')
  } catch (error) {
    return (error as { message?: string }).message
  }
  return undefined
}

describe('snapshotChannelOAuth', () => {
  it('is null for a plugin with no login, which is nearly all of them', () => {
    expect(snapshotChannelOAuth(plugin(undefined), 'whatsapp')).toBeNull()
  })

  it('keeps what a well formed login declares', () => {
    const snapshot = snapshotChannelOAuth(plugin(oauth()), 'messenger')
    expect(snapshot?.kind).toBe('meta-facebook-login')
    expect(snapshot?.scopes).toEqual(['pages_show_list', 'pages_messaging'])
  })

  it('copies the scopes, so a list the plugin keeps changing grows nothing nobody checked', () => {
    const declared = oauth()
    const scopes = declared.scopes as string[]
    const snapshot = snapshotChannelOAuth(plugin(declared), 'messenger')
    scopes.push('ads_management')
    expect(snapshot?.scopes).toEqual(['pages_show_list', 'pages_messaging'])
    expect(Object.isFrozen(snapshot?.scopes)).toBe(true)
  })

  it('calls the functions it saw at registration, not the ones the plugin swaps in later', async () => {
    const declared = oauth({
      listAssets: () => Promise.resolve([{ id: '1', name: 'A', linkedAccount: null }])
    })
    const snapshot = snapshotChannelOAuth(plugin(declared), 'messenger')
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

  it.each(['grantedScopes', 'listAssets', 'credentialsFor'])('refuses a login without %s', name => {
    expect(refuses({ ...oauth(), [name]: undefined })).toMatch(new RegExp(name))
    expect(refuses({ ...oauth(), [name]: 'not a function' })).toMatch(new RegExp(name))
  })

  it('names the plugin by a printable id and never prints the declaration', () => {
    const message = refuses({ ...oauth(), scopes: ['pages_show_list&secret=abc'] })
    expect(message).toContain('"messenger"')
    expect(message).not.toContain('secret=abc')
  })
})
