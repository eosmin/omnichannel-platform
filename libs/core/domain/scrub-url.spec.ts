import { REDACTED, scrubQuery, scrubQueryString, scrubUrl } from './scrub-url'

describe('scrubUrl', () => {
  it('finds the invitation prefix after an origin with a port, and hides its credentials', () => {
    expect(scrubUrl('https://user:pw@host:8443/api/v1/invitations/abc?x=1')).toBe(
      `https://${REDACTED}@host:8443/api/v1/invitations/${REDACTED}?x=1`
    )
  })

  it('leaves the other paths alone, and the team invitations too', () => {
    for (const url of ['/api/v1/settings/team/invitations/abc', '/api/v1/invitations', '/']) {
      expect(scrubUrl(url)).toBe(url)
    }
  })
})

describe('scrubQueryString', () => {
  it('reads a ? that sits only inside the fragment as no query at all', () => {
    expect(scrubQueryString('/x#a?token=s3cret')).toBe(`/x#a?token=${REDACTED}`)
    expect(scrubQueryString('/x#top?q=1')).toBe('/x#top?q=1')
  })

  it('keeps the harmless params of a url that has sensitive ones, in order', () => {
    expect(scrubQueryString('/x?status=open&page=2&limit=10')).toBe(
      '/x?status=open&page=2&limit=10'
    )
  })
})

describe('scrubQuery', () => {
  it('redacts what sits deeper than any real query, which is not worth keeping', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'visible?' } } } } } } }

    expect(JSON.stringify(scrubQuery(deep))).toContain(REDACTED)
    expect(JSON.stringify(scrubQuery(deep))).not.toContain('visible?')
  })

  it('walks arrays of arrays and of objects, and leaves the harmless values', () => {
    expect(scrubQuery({ list: [[{ token: 'x' }], 'plain'], status: 'open', page: 2 })).toEqual({
      list: [[{ token: REDACTED }], 'plain'],
      status: 'open',
      page: 2
    })
  })

  it('reads the name by its parts: brackets, dots, case and encoding', () => {
    expect(
      scrubQuery({ 'filter[Token]': 'x', 'a.b.code': 'y', 'x%5Btoken%5D': 'z', cursor: 'ok' })
    ).toEqual({
      'filter[Token]': REDACTED,
      'a.b.code': REDACTED,
      'x%5Btoken%5D': REDACTED,
      cursor: 'ok'
    })
  })
})

describe('scrubQueryString, a url passed as a value', () => {
  it('reads the params of an unencoded url that sits in a value', () => {
    expect(scrubQueryString('/x?redirect=/p?token=s3cret&page=2')).toBe(
      `/x?redirect=/p?token=${REDACTED}&page=2`
    )
  })
})

describe('scrubUrl, credentials and encoded values', () => {
  it('hides the user and password of an absolute url, whatever the path', () => {
    expect(scrubUrl('https://svc:p4ss@host/x?a=1')).toBe(`https://${REDACTED}@host/x?a=1`)
  })

  it('redacts a value that decodes to a url with a sensitive pair', () => {
    expect(scrubUrl('/x?next=%2Faccept%3Ftoken%3Ds3cret&page=2')).toBe(`/x?next=${REDACTED}&page=2`)
    expect(scrubUrl('/x?redirect_uri=https%3A%2F%2Fapp%2Fcb%3Fcode%3Dabc')).toBe(
      `/x?redirect_uri=${REDACTED}`
    )
  })

  it('keeps an encoded value that holds nothing sensitive, and survives a broken encoding', () => {
    expect(scrubUrl('/x?q=caf%C3%A9&next=%2Fhome')).toBe('/x?q=caf%C3%A9&next=%2Fhome')
    expect(scrubUrl('/x?next=%E0%A4%A')).toBe('/x?next=%E0%A4%A')
  })
})
