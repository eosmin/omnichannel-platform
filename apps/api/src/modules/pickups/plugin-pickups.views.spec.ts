import { PickupStatus } from '@platform/core/domain'

import type { PickupView } from './pickups.views'
import { pluginPickupManifest, pluginPickupView } from './plugin-pickups.views'

const pickup = (): PickupView => ({
  id: 'p-1',
  connectionId: 'c-1',
  connectionName: 'Courier',
  carrierId: 'carrier-x',
  pickupDate: '2031-01-01',
  status: PickupStatus.REQUESTED,
  packageCount: 2,
  revision: 1,
  providerPickupId: 'prov-1',
  windowStart: '09:00',
  windowEnd: '12:00',
  requestedBy: 'user-staff-1',
  lastError: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z'
})

describe('the pickups a plugin reads', () => {
  it('drops the person who asked for it', () => {
    const view = pluginPickupView(pickup())

    expect('requestedBy' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('user-staff')
    expect(view).toMatchObject({ id: 'p-1', status: PickupStatus.REQUESTED, packageCount: 2 })
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...pickup(), storeId: 'store-secret' }

    expect(Object.keys(pluginPickupView(extra)).sort()).toEqual(
      Object.keys(pluginPickupView(pickup())).sort()
    )
  })

  it('names the manifest lines one by one', () => {
    const manifest = {
      pickupId: 'p-1',
      connectionName: 'Courier',
      pickupDate: '2031-01-01',
      status: PickupStatus.REQUESTED,
      packageCount: 1,
      windowStart: null,
      windowEnd: null,
      lines: [
        {
          shipmentId: 's-1',
          guideNumber: 'G-1',
          recipient: 'Ana',
          orderNumber: 'ORD-1',
          packageCount: 1,
          phone: '70000000'
        }
      ]
    }

    const view = pluginPickupManifest(manifest)

    expect(view.lines[0]).toEqual({
      shipmentId: 's-1',
      guideNumber: 'G-1',
      recipient: 'Ana',
      orderNumber: 'ORD-1',
      packageCount: 1
    })
    expect(JSON.stringify(view)).not.toContain('70000000')
    expect(Object.keys(view).sort()).toEqual(
      [
        'connectionName',
        'lines',
        'packageCount',
        'pickupDate',
        'pickupId',
        'status',
        'windowEnd',
        'windowStart'
      ].sort()
    )
    expect(
      Object.keys(
        pluginPickupManifest({ ...manifest, requestedBy: 'u-1' } as typeof manifest)
      ).sort()
    ).toEqual(Object.keys(view).sort())
  })
})
