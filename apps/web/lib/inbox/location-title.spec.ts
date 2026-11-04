import { locationTitleOf } from './location-title'

const place = (name: string | null, address: string | null) => ({
  latitude: 1,
  longitude: 2,
  name,
  address
})

describe('locationTitleOf', () => {
  it('is the name when the place has one', () => {
    expect(locationTitleOf(place('Shop', 'Street 1'), 'Shop - Street 1')).toBe('Shop')
  })

  it('is the old line of text when the place has neither a name nor an address', () => {
    expect(locationTitleOf(place(null, null), 'Shop - Street 1')).toBe('Shop - Street 1')
  })

  it('is nothing when there is no line, and when the address is drawn apart', () => {
    expect(locationTitleOf(place(null, null), null)).toBeNull()
    expect(locationTitleOf(place(null, null), '  ')).toBeNull()
    expect(locationTitleOf(place(null, 'Street 1'), 'Street 1')).toBeNull()
  })
})
