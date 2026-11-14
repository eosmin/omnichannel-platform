import {
  CarrierCapability,
  CarrierHealthReasons,
  CarrierStatusMappingSource,
  ShipmentStatus
} from '@platform/core/domain'
import { CarrierCredentialsUnreadableError } from '@platform/core/shipping'
import type { ConnectFieldSnapshot } from '@platform/plugins/runtime'
import {
  CarrierAuthError,
  type CarrierPlugin,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import {
  connectAnswerSchema,
  connectFieldsProblem,
  commissionToKeep,
  defaultServiceCodeOf,
  feesChangeOf,
  filterLocations,
  healthReasonOf,
  locationsAnswerSchema,
  localMetadataSchema,
  ratesViewOf,
  seedServices,
  seedStatusMappings,
  settingsProblem
} from './carrier-connections.support'

type Catalogs = Pick<CarrierPlugin, 'serviceCatalog' | 'statusCatalog'>

function plugin(parts: Partial<Catalogs>): Catalogs {
  return { serviceCatalog: () => [], statusCatalog: () => [], ...parts }
}

describe('healthReasonOf', () => {
  it('names the three failures of a carrier without reading what they say', () => {
    expect(healthReasonOf(new CarrierAuthError('token abc'))).toBe(CarrierHealthReasons.AUTH)
    expect(healthReasonOf(new CarrierRejectedError('bad address'))).toBe(
      CarrierHealthReasons.REJECTED
    )
    expect(healthReasonOf(new CarrierUnavailableError('503'))).toBe(
      CarrierHealthReasons.UNAVAILABLE
    )
  })

  it('reads a call that took too long as the carrier being unavailable, not as a bad credential', () => {
    const late = new Error('the call to the provider timed out')
    late.name = 'ProviderTimeoutError'
    expect(healthReasonOf(late)).toBe(CarrierHealthReasons.UNAVAILABLE)
  })

  it('tells credentials that do not open from a carrier that refused them', () => {
    expect(healthReasonOf(new CarrierCredentialsUnreadableError())).toBe(
      CarrierHealthReasons.CREDENTIALS_UNREADABLE
    )
  })

  it('treats anything else as an answer the platform cannot use', () => {
    expect(healthReasonOf(new TypeError('x'))).toBe(CarrierHealthReasons.INVALID_ANSWER)
    expect(healthReasonOf('text')).toBe(CarrierHealthReasons.INVALID_ANSWER)
  })
})

describe('seedServices', () => {
  const labelOf = (service: { code: string; label: string }): string => `T:${service.label}`

  it('turns the catalog into rows with the label in the language of the store', () => {
    const rows = seedServices(
      plugin({ serviceCatalog: () => [{ code: 'std', label: 'Standard' }] }),
      labelOf
    )
    expect(rows).toEqual([{ code: 'std', label: 'T:Standard' }])
  })

  it('keeps the first of a code that comes twice and skips what the table would refuse', () => {
    const rows = seedServices(
      plugin({
        serviceCatalog: () => [
          { code: 'a', label: 'First' },
          { code: 'a', label: 'Second' },
          { code: '  ', label: 'Blank code' },
          { code: 'b', label: '   ' },
          { code: 'x'.repeat(100), label: 'Long code' },
          { code: 'c', label: 'y'.repeat(500) }
        ]
      }),
      service => service.label
    )
    expect(rows.map(row => row.code)).toEqual(['a', 'c'])
    expect(rows[1]?.label.length).toBeLessThanOrEqual(80)
  })

  it('stops at the most services a connection may have', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ code: `s${index}`, label: 'S' }))
    expect(seedServices(plugin({ serviceCatalog: () => many }), s => s.label)).toHaveLength(50)
  })
})

