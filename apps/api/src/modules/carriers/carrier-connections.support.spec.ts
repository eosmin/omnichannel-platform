import {
  CarrierCapability,
  CarrierHealthReasons,
  CarrierStatusMappingSource,
  ShipmentStatus
} from '@platform/core/domain'
import { CarrierCredentialsUnreadableError } from '@platform/core/shipping'
import {
  CarrierAuthError,
  type CarrierPlugin,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import {
  connectAnswerSchema,
  defaultServiceCodeOf,
  healthReasonOf,
  localMetadataSchema,
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
