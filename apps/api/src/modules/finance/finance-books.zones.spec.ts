import { reportUnknownZones, splitStoreZones } from './finance-books.zones'

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

describe('reportUnknownZones', () => {
  const logger = (): {
    warn: jest.MockedFunction<
      (context: { organizationId: string; zones: string[] }, message: string) => void
    >
  } => ({
    warn: jest.fn<void, [{ organizationId: string; zones: string[] }, string]>()
  })

  it('warns with the organization and the zones, once for the same ones', () => {
    const log = logger()
    reportUnknownZones(log, 'org-1', ['Mars/Phobos'])
    reportUnknownZones(log, 'org-1', ['Mars/Phobos'])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      { organizationId: 'org-1', zones: ['Mars/Phobos'] },
      expect.any(String)
    )
  })

  it('warns again for another organization or another set of zones', () => {
    const log = logger()
    reportUnknownZones(log, 'org-2', ['Mars/Phobos'])
    reportUnknownZones(log, 'org-3', ['Mars/Phobos'])
    reportUnknownZones(log, 'org-3', ['Mars/Phobos', 'Mars/Deimos'])
    expect(log.warn).toHaveBeenCalledTimes(3)
  })

  it('says nothing when every zone is known', () => {
    const log = logger()
    reportUnknownZones(log, 'org-4', [])
    expect(log.warn).not.toHaveBeenCalled()
  })
})
