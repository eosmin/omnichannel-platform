import { DAY_MS } from '@platform/core/domain'

import {
  isProfileStale,
  needsProfileRead,
  plainHttpsUrl,
  profileJobId,
  retryAfterOutage
} from './customer-profile.support'

const now = new Date('2026-10-29T12:00:00Z')

describe('isProfileStale', () => {
  it('reads a profile that was never read', () => {
    expect(isProfileStale(null, now)).toBe(true)
  })

  it('leaves a recent profile alone', () => {
    expect(isProfileStale(new Date(now.getTime() - 6 * DAY_MS), now)).toBe(false)
  })

  it('reads again at seven days and after', () => {
    expect(isProfileStale(new Date(now.getTime() - 7 * DAY_MS), now)).toBe(true)
    expect(isProfileStale(new Date(now.getTime() - 30 * DAY_MS), now)).toBe(true)
  })
})

describe('plainHttpsUrl', () => {
  it('keeps a plain https link', () => {
    expect(plainHttpsUrl('https://cdn.example/p.jpg?sig=1', 2048)).toBe(
      'https://cdn.example/p.jpg?sig=1'
    )
  })

  it.each([
    'http://cdn.example/p.jpg',
    'https://user:pw@cdn.example/p.jpg',
    'javascript:alert(1)',
    'not a url',
    ''
  ])('drops %s', value => {
    expect(plainHttpsUrl(value, 2048)).toBeUndefined()
  })

  it('drops a link longer than the limit, and an absent one', () => {
    expect(plainHttpsUrl('https://cdn.example/' + 'a'.repeat(30), 20)).toBeUndefined()
    expect(plainHttpsUrl(undefined, 2048)).toBeUndefined()
  })
})

describe('needsProfileRead', () => {
  const stale = new Date(now.getTime() - 8 * DAY_MS)

  it('reads a stale profile, and one never read', () => {
    expect(needsProfileRead({ profileFetchedAt: stale, profileRetryAfter: null }, now)).toBe(true)
    expect(needsProfileRead({ profileFetchedAt: null, profileRetryAfter: null }, now)).toBe(true)
  })

  it('waits out the pause that follows an outage, then reads', () => {
    const state = { profileFetchedAt: null, profileRetryAfter: retryAfterOutage(now) }
    expect(needsProfileRead(state, now)).toBe(false)
    expect(needsProfileRead(state, new Date(now.getTime() + 61 * 60 * 1000))).toBe(true)
  })

  it('leaves a fresh profile alone', () => {
    const fresh = new Date(now.getTime() - DAY_MS)
    expect(needsProfileRead({ profileFetchedAt: fresh, profileRetryAfter: null }, now)).toBe(false)
  })
})

describe('profileJobId', () => {
  const state = { profileFetchedAt: new Date('2026-10-20T00:00:00Z'), profileRetryAfter: null }

  it('is the same for the same state on the same day and changes with the state or the day', () => {
    const id = profileJobId('i1', state, now)
    expect(profileJobId('i1', state, new Date(now.getTime() + 60_000))).toBe(id)
    expect(
      profileJobId('i1', { ...state, profileFetchedAt: new Date('2026-10-21T00:00:00Z') }, now)
    ).not.toBe(id)
    expect(profileJobId('i1', { ...state, profileRetryAfter: now }, now)).not.toBe(id)
    expect(profileJobId('i1', state, new Date(now.getTime() + DAY_MS))).not.toBe(id)
  })
})
