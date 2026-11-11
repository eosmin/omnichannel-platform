import { ShipmentKind, ShipmentStatus } from '@platform/core/domain'

import { findShipmentOfEvent, ShipmentLookupKinds } from './shipment-lookup'

interface Where {
  providerShipmentId?: string
  guideNumber?: string
  order?: { orderNumber: string }
  status?: { notIn: string[] }
  storeId: string
  connectionId: string
  kind: string
}

// A client whose `shipment.findMany` answers from the table of rows it is given, by the keys of the `where`
function client(
  rows: {
    id: string
    providerShipmentId?: string
    guideNumber?: string
    orderNumber?: string
    status?: string
  }[]
) {
  const calls: Where[] = []
  return {
    calls,
    client: {
      shipment: {
        findMany: ({ where, take }: { where: Where; take: number }) => {
          calls.push(where)
          const hit = rows.filter(
            row =>
              (where.providerShipmentId === undefined ||
                row.providerShipmentId === where.providerShipmentId) &&
              (where.guideNumber === undefined || row.guideNumber === where.guideNumber) &&
              (where.order === undefined || row.orderNumber === where.order.orderNumber) &&
              (where.status === undefined || !where.status.notIn.includes(row.status ?? ''))
          )
          return Promise.resolve(hit.slice(0, take).map(row => ({ id: row.id })))
        }
      }
    } as never
  }
}

const scope = { storeId: 's1', connectionId: 'c1' }

describe('findShipmentOfEvent', () => {
  it('names the store, the connection and the kind in every read', async () => {
    const { client: db, calls } = client([{ id: 'a', guideNumber: 'G1' }])

    await findShipmentOfEvent(db, scope, { guideNumber: 'G1' })

    expect(calls[0]).toMatchObject({ ...scope, kind: ShipmentKind.OUTBOUND })
  })

  it('prefers the id of the carrier, then the guide number, then the order number', async () => {
    const { client: db } = client([
      { id: 'by-provider', providerShipmentId: 'P1' },
      { id: 'by-guide', guideNumber: 'G1' },
      { id: 'by-order', orderNumber: 'O1', status: ShipmentStatus.LABEL_CREATED }
    ])

    expect(
      await findShipmentOfEvent(db, scope, {
        providerShipmentId: 'P1',
        guideNumber: 'G1',
        reference: 'O1'
      })
    ).toEqual({ kind: ShipmentLookupKinds.FOUND, shipmentId: 'by-provider' })
    expect(
      await findShipmentOfEvent(db, scope, { providerShipmentId: 'nope', guideNumber: 'G1' })
    ).toEqual({
      kind: ShipmentLookupKinds.FOUND,
      shipmentId: 'by-guide'
    })
    expect(await findShipmentOfEvent(db, scope, { reference: 'O1' })).toEqual({
      kind: ShipmentLookupKinds.FOUND,
      shipmentId: 'by-order'
    })
  })

  it('does not let an order number rescue a guide or an id that names none of ours', async () => {
    const { client: db } = client([
      { id: 'live', orderNumber: 'O1', status: ShipmentStatus.PICKED_UP }
    ])

    expect(await findShipmentOfEvent(db, scope, { guideNumber: 'STALE', reference: 'O1' })).toEqual(
      {
        kind: ShipmentLookupKinds.UNKNOWN
      }
    )
    expect(
      await findShipmentOfEvent(db, scope, { providerShipmentId: 'STALE', reference: 'O1' })
    ).toEqual({ kind: ShipmentLookupKinds.UNKNOWN })
  })

  it('does not look up a blank name', async () => {
    const { client: db, calls } = client([{ id: 'a', guideNumber: '' }])

    const found = await findShipmentOfEvent(db, scope, {
      providerShipmentId: '',
      guideNumber: '',
      reference: ''
    })

    expect(found).toEqual({ kind: ShipmentLookupKinds.UNKNOWN })
    expect(calls).toHaveLength(0)
  })

  it('is unknown when nothing answers, and ambiguous when a name matches two', async () => {
    const { client: db } = client([
      { id: 'a', guideNumber: 'DUP' },
      { id: 'b', guideNumber: 'DUP' },
      { id: 'c', providerShipmentId: 'PDUP' },
      { id: 'd', providerShipmentId: 'PDUP' },
      { id: 'e', orderNumber: 'ODUP', status: ShipmentStatus.IN_TRANSIT },
      { id: 'f', orderNumber: 'ODUP', status: ShipmentStatus.LABEL_CREATED }
    ])

    expect(await findShipmentOfEvent(db, scope, { guideNumber: 'none' })).toEqual({
      kind: ShipmentLookupKinds.UNKNOWN
    })
    expect(await findShipmentOfEvent(db, scope, { guideNumber: 'DUP' })).toEqual({
      kind: ShipmentLookupKinds.AMBIGUOUS
    })
    expect(await findShipmentOfEvent(db, scope, { providerShipmentId: 'PDUP' })).toEqual({
      kind: ShipmentLookupKinds.AMBIGUOUS
    })
    expect(await findShipmentOfEvent(db, scope, { reference: 'ODUP' })).toEqual({
      kind: ShipmentLookupKinds.AMBIGUOUS
    })
  })

  it('does not take a package that is over for the one an order number names', async () => {
    const { client: db } = client([
      { id: 'old', orderNumber: 'O2', status: ShipmentStatus.CANCELLED },
      { id: 'live', orderNumber: 'O2', status: ShipmentStatus.PICKED_UP }
    ])

    expect(await findShipmentOfEvent(db, scope, { reference: 'O2' })).toEqual({
      kind: ShipmentLookupKinds.FOUND,
      shipmentId: 'live'
    })
  })
})
