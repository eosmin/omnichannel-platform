import { TransferStatus } from '@platform/core/domain'

import {
  pluginTransferPage,
  pluginTransferSummary,
  pluginTransferView
} from './plugin-transfers.views'
import type { TransferSummaryView, TransferView } from './transfers.views'

const warehouse = { id: 'w-1', name: 'Main', code: 'MAIN' }
const summary = (over: Partial<TransferSummaryView> = {}): TransferSummaryView => ({
  id: 't-1',
  number: 'TR-0001',
  status: TransferStatus.IN_TRANSIT,
  fromWarehouse: warehouse,
  toWarehouse: { ...warehouse, id: 'w-2' },
  note: null,
  createdBy: 'user-staff-1',
  createdByPluginId: 'plugin-1',
  dispatchedBy: 'user-staff-2',
  dispatchedByPluginId: 'plugin-2',
  dispatchedAt: new Date('2026-11-15T00:00:00Z'),
  closedAt: null,
  createdAt: new Date('2026-11-14T00:00:00Z'),
  updatedAt: new Date('2026-11-15T00:00:00Z'),
  lineCount: 2,
  ...over
})

describe('the transfers a plugin reads', () => {
  it('drops the ids of the people who made and sent the transfer', () => {
    const view = pluginTransferSummary(summary())

    expect('createdBy' in view).toBe(false)
    expect('dispatchedBy' in view).toBe(false)
    expect('createdByPluginId' in view).toBe(false)
    expect('dispatchedByPluginId' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('user-staff')
  })

  it('keeps the fields a plugin reads', () => {
    expect(pluginTransferSummary(summary({ lineCount: 4 }))).toMatchObject({
      id: 't-1',
      number: 'TR-0001',
      status: TransferStatus.IN_TRANSIT,
      lineCount: 4
    })
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...summary(), organizationId: 'o-1', idempotencyKey: 'k' }

    expect(Object.keys(pluginTransferSummary(extra)).sort()).toEqual(
      Object.keys(pluginTransferSummary(summary())).sort()
    )
    expect(JSON.stringify(pluginTransferSummary(extra))).not.toContain('o-1')
  })

  it('answers a detail with its lines and without the people, and a page the same way', () => {
    const { lineCount, ...header } = summary()
    const detail: TransferView = {
      ...header,
      lines: [
        {
          id: 'l-1',
          storeId: 's-1',
          productId: 'p-1',
          productName: 'Chair',
          variantId: null,
          variantName: null,
          sku: null,
          quantity: 3,
          receivedQuantity: 1,
          pendingQuantity: 2,
          shortageAction: null
        }
      ]
    }

    const view = pluginTransferView(detail)
    const page = pluginTransferPage({ data: [summary()], nextCursor: 'c', hasMore: true })

    expect(lineCount).toBe(2)
    expect(view.lines).toHaveLength(1)
    expect(JSON.stringify(view)).not.toContain('user-staff')
    expect(page.nextCursor).toBe('c')
    expect(page.hasMore).toBe(true)
    expect(JSON.stringify(page)).not.toContain('user-staff')
  })
})