describe('defaultServiceCodeOf', () => {
  const catalog = plugin({
    serviceCatalog: () => [
      { code: 'std', label: 'Standard' },
      { code: 'next', label: 'Next day', defaultForNextDay: true }
    ]
  })
  const seeded = [
    { code: 'std', label: 'Standard' },
    { code: 'next', label: 'Next day' }
  ]

  it('is the one the owner asked for', () => {
    expect(defaultServiceCodeOf(catalog, seeded, 'std')).toBe('std')
  })

  it('is the next-day service of the carrier, else the first, else none', () => {
    expect(defaultServiceCodeOf(catalog, seeded, undefined)).toBe('next')
    const noNextDay = plugin({ serviceCatalog: () => [{ code: 'std', label: 'S' }] })
    expect(defaultServiceCodeOf(noNextDay, [{ code: 'std', label: 'S' }], undefined)).toBe('std')
    expect(defaultServiceCodeOf(plugin({}), [], undefined)).toBeNull()
  })

  it('does not name a next-day service that was not seeded', () => {
    expect(defaultServiceCodeOf(catalog, [{ code: 'std', label: 'S' }], undefined)).toBe('std')
  })
})

describe('seedStatusMappings', () => {
  it('maps each code the plugin knows under its normalized code, as a default', () => {
    const rows = seedStatusMappings(
      plugin({
        statusCatalog: () => [
          { code: ' Entregado ', label: 'Entregado', defaultStatus: ShipmentStatus.DELIVERED },
          { code: 'ENTREGÁDO', label: 'Again', defaultStatus: ShipmentStatus.DELIVERED },
          { code: 'info', label: 'Info', defaultStatus: null }
        ]
      })
    )
    expect(rows).toEqual([
      {
        providerCode: 'entregado',
        label: 'Entregado',
        status: ShipmentStatus.DELIVERED,
        source: CarrierStatusMappingSource.DEFAULT
      }
    ])
  })

  it('leaves a code with no safe default unmapped, so the owner decides when it arrives', () => {
    const rows = seedStatusMappings(
      plugin({ statusCatalog: () => [{ code: 'x', label: 'X', defaultStatus: null }] })
    )
    expect(rows).toEqual([])
  })

  it('refuses a default that is not a status a carrier can report', () => {
    expect(() =>
      seedStatusMappings(
        plugin({
          statusCatalog: () => [{ code: 'x', label: 'X', defaultStatus: ShipmentStatus.CREATING }]
        })
      )
    ).toThrow(RangeError)
  })
})

describe('settingsProblem', () => {
  const current = {
    defaultShippingFeeCents: 300,
    minShippingFeeCents: 100,
    maxShippingFeeCents: 500,
    pickupEnabled: true,
    pickupDays: [1, 2],
    autoPickup: false,
    autoPickupTime: null
  }

  it('accepts what the row already is and a change inside the range', () => {
    expect(settingsProblem(current, {})).toBeNull()
    expect(settingsProblem(current, { maxShippingFeeCents: 400 })).toBeNull()
  })

  it('judges a change over what the row holds, not by itself', () => {
    expect(settingsProblem(current, { maxShippingFeeCents: 200 })).toMatch(/above the maximum/)
    expect(settingsProblem(current, { minShippingFeeCents: 400 })).toMatch(/below the minimum/)
  })

  it('refuses pickups with no day and automatic pickups with no time', () => {
    expect(settingsProblem(current, { pickupDays: [] })).toMatch(/at least one day/)
    expect(settingsProblem(current, { autoPickup: true })).toMatch(/need a time/)
    expect(settingsProblem(current, { autoPickup: true, autoPickupTime: '08:00' })).toBeNull()
    expect(settingsProblem(current, { pickupEnabled: false, autoPickup: true })).toMatch(
      /need pickups enabled/
    )
  })
})

describe('what a plugin answers to connect', () => {
  it('needs a name, credentials and settings that are plain JSON', () => {
    expect(
      connectAnswerSchema.safeParse({ displayName: 'A', credentials: {}, metadata: { x: 1 } })
        .success
    ).toBe(true)
    expect(
      connectAnswerSchema.safeParse({ displayName: ' ', credentials: {}, metadata: {} }).success
    ).toBe(false)
    expect(connectAnswerSchema.safeParse({ displayName: 'A', credentials: {} }).success).toBe(false)
  })

  it('reads the contact of a local courier', () => {
    expect(localMetadataSchema.parse({ phone: '7000', prefix: 'JM', notes: 'n' })).toEqual({
      phone: '7000',
      prefix: 'JM',
      notes: 'n'
    })
    expect(localMetadataSchema.safeParse({ prefix: 'JM' }).success).toBe(false)
  })

  it('does not depend on the capability list of the plugin', () => {
    expect(CarrierCapability.INTERNAL_GUIDE).toBe('internal_guide')
  })
})

