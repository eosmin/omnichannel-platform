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
    ['google ll', 'https://maps.google.com/maps?ll=13.6929,-89.2182&z=15', 13.6929, -89.2182],
    ['apple ll', 'https://maps.apple.com/?ll=13.6929,-89.2182&q=Home', 13.6929, -89.2182],
    ['apple coordinate', 'https://maps.apple.com/?coordinate=13.6929,-89.2182', 13.6929, -89.2182],
    [
      'osm mlat',
      'https://www.openstreetmap.org/?mlat=13.6929&mlon=-89.2182#map=17/13.69/-89.21',
      13.6929,
      -89.2182
    ],
    ['osm hash', 'https://www.openstreetmap.org/#map=17/13.6929/-89.2182', 13.6929, -89.2182]
  ])('reads %s', (_name, url, lat, long) => {
    expect(coordinatesOfMapLink(url)).toEqual({ lat, long })
  })

  it('follows the redirect of Instagram once, to a map and only to a map', () => {
    const wrapped = (target: string): string =>
      `https://l.instagram.com/?u=${encodeURIComponent(target)}&e=AT0abc`
    expect(coordinatesOfMapLink(wrapped('https://maps.apple.com/?ll=1.5,2.5'))).toEqual({
      lat: 1.5,
      long: 2.5
    })
    expect(coordinatesOfMapLink(wrapped('https://evil.example/?ll=1.5,2.5'))).toBeNull()
    expect(coordinatesOfMapLink(wrapped(wrapped('https://maps.apple.com/?ll=1.5,2.5')))).toBeNull()
  })

  it.each([
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
