import { Permissions } from '@platform/core/auth'
import { PluginInstallLimits, PluginManifestLimits } from '@platform/core/domain'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  bearerTokenOf,
  challengeBody,
  heldRateLimit,
  isChallengeAnswered,
  isPluginScope,
  isSetupCode,
  knownScopes,
  permissionsOfScopes,
  rateLimitOf,
  sameScopes,
  scopeChanges
} from './plugin-install-rules'

describe('scopes', () => {
  it('knows only the scopes the platform declares', () => {
    expect(isPluginScope(PluginScopes.ORDERS_READ)).toBe(true)
    expect(isPluginScope('orders:everything')).toBe(false)
    expect(isPluginScope('')).toBe(false)
  })

  it('drops what does not exist and what repeats, in a stable order', () => {
    expect(knownScopes(['orders:read', 'nope', 'messages:read', 'orders:read'])).toEqual([
      'messages:read',
      'orders:read'
    ])
  })

  it('compares sets, not lists', () => {
    expect(sameScopes(['orders:read', 'messages:read'], ['messages:read', 'orders:read'])).toBe(
      true
    )
    expect(sameScopes(['orders:read'], ['orders:read', 'orders:write'])).toBe(false)
    expect(sameScopes([], [])).toBe(true)
    // An unknown scope is not a scope: it grants nothing and does not make two sets differ
    expect(sameScopes(['orders:read', 'nope'], ['orders:read'])).toBe(true)
  })

  it('says what a newer manifest adds and what it drops', () => {
    expect(scopeChanges(['orders:read', 'messages:read'], ['orders:read', 'orders:write'])).toEqual(
      { added: ['orders:write'], removed: ['messages:read'] }
    )
    expect(scopeChanges(['orders:read'], ['orders:read'])).toEqual({ added: [], removed: [] })
  })

  it('maps scopes to the human permissions they stand for, and to nothing else', () => {
    const permissions = permissionsOfScopes([PluginScopes.ORDERS_READ, PluginScopes.ORDERS_READ])
    expect(permissions).toEqual([Permissions.ORDERS_VIEW])
    expect(permissionsOfScopes(['made-up'])).toEqual([])
    expect(permissionsOfScopes([])).toEqual([])
    expect(permissionsOfScopes([PluginScopes.WEBHOOKS_WRITE])).toEqual([])
  })
})

describe('rateLimitOf', () => {
  it('takes the limit of the manifest, or the default', () => {
    expect(rateLimitOf({ limits: { maxRequestsPerMinute: 120 } })).toBe(120)
    expect(rateLimitOf({ limits: {} })).toBe(60)
    expect(rateLimitOf({})).toBe(60)
  })
})

describe('the install challenge', () => {
  it('is a typed body that names the plugin and carries the challenge', () => {
    expect(JSON.parse(challengeBody('acme-pos', 'abc'))).toEqual({
      type: 'plugin.challenge',
      pluginId: 'acme-pos',
      challenge: 'abc'
    })
  })

  it('is answered only by a JSON object that echoes the same value', () => {
    expect(isChallengeAnswered('{"challenge":"abc"}', 'abc')).toBe(true)
    expect(isChallengeAnswered('{"challenge":"abd"}', 'abc')).toBe(false)
    expect(isChallengeAnswered('{"challenge":"abcd"}', 'abc')).toBe(false)
    expect(isChallengeAnswered('{"challenge":1}', 'abc')).toBe(false)
    expect(isChallengeAnswered('{}', 'abc')).toBe(false)
    expect(isChallengeAnswered('["abc"]', 'abc')).toBe(false)
    expect(isChallengeAnswered('"abc"', 'abc')).toBe(false)
    expect(isChallengeAnswered('null', 'abc')).toBe(false)
    expect(isChallengeAnswered('not json', 'abc')).toBe(false)
    expect(isChallengeAnswered('', 'abc')).toBe(false)
  })
})

describe('isSetupCode', () => {
  it('is the shape of 32 bytes in base64url, and nothing else', () => {
    expect(isSetupCode('A'.repeat(43))).toBe(true)
    expect(isSetupCode('a-_Z'.repeat(10) + 'abc')).toBe(true)
    expect(isSetupCode('A'.repeat(42))).toBe(false)
    expect(isSetupCode('A'.repeat(44))).toBe(false)
    expect(isSetupCode(`${'A'.repeat(42)}=`)).toBe(false)
    expect(isSetupCode(`${'A'.repeat(42)}!`)).toBe(false)
    expect(isSetupCode('')).toBe(false)
  })
})

describe('bearerTokenOf', () => {
  it('reads the token of a bearer header, with the scheme in any case', () => {
    expect(bearerTokenOf('Bearer plg_live_x')).toBe('plg_live_x')
    expect(bearerTokenOf('bearer plg_live_x')).toBe('plg_live_x')
  })

  it('reads nothing from another scheme, an empty token, extra words or no header', () => {
    expect(bearerTokenOf('Basic abc')).toBeUndefined()
    expect(bearerTokenOf('Bearer ')).toBeUndefined()
    expect(bearerTokenOf('Bearer a b')).toBeUndefined()
    expect(bearerTokenOf(undefined)).toBeUndefined()
  })
})

describe('heldRateLimit', () => {
  const { MIN_REQUESTS_PER_MINUTE: MIN, MAX_REQUESTS_PER_MINUTE: MAX } = PluginManifestLimits

  it('keeps what lies inside the range a manifest may ask for', () => {
    expect(heldRateLimit(MIN)).toBe(MIN)
    expect(heldRateLimit(60)).toBe(60)
    expect(heldRateLimit(MAX)).toBe(MAX)
  })

  // A row an older parser wrote must neither lift the limit nor shut the plugin out for good
  it('lowers a stored value above the range to its top, and gives one that is no sense the default', () => {
    expect(heldRateLimit(0)).toBe(PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE)
    expect(heldRateLimit(-10)).toBe(PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE)
    expect(heldRateLimit(MAX + 1)).toBe(MAX)
    expect(heldRateLimit(10_000_000)).toBe(MAX)
    expect(heldRateLimit(7.9)).toBe(7)
  })

  it('falls back to the default of an install for a value that is no number', () => {
    expect(heldRateLimit(Number.NaN)).toBe(PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE)
    expect(heldRateLimit(Number.POSITIVE_INFINITY)).toBe(
      PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE
    )
  })
})
