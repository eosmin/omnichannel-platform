import { AuditAction } from '../audit'

import { ExportAuditActions, ExportStatus, ExportTypes } from './job-types'

describe('exports', () => {
  it('audits every export type with its own action', () => {
    expect(Object.keys(ExportAuditActions).sort()).toEqual(Object.values(ExportTypes).sort())
    expect(ExportAuditActions[ExportTypes.CUSTOMERS]).toBe(AuditAction.CUSTOMER_EXPORTED)
    expect(ExportAuditActions[ExportTypes.MEDIA_ZIP]).toBe(AuditAction.MEDIA_BULK_DOWNLOADED)
  })

  it('goes from pending to ready, failed or expired', () => {
    expect(Object.values(ExportStatus)).toEqual(['pending', 'ready', 'failed', 'expired'])
  })
})
