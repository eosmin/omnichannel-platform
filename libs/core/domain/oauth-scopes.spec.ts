import { missingOAuthScopes } from './oauth-scopes'

describe('missingOAuthScopes', () => {
  // Any provider's list: the helper only compares names, in order
  const required = [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_messages'
  ]

  it('is empty when everything asked was granted', () => {
    expect(missingOAuthScopes(required, required)).toEqual([])
  })

  it('names the permission the person cleared in the dialog (pages_read_engagement)', () => {
    const granted = required.filter(scope => scope !== 'pages_read_engagement')
    expect(missingOAuthScopes(required, granted)).toEqual(['pages_read_engagement'])
  })

  it('lists every missing one in the order they were asked, not the order they were granted', () => {
    const granted = ['instagram_manage_messages', 'pages_show_list']
    expect(missingOAuthScopes(required, granted)).toEqual([
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement',
      'instagram_basic'
    ])
  })

  it('does not mind extra permissions the person granted', () => {
    expect(missingOAuthScopes(required, [...required, 'public_profile'])).toEqual([])
  })

  it('asks for all of them when nothing was granted', () => {
    expect(missingOAuthScopes(required, [])).toEqual(required)
  })
})
