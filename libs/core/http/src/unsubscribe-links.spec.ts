import {
  signUnsubscribeToken,
  UnsubscribeScopes,
  verifyUnsubscribeToken
} from '@platform/core/crypto'

import { buildUnsubscribeLinks } from './unsubscribe-links'

const KEY = 'k'.repeat(40)
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'

const links = buildUnsubscribeLinks({
  frontendUrl: 'https://app.example.com',
  apiUrl: 'https://api.example.com',
  signingKey: KEY
})

describe('buildUnsubscribeLinks', () => {
  it('puts the token of the page link in the fragment, never in the query', () => {
    const { pageUrl } = links.forUser(USER)
    const url = new URL(pageUrl)
    expect(url.origin + url.pathname).toBe('https://app.example.com/unsubscribe')
    expect(url.search).toBe('')
    expect(url.hash.startsWith('#token=')).toBe(true)
  })

  it('points the POST link at the api route, with the token in the query', () => {
    const url = new URL(links.forUser(USER).postUrl)
    expect(url.origin + url.pathname).toBe(
      'https://api.example.com/api/v1/notifications/unsubscribe'
    )
    expect(url.hash).toBe('')
    expect(url.searchParams.get('token')).not.toBeNull()
  })

  it('signs both links for the person asked, under the key in force, and for nobody else', () => {
    const set = links.forUser(USER)
    const fromPage = new URL(set.pageUrl).hash.slice('#token='.length)
    const fromPost = new URL(set.postUrl).searchParams.get('token') ?? ''
    expect(fromPage).toBe(fromPost)
    expect(verifyUnsubscribeToken(KEY, fromPage)).toEqual({
      scope: UnsubscribeScopes.NOTIFICATION_EMAIL,
      id: USER
    })
    expect(fromPage).toBe(signUnsubscribeToken(KEY, UnsubscribeScopes.NOTIFICATION_EMAIL, USER))
    expect(fromPage).not.toBe(links.forUser(OTHER).pageUrl.split('#token=')[1])
  })

  it('is refused by another key (a link made here does not verify elsewhere)', () => {
    const token = new URL(links.forUser(USER).pageUrl).hash.slice('#token='.length)
    expect(verifyUnsubscribeToken('o'.repeat(40), token)).toBeNull()
  })
})
