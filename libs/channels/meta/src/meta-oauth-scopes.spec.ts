import { ChannelIds } from '@platform/core/domain'

import { MetaOAuth, MetaOAuthScopes } from './meta-oauth-constants'
import { grantedMetaScopes, metaOAuthScopesFor, metaOAuthScopeParam } from './meta-oauth-scopes'

describe('metaOAuthScopesFor', () => {
  it('asks Messenger for the Page permissions and no Instagram one', () => {
    expect(metaOAuthScopesFor(ChannelIds.MESSENGER)).toEqual([
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement'
    ])
  })

  it('asks Instagram for those and the two Instagram ones', () => {
    const scopes = metaOAuthScopesFor(ChannelIds.INSTAGRAM)
    expect(scopes).toEqual(
      expect.arrayContaining([...metaOAuthScopesFor(ChannelIds.MESSENGER), 'instagram_basic'])
    )
    expect(scopes).toContain(MetaOAuthScopes.INSTAGRAM_MANAGE_MESSAGES)
    expect(scopes).toHaveLength(6)
  })

  it('never asks for a permission twice', () => {
    for (const id of [ChannelIds.MESSENGER, ChannelIds.INSTAGRAM]) {
      const scopes = metaOAuthScopesFor(id)
      expect(new Set(scopes).size).toBe(scopes.length)
    }
  })

  it('asks WhatsApp and the widget for nothing: they have no login', () => {
    expect(metaOAuthScopesFor(ChannelIds.WHATSAPP)).toEqual([])
    expect(metaOAuthScopesFor(ChannelIds.WEB_WIDGET)).toEqual([])
    expect(metaOAuthScopesFor('telegram')).toEqual([])
  })

  it('asks for nothing that publishes, reads ads or touches money', () => {
    const all = [
      ...metaOAuthScopesFor(ChannelIds.MESSENGER),
      ...metaOAuthScopesFor(ChannelIds.INSTAGRAM)
    ]
    for (const scope of all) {
      expect(scope).not.toMatch(/^(ads_|instagram_content_publish|pages_manage_posts|whatsapp_)/)
      expect(scope).toMatch(MetaOAuth.SCOPE_PATTERN)
    }
  })

  it('returns a copy, so a caller cannot change what the next one asks for', () => {
    const first = metaOAuthScopesFor(ChannelIds.INSTAGRAM) as string[]
    first.push('ads_management')
    expect(metaOAuthScopesFor(ChannelIds.INSTAGRAM)).not.toContain('ads_management')
  })
})

describe('metaOAuthScopeParam', () => {
  it('joins the scopes the way the dialog reads them', () => {
    expect(metaOAuthScopeParam(['pages_show_list', 'pages_messaging'])).toBe(
      'pages_show_list,pages_messaging'
    )
  })

  it('refuses an empty list, a repeated scope and more scopes than a login may ask for', () => {
    expect(() => metaOAuthScopeParam([])).toThrow(/between one and/)
    expect(() => metaOAuthScopeParam(['pages_show_list', 'pages_show_list'])).toThrow(/repeated/)
    const many = Array.from({ length: 21 }, (_v, i) => `scope_${'a'.repeat(i)}`)
    expect(() => metaOAuthScopeParam(many)).toThrow(/between one and/)
  })

  it('refuses a name that is not a permission, so nothing else rides in the address', () => {
    expect(() => metaOAuthScopeParam(['pages_show_list&redirect_uri=https://evil'])).toThrow(
      /scope/
    )
    expect(() => metaOAuthScopeParam(['a,b'])).toThrow(/scope/)
    expect(() => metaOAuthScopeParam([''])).toThrow(/scope/)
    for (const bad of ['pages_', '_pages', 'pages__show', 'Pages', 'a'.repeat(65)]) {
      expect(() => metaOAuthScopeParam([bad])).toThrow(/scope/)
    }
    expect(metaOAuthScopeParam(['scope_2'])).toBe('scope_2')
  })
})

describe('grantedMetaScopes', () => {
  it('keeps the permissions whose status is granted and drops the declined ones', () => {
    const answer = {
      data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'declined' },
        { permission: 'public_profile', status: 'granted' },
        { permission: 'instagram_basic', status: 'expired' }
      ]
    }
    expect(grantedMetaScopes(answer)).toEqual(['pages_show_list', 'public_profile'])
  })

  it('reads an answer that is not the shape of the Graph as nothing granted', () => {
    for (const bad of [null, undefined, 'x', 1, {}, { data: 'x' }, { data: [null, 1, {}] }]) {
      expect(grantedMetaScopes(bad)).toEqual([])
    }
  })

  it('ignores an entry with a name that is not a permission', () => {
    const answer = { data: [{ permission: 'drop table', status: 'granted' }] }
    expect(grantedMetaScopes(answer)).toEqual([])
  })
})
