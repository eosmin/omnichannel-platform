import { splitStoreZones } from './finance-books.zones'

// HC-106 (residual): a store whose zone the database does not know is read as UTC, as its entries are. It must not be silent.
describe('splitStoreZones', () => {
  it('separates the zones the database knows from the ones it does not', () => {
    expect(
      splitStoreZones([
        { name: 'America/El_Salvador', known: true },
        { name: 'Not/AZone', known: false },
        { name: 'UTC', known: true }
      ])
    ).toEqual({ known: ['America/El_Salvador', 'UTC'], unknown: ['Not/AZone'] })
  })

  it('has nothing unknown when every zone is known, or when there is no store', () => {
    expect(splitStoreZones([{ name: 'UTC', known: true }])).toEqual({
      known: ['UTC'],
      unknown: []
    })
    expect(splitStoreZones([])).toEqual({ known: [], unknown: [] })
  })
})
