import { RemittanceStatus } from '@platform/core/domain'

import {
  pluginImportProfileView,
  pluginPendingConnectionView,
  pluginRemittanceDetailView,
  pluginRemittancePage,
  pluginRemittanceView
} from './plugin-remittances.views'
import type { RemittanceDetailView, RemittanceView } from './remittances.views'

const remittance = (over: Partial<RemittanceView> = {}): RemittanceView => ({
  id: 'rm-1',
  connectionId: 'cn-1',
  connectionName: 'Carrier',
  carrierId: 'carrier',
  status: RemittanceStatus.CONFIRMED,
  reference: 'REF-1',
  receivedOn: '2026-11-14',
  importProfileId: null,
  sourceMediaId: 'media-1',
  totals: { expectedCents: 1000, reportedCents: 900, feeCents: 50, differenceCents: -100 },
  lineCount: 2,
  note: null,
  createdBy: 'user-staff-1',
  createdAt: '2026-11-14T00:00:00.000Z',
  confirmedAt: '2026-11-15T00:00:00.000Z',
  confirmedBy: 'user-staff-2',
  voidedAt: null,
  voidedBy: 'user-staff-3',
  voidReason: null,
  ...over
})

describe('the remittances a plugin reads', () => {
  it('drops the ids of the people who made, confirmed and voided it, and the imported file', () => {
    const out = pluginRemittanceView(remittance())
    const text = JSON.stringify(out)

    for (const key of ['createdBy', 'confirmedBy', 'voidedBy', 'sourceMediaId']) {
      expect(key in out).toBe(false)
    }
    expect(text).not.toMatch(/user-staff|media-1/)
  })

  it('keeps the amounts, which are what the scope is for', () => {
    const out = pluginRemittanceView(remittance())

    expect(out.totals).toEqual({
      expectedCents: 1000,
      reportedCents: 900,
      feeCents: 50,
      differenceCents: -100
    })
    expect(out.status).toBe('confirmed')
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...remittance(), bankAccount: '123' }

    expect(Object.keys(pluginRemittanceView(extra)).sort()).toEqual(
      Object.keys(pluginRemittanceView(remittance())).sort()
    )
  })

  it('keeps the lines of a detail and cleans its head', () => {
    const detail: RemittanceDetailView = {
      ...remittance(),
      lines: [
        {
          id: 'ln-1',
          position: 1,
          guideNumber: 'G-1',
          shipmentId: null,
          orderNumber: null,
          reportedCents: 500,
          reportedFeeCents: null,
          expectedCents: null,
          differenceCents: null,
          outcome: 'not_found',
          excluded: false,
          note: null,
          warnings: ['FEE_EXCEEDS_COLLECTED']
        }
      ] as RemittanceDetailView['lines']
    }
    const out = pluginRemittanceDetailView(detail)

    expect(out.lines).toHaveLength(1)
    // The warning is derived from the line's own amounts and carries nothing of the customer: it passes through
    expect(out.lines[0]?.warnings).toEqual(['FEE_EXCEEDS_COLLECTED'])
    expect('createdBy' in out).toBe(false)
  })

  it('keeps the paging of a page and cleans each row', () => {
    const page = pluginRemittancePage({ data: [remittance()], nextCursor: null, hasMore: false })

    expect(page.hasMore).toBe(false)
    expect(JSON.stringify(page)).not.toContain('createdBy')
  })

  it('names the fields of the pending list, of a line and of a profile one by one', () => {
    const pending = pluginPendingConnectionView({
      connectionId: 'cn-1',
      connectionName: 'Carrier',
      carrierId: 'carrier',
      count: 1,
      totalOwedCents: 100,
      oldestDeliveredAt: null,
      oldestAgeDays: null,
      truncated: false,
      operator: 'x',
      shipments: [
        {
          shipmentId: 's-1',
          orderNumber: '00041',
          guideNumber: 'G-1',
          codStatus: 'pending',
          expectedCents: 100,
          remittedCents: null,
          owedCents: 100,
          deliveredAt: null,
          ageDays: null,
          recipient: 'x'
        }
      ]
    } as never)
    const profile = pluginImportProfileView({
      id: 'p-1',
      connectionId: 'cn-1',
      name: 'Statement',
      delimiter: ',',
      hasHeader: true,
      decimalSeparator: '.',
      dateFormat: 'iso',
      columns: { guideNumber: 'Guia', amount: 'Monto' },
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
      createdBy: 'user-staff-1'
    } as never)

    expect(JSON.stringify(pending)).not.toMatch(/operator|recipient/)
    expect(JSON.stringify(profile)).not.toMatch(/createdBy|user-staff/)
    expect(profile.columns).toEqual({ guideNumber: 'Guia', amount: 'Monto' })
  })
})
