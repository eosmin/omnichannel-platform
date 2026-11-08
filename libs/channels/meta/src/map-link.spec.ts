import { coordinatesOfMapLink } from './map-link'

describe('coordinatesOfMapLink', () => {
  it.each([
    [
      'google @lat,lng',
      'https://www.google.com/maps/place/Home/@13.6929,-89.2182,17z',
      13.6929,
      -89.2182
    ],
    [
      'google q',
      'https://www.google.com/maps/search/?api=1&query=13.6929%2C-89.2182',
      13.6929,
      -89.2182
    ],
    ['google q=', 'https://maps.google.com/?q=13.6929,-89.2182', 13.6929, -89.2182],
    [
      'a regional google',
      'https://www.google.com.sv/maps/place/Casa/@13.6929,-89.2182,17z',
      13.6929,
      -89.2182
    ],
    [
      'google place with long decimals, cut to seven',
      'https://www.google.com/maps/place/X/@13.69291234567,-89.2182,17z?query=13.69,-89.21',
      13.6929123,
      -89.2182
    ],
    ['apple coordinate', 'https://maps.apple.com/?coordinate=13.6929,-89.2182', 13.6929, -89.2182],
    [
      'osm mlat',
      'https://www.openstreetmap.org/?mlat=13.6929&mlon=-89.2182#map=17/13.69/-89.21',
      13.6929,
      -89.2182
    ]
  ])('reads %s', (_name, url, lat, long) => {
    expect(coordinatesOfMapLink(url)).toEqual({ lat, long })
  })

  it('reads an upper case host as the same host', () => {
    expect(coordinatesOfMapLink('https://MAPS.APPLE.COM/?coordinate=1.5,2.5')).toEqual({
      lat: 1.5,
      long: 2.5
    })
  })

  it('follows the redirects of Instagram and Facebook once, to a map and only to a map', () => {
    const wrapped = (target: string): string =>
      `https://l.instagram.com/?u=${encodeURIComponent(target)}&e=AT0abc`
    expect(coordinatesOfMapLink(wrapped('https://maps.apple.com/?coordinate=1.5,2.5'))).toEqual({
      lat: 1.5,
      long: 2.5
    })
    expect(coordinatesOfMapLink(wrapped('https://evil.example/?coordinate=1.5,2.5'))).toBeNull()
    expect(
      coordinatesOfMapLink(wrapped(wrapped('https://maps.apple.com/?coordinate=1.5,2.5')))
    ).toBeNull()
  })

  it.each([
    [
      'the centre of a Google search page',
      'https://www.google.com/maps/search/Casa/@13.7,-89.2,12z'
    ],
    ['the viewport ll of Google', 'https://maps.google.com/maps?ll=13.7,-89.2&z=15'],
    ['the search centre sll of Apple', 'https://maps.apple.com/?q=Casa&sll=13.7,-89.2'],
    ['a path that only starts like maps', 'https://www.google.com/mapsfoo/@13.7,-89.2,12z?q=1,2'],
    ['an encoded at sign', 'https://www.google.com/maps/place/X/%4013.7,-89.2,12z'],
    ['an upper case look-alike with a dot at the end', 'https://maps.apple.com./?ll=1.5,2.5'],
    ['a redirect with no target', 'https://l.instagram.com/?e=AT0'],
    [
      'a redirect to a target with credentials',
      `https://l.facebook.com/?u=${encodeURIComponent('https://u:p@maps.apple.com/?ll=1.5,2.5')}`
    ],
    [
      'a redirect to another port',
      `https://lm.facebook.com/?u=${encodeURIComponent('https://maps.apple.com:444/?ll=1.5,2.5')}`
    ],
    [
      'a redirect to http',
      `https://l.instagram.com/?u=${encodeURIComponent('http://maps.apple.com/?ll=1.5,2.5')}`
    ],
    ['http', 'http://maps.apple.com/?ll=1.5,2.5'],
    ['a host that only looks like it', 'https://maps.apple.com.evil.example/?ll=1.5,2.5'],
    ['a subdomain', 'https://x.maps.apple.com/?ll=1.5,2.5'],
    ['credentials', 'https://user:pw@maps.apple.com/?ll=1.5,2.5'],
    ['another port', 'https://maps.apple.com:8443/?ll=1.5,2.5'],
    ['a short link that has no coordinates', 'https://maps.app.goo.gl/abc123'],
    ['no coordinates', 'https://maps.apple.com/?q=Home'],
    ['coordinates out of range', 'https://maps.apple.com/?ll=95,200'],
    ['a text that is not a link', 'not a link'],
    ['a google page that is not maps', 'https://www.google.com/search?q=13.6929,-89.2182']
  ])('refuses %s', (_name, url) => {
    expect(coordinatesOfMapLink(url)).toBeNull()
  })
})
