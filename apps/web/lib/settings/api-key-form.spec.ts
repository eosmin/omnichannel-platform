import { ApiKeyLimits } from '@platform/core/domain'

import {
  apiKeyInputOf,
  apiKeyProblems,
  emptyApiKeyDraft,
  expiryInstant,
  grantableScopes,
  scopeGroups,
  todayInput
} from './api-key-form'

const NOW = new Date(2026, 10, 15, 12, 0, 0)

describe('grantableScopes', () => {
  it('offers only the permissions an integration works with, and only those the person holds', () => {
    expect(
      grantableScopes([
        'orders:view',
        'orders:create',
        'settings:manage_api_keys',
        'team:manage_roles',
        'settings:view',
        'media:upload'
      ])
    ).toEqual(['orders:view', 'orders:create', 'media:upload'])
  })

  it('offers nothing to a person who holds none of them', () => {
    expect(grantableScopes(['settings:view', 'team:view'])).toEqual([])
  })
})

describe('scopeGroups', () => {
  it('groups by resource in the order of the allowed prefixes, dropping the empty ones', () => {
    expect(scopeGroups(['orders:view', 'conversations:view', 'orders:edit'])).toEqual([
      { resource: 'conversations', scopes: ['conversations:view'] },
      { resource: 'orders', scopes: ['orders:view', 'orders:edit'] }
    ])
    expect(scopeGroups([])).toEqual([])
  })
})

describe('expiryInstant', () => {
  it('is the end of the chosen day, on the clock of the person', () => {
    const instant = expiryInstant('2026-12-20')
    expect(instant?.getFullYear()).toBe(2026)
    expect(instant?.getMonth()).toBe(11)
    expect(instant?.getDate()).toBe(20)
    expect(instant?.getHours()).toBe(23)
  })

  it('is null for what is not a day', () => {
    expect(expiryInstant('')).toBeNull()
    expect(expiryInstant('20/12/2026')).toBeNull()
    expect(expiryInstant('2026-02-31')).toBeNull()
    expect(expiryInstant('2026-13-01')).toBeNull()
  })
})

describe('apiKeyProblems', () => {
  const good = { name: 'Warehouse app', scopes: ['orders:view'], expiresOn: '' }

  it('accepts a name and a scope, with no end date', () => {
    expect(apiKeyProblems(good, NOW)).toEqual([])
  })

  it('asks for a name and a scope', () => {
    expect(apiKeyProblems(emptyApiKeyDraft(), NOW)).toEqual(['nameRequired', 'noScopes'])
    expect(
      apiKeyProblems({ ...good, name: 'a'.repeat(ApiKeyLimits.NAME_MAX_LENGTH + 1) }, NOW)
    ).toEqual(['nameTooLong'])
  })

  it('refuses a last day that has passed, accepting today and later', () => {
    expect(apiKeyProblems({ ...good, expiresOn: '2026-11-14' }, NOW)).toEqual(['expiryPast'])
    expect(apiKeyProblems({ ...good, expiresOn: '2026-11-15' }, NOW)).toEqual([])
    expect(apiKeyProblems({ ...good, expiresOn: '2027-01-01' }, NOW)).toEqual([])
    expect(apiKeyProblems({ ...good, expiresOn: 'soon' }, NOW)).toEqual(['expiryInvalid'])
  })
})

describe('apiKeyInputOf', () => {
  it('throws for a day that is not one, instead of making a key that never expires', () => {
    expect(() =>
      apiKeyInputOf({ name: 'App', scopes: ['orders:view'], expiresOn: '2026-02-31' })
    ).toThrow()
  })

  it('trims the name and leaves the date out when there is none', () => {
    expect(apiKeyInputOf({ name: '  App ', scopes: ['orders:view'], expiresOn: '' })).toEqual({
      name: 'App',
      scopes: ['orders:view']
    })
  })

  it('sends the end of the day as an instant', () => {
    const input = apiKeyInputOf({ name: 'App', scopes: ['orders:view'], expiresOn: '2027-01-01' })
    expect(new Date(input.expiresAt ?? '').getTime()).toBe(
      new Date(2027, 0, 1, 23, 59, 59).getTime()
    )
  })
})

describe('todayInput', () => {
  it('writes the day of the person as the date input does, padded', () => {
    expect(todayInput(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(todayInput(new Date(2026, 10, 15))).toBe('2026-11-15')
  })

  it('is a day that expiryInstant accepts and that is not yet past that evening', () => {
    const now = new Date(2026, 10, 15, 12, 0, 0)
    expect(
      apiKeyProblems({ name: 'App', scopes: ['orders:view'], expiresOn: todayInput(now) }, now)
    ).toEqual([])
  })
})