const field = (over: Partial<ConnectFieldSnapshot> & { key: string }): ConnectFieldSnapshot => ({
  labelKey: `fields.${over.key}`,
  label: null,
  helpKey: null,
  secret: false,
  required: false,
  multiple: false,
  ...over
})

describe('connectFieldsProblem', () => {
  const fields = [
    field({ key: 'username', required: true }),
    field({ key: 'password', required: true, secret: true }),
    field({ key: 'site' }),
    field({ key: 'origins', multiple: true })
  ]

  it('accepts what holds every required field, with the optional ones absent, blank or null', () => {
    expect(connectFieldsProblem(fields, { username: 'u', password: 'p' })).toBeNull()
    expect(
      connectFieldsProblem(fields, { username: 'u', password: 'p', site: '', origins: [] })
    ).toBeNull()
    expect(connectFieldsProblem(fields, { username: 'u', password: 'p', site: null })).toBeNull()
    expect(connectFieldsProblem(fields, { username: 'u', password: 'p', site: 795 })).toBeNull()
    expect(
      connectFieldsProblem(fields, { username: 'u', password: 'p', origins: ['a', 'b'] })
    ).toBeNull()
  })

  it('refuses a required field that is missing, blank or null, naming the field and never a value', () => {
    for (const credentials of [
      { password: 'p' },
      { username: '   ', password: 'p' },
      { username: null, password: 'p' }
    ]) {
      expect(connectFieldsProblem(fields, credentials)).toBe('the field username is required')
    }
    expect(connectFieldsProblem(fields, { username: 'u' })).toBe('the field password is required')
  })

  it('refuses a key the carrier does not ask for, so nothing unchecked is kept sealed', () => {
    expect(connectFieldsProblem(fields, { username: 'u', password: 'p', extra: 'x' })).toBe(
      'the credentials hold a field the carrier does not ask for'
    )
    expect(
      connectFieldsProblem(
        fields,
        JSON.parse('{"username":"u","password":"p","__proto__":{}}') as Record<string, unknown>
      )
    ).toBe('the credentials hold a field the carrier does not ask for')
  })

  it('refuses a value of the wrong shape: an object, a boolean, a list for a single field or text for a list', () => {
    for (const bad of [
      { username: { a: 1 }, password: 'p' },
      { username: true, password: 'p' },
      { username: ['u'], password: 'p' },
      { username: 'u', password: 'p', origins: 'a' },
      { username: 'u', password: 'p', origins: [1] },
      { username: 'u', password: 'p', origins: [''] },
      { username: 'u', password: 'p', site: Number.NaN }
    ]) {
      expect(connectFieldsProblem(fields, bad)).toBe('a field has a value it cannot take')
    }
  })

  it('leaves a carrier that declares nothing free: its own JSON is valid', () => {
    expect(connectFieldsProblem([], { anything: { goes: [1] } })).toBeNull()
  })
})

