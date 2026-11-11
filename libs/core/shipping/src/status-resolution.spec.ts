import { ShipmentStatus } from '@platform/core/domain'

import {
  resolveProviderStatus,
  StatusResolutionKinds,
  StatusResolutionSources
} from './status-resolution'

const table = (entries: [string, ShipmentStatus | null][]) => new Map(entries)

describe('resolveProviderStatus', () => {
  it('uses the mapping of the connection before the status of the plugin', () => {
    const resolved = resolveProviderStatus(
      { rawStatus: 'Entregado', status: ShipmentStatus.IN_TRANSIT },
      table([['entregado', ShipmentStatus.DELIVERED]])
    )
    expect(resolved).toEqual({
      kind: StatusResolutionKinds.MAPPED,
      status: ShipmentStatus.DELIVERED,
      source: StatusResolutionSources.CONNECTION,
      code: 'entregado'
    })
  })

  it('finds one code however the carrier spells it', () => {
    const mappings = table([['entregado', ShipmentStatus.DELIVERED]])
    for (const spelling of ['Entregado', 'ENTREGADO ', ' entregádo', 'ENTREGADO']) {
      expect(resolveProviderStatus({ rawStatus: spelling, status: null }, mappings)).toMatchObject({
        kind: StatusResolutionKinds.MAPPED,
        status: ShipmentStatus.DELIVERED
      })
    }
  })

  it('tries the composite code of a reason first and the plain status second', () => {
    const mappings = table([
      ['16', ShipmentStatus.FAILED_ATTEMPT],
      ['16:115', ShipmentStatus.RETURNED]
    ])
    expect(
      resolveProviderStatus({ rawStatus: '16', rawReason: '115', status: null }, mappings)
    ).toMatchObject({ status: ShipmentStatus.RETURNED, code: '16:115' })
    expect(
      resolveProviderStatus({ rawStatus: '16', rawReason: '120', status: null }, mappings)
    ).toMatchObject({ status: ShipmentStatus.FAILED_ATTEMPT, code: '16' })
  })

  it('lets the owner ignore one reason alone, and a composite row beats a plain row that says ignore', () => {
    const mappings = table([
      ['16', null],
      ['16:115', ShipmentStatus.RETURNED],
      ['16:117', null]
    ])
    expect(
      resolveProviderStatus(
        { rawStatus: '16', rawReason: '117', status: ShipmentStatus.FAILED_ATTEMPT },
        mappings
      )
    ).toEqual({ kind: StatusResolutionKinds.IGNORED, code: '16:117' })
    expect(
      resolveProviderStatus({ rawStatus: '16', rawReason: '115', status: null }, mappings)
    ).toMatchObject({ kind: StatusResolutionKinds.MAPPED, status: ShipmentStatus.RETURNED })
    expect(
      resolveProviderStatus({ rawStatus: '16', rawReason: '999', status: null }, mappings)
    ).toEqual({ kind: StatusResolutionKinds.IGNORED, code: '16' })
  })

  it('ignores an empty reason', () => {
    expect(
      resolveProviderStatus(
        { rawStatus: '16', rawReason: '  ', status: null },
        table([['16', ShipmentStatus.FAILED_ATTEMPT]])
      )
    ).toMatchObject({ status: ShipmentStatus.FAILED_ATTEMPT, code: '16' })
  })

  it('lets the owner ignore a code on purpose, even when the plugin has a status for it', () => {
    expect(
      resolveProviderStatus(
        { rawStatus: 'En ruta', status: ShipmentStatus.IN_TRANSIT },
        table([['en ruta', null]])
      )
    ).toEqual({ kind: StatusResolutionKinds.IGNORED, code: 'en ruta' })
  })

  it('falls back to the status the plugin gave the event', () => {
    expect(
      resolveProviderStatus({ rawStatus: 'ENT', status: ShipmentStatus.DELIVERED }, table([]))
    ).toEqual({
      kind: StatusResolutionKinds.MAPPED,
      status: ShipmentStatus.DELIVERED,
      source: StatusResolutionSources.PLUGIN,
      code: 'ent'
    })
  })

  it('is unmapped with no row and no status, under the composite code when there is a reason', () => {
    expect(resolveProviderStatus({ rawStatus: 'Zzz', status: null }, table([]))).toEqual({
      kind: StatusResolutionKinds.UNMAPPED,
      code: 'zzz'
    })
    expect(
      resolveProviderStatus({ rawStatus: '16', rawReason: '199', status: null }, table([]))
    ).toEqual({ kind: StatusResolutionKinds.UNMAPPED, code: '16:199' })
  })
})
