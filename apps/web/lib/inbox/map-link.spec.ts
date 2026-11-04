import { mapLinkOf } from './map-link'

describe('mapLinkOf', () => {
  it('builds the link from the coordinates alone', () => {
    expect(mapLinkOf({ latitude: 19.4326, longitude: -99.1332 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=19.4326%2C-99.1332'
    )
  })

  it('keeps the coordinates to six decimals', () => {
    expect(mapLinkOf({ latitude: 1.123456789, longitude: 2 })).toContain('query=1.123457%2C2')
  })

  it.each([
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY]
  ])('gives no link for %s, %s', (latitude, longitude) => {
    expect(mapLinkOf({ latitude, longitude })).toBeNull()
  })

  it('gives no link for coordinates that are not numbers, whatever they hold', () => {
    const hostile = { latitude: '1&x=javascript:alert(1)', longitude: 2 } as unknown as {
      latitude: number
      longitude: number
    }
    expect(mapLinkOf(hostile)).toBeNull()
  })

  it('never carries the text of the place', () => {
    const link = mapLinkOf({ latitude: 1, longitude: 2, name: 'a&b', address: '#x' } as never)
    expect(link).not.toContain('a&b')
    expect(link).not.toContain('#x')
  })
})