describe('locationsAnswerSchema and filterLocations', () => {
  it('reads what a plugin answers and drops what it adds', () => {
    const parsed = locationsAnswerSchema.parse([{ id: '7', name: 'San Salvador', extra: 1 }])
    expect(parsed).toEqual([{ id: '7', name: 'San Salvador' }])
  })

  it('refuses an answer that is not a list of places with an id and a name, or is too long', () => {
    expect(locationsAnswerSchema.safeParse([{ id: '', name: 'x' }]).success).toBe(false)
    expect(locationsAnswerSchema.safeParse([{ id: '1' }]).success).toBe(false)
    // An id the next request could not carry back (it is a parameter of it and ends in a cache key)
    expect(locationsAnswerSchema.safeParse([{ id: 'SAN SALVADOR', name: 'x' }]).success).toBe(false)
    expect(locationsAnswerSchema.safeParse({ id: '1', name: 'x' }).success).toBe(false)
    expect(
      locationsAnswerSchema.safeParse(
        Array.from({ length: 5001 }, (_, i) => ({ id: `${i}`, name: 'x' }))
      ).success
    ).toBe(false)
  })

  it('searches by name without caring for case or accents, and a blank search keeps everything', () => {
    const places = [
      { id: '1', name: 'Santa Ana' },
      { id: '2', name: 'San Salvador' },
      { id: '3', name: 'Ahuachapán' }
    ]
    expect(filterLocations(places, 'SAN')).toEqual(places.slice(0, 2))
    expect(filterLocations(places, 'ahuachapan')).toEqual([places[2]])
    expect(filterLocations(places, '  ')).toEqual(places)
    expect(filterLocations(places, undefined)).toEqual(places)
    expect(filterLocations(places, 'zzz')).toEqual([])
  })
})

describe('ratesViewOf', () => {
  it('shows the prices that are whole cents in range and nothing else', () => {
    expect(ratesViewOf({ CCE: 300, SEC: 0 })).toEqual({ CCE: 300, SEC: 0 })
    expect(ratesViewOf({ CCE: 300, SER: 'x', SEC: -1, OTHER: 1.5 })).toEqual({ CCE: 300 })
  })
  it('is empty for a connection with no table, or one that is not an object', () => {
    expect(ratesViewOf(null)).toEqual({})
    expect(ratesViewOf([300])).toEqual({})
    expect(ratesViewOf('x')).toEqual({})
  })
})

describe('ratesViewOf with the declared services', () => {
  it('leaves out a service the plugin no longer declares', () => {
    expect(ratesViewOf({ CCE: 300, OLD: 50 }, ['CCE', 'SEC'])).toEqual({ CCE: 300 })
    expect(ratesViewOf({ CCE: 300, OLD: 50 })).toEqual({ CCE: 300, OLD: 50 })
  })
})

describe('commissionToKeep', () => {
  it('keeps 0 as null for a carrier that takes no commission, and as 0 for one that does', () => {
    expect(commissionToKeep({ commission: false }, 0)).toBeNull()
    expect(commissionToKeep({ commission: true }, 0)).toBe(0)
    expect(commissionToKeep({ commission: false }, null)).toBeNull()
    expect(commissionToKeep({ commission: true }, 450)).toBe(450)
    expect(commissionToKeep({ commission: true }, undefined)).toBeUndefined()
  })
})

describe('feesChangeOf', () => {
  const before = { commissionBps: 450, serviceRatesCents: { CCE: 300, SEC: 0 } }
  it('is null when nothing the edit sends differs, and a field it does not send is not a change', () => {
    expect(feesChangeOf(before, {})).toBeNull()
    expect(
      feesChangeOf(before, { commissionBps: 450, serviceRatesCents: { CCE: 300, SEC: 0 } })
    ).toBeNull()
  })
  it('names the commission with its old and new value', () => {
    expect(feesChangeOf(before, { commissionBps: 500 })).toEqual({
      commissionBps: { from: 450, to: 500 }
    })
    expect(feesChangeOf(before, { commissionBps: null })).toEqual({
      commissionBps: { from: 450, to: null }
    })
  })
  it('names each rate that was added, changed or removed', () => {
    expect(feesChangeOf(before, { serviceRatesCents: { CCE: 350, SER: 200 } })).toEqual({
      serviceRatesCents: {
        CCE: { from: 300, to: 350 },
        SEC: { from: 0, to: null },
        SER: { from: null, to: 200 }
      }
    })
    expect(feesChangeOf(before, { serviceRatesCents: null })).toEqual({
      serviceRatesCents: { CCE: { from: 300, to: null }, SEC: { from: 0, to: null } }
    })
  })
  it('does not read the prototype for a service named like one of its members', () => {
    expect(
      feesChangeOf(
        { commissionBps: null, serviceRatesCents: {} },
        { serviceRatesCents: { toString: 5 } }
      )
    ).toEqual({
      serviceRatesCents: { toString: { from: null, to: 5 } }
    })
  })
})
