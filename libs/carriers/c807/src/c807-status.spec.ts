import {
  CarrierReportableStatuses,
  normalizeProviderStatusCode,
  ShipmentStatus
} from '@platform/core/domain'

import { C807_STATUS_CATALOG } from './c807-constants'
import { c807Instant, c807StatusOf, toCarrierEvent } from './c807-status'

describe('the status of C807', () => {
  it('stores every code the way a mapping looks it up, once, with a target a carrier can report', () => {
    const codes = C807_STATUS_CATALOG.map(entry => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const entry of C807_STATUS_CATALOG) {
      expect(entry.code).toBe(normalizeProviderStatusCode(entry.code))
      if (entry.defaultStatus !== null) {
        expect(CarrierReportableStatuses).toContain(entry.defaultStatus)
      }
    }
  })

  it('lists the nine codes and the 33 reasons C807 sent', () => {
    const plain = C807_STATUS_CATALOG.filter(entry => !entry.code.includes(':'))
    expect(plain.map(entry => entry.code).sort()).toEqual([
      '10',
      '11',
      '13',
      '14',
      '15',
      '16',
      '19',
      '20',
      '21'
    ])
    const reasons = C807_STATUS_CATALOG.filter(entry => entry.code.startsWith('16:'))
    expect(reasons).toHaveLength(33)
    expect(reasons[0]?.code).toBe('16:100')
    expect(reasons.at(-1)?.code).toBe('16:132')
  })

  it.each([
    ['10', undefined, ShipmentStatus.LABEL_CREATED],
    ['13', undefined, ShipmentStatus.PICKED_UP],
    ['19', undefined, ShipmentStatus.IN_TRANSIT],
    ['14', undefined, ShipmentStatus.OUT_FOR_DELIVERY],
    ['15', undefined, ShipmentStatus.DELIVERED],
    ['15', 'devolucion', ShipmentStatus.RETURNED],
    ['16', '115', ShipmentStatus.FAILED_ATTEMPT],
    ['16', '110', ShipmentStatus.RETURNING],
    ['16', '112', ShipmentStatus.RETURNING],
    ['16', undefined, ShipmentStatus.FAILED_ATTEMPT]
  ])('code %s with reason %s means %s', (code, reason, expected) => {
    expect(c807StatusOf(code, reason)).toBe(expected)
  })

  it('does not assume what a lost, stolen or damaged package means', () => {
    for (const reason of ['101', '107', '114', '121', '124', '125']) {
      expect(c807StatusOf('16', reason)).toBeNull()
    }
  })

  it('leaves a code it does not know to the owner, and a reason it does not know to the code', () => {
    expect(c807StatusOf('99')).toBeNull()
    expect(c807StatusOf('16', '999')).toBe(ShipmentStatus.FAILED_ATTEMPT)
  })

  it('puts the zone of C807 on a date that has none, and drops one that is not a date', () => {
    expect(c807Instant('2022-02-17 12:16:35')).toBe('2022-02-17T12:16:35-06:00')
    expect(c807Instant('yesterday')).toBeNull()
    expect(c807Instant('2022-13-45 99:99:99')).toBeNull()
  })

  it('names the reason of an event only when it changes what it means', () => {
    expect(
      toCarrierEvent({ code: '15', returned: true, date: '2026-12-02 10:00:00' })
    ).toMatchObject({
      status: ShipmentStatus.RETURNED,
      rawStatus: '15',
      rawReason: 'devolucion'
    })
    expect(
      toCarrierEvent({ code: '15', returned: false, date: '2026-12-02 10:00:00' })
    ).not.toHaveProperty('rawReason')
    expect(
      toCarrierEvent({ code: '13', reason: '115', date: '2026-12-02 10:00:00' })
    ).not.toHaveProperty('rawReason')
    expect(
      toCarrierEvent({ code: '16', reason: '115', date: '2026-12-02 10:00:00' })
    ).toMatchObject({
      rawReason: '115'
    })
  })

  it('drops an event with no moment', () => {
    expect(toCarrierEvent({ code: '13', date: 'later' })).toBeNull()
  })
})
