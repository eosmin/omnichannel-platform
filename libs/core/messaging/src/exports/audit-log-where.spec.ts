import { auditLogWhere } from './audit-log-where'
import { auditLogExportFiltersSchema } from './export-filters'

const STORE = '3f1c1c0e-7d5e-4b1c-9a6a-0d6f2a1b9c11'

describe('auditLogWhere', () => {
  it('always starts from the store, with or without filters', () => {
    expect(auditLogWhere(STORE, {})).toEqual({ storeId: STORE })
  })

  it('adds each filter, and the range as inclusive start and exclusive end', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const before = new Date('2026-02-01T00:00:00.000Z')
    expect(
      auditLogWhere(STORE, {
        action: 'order.cancelled',
        userId: 'u',
        resourceType: 'order',
        resourceId: 'o',
        from,
        before
      })
    ).toEqual({
      storeId: STORE,
      action: 'order.cancelled',
      userId: 'u',
      resourceType: 'order',
      resourceId: 'o',
      timestamp: { gte: from, lt: before }
    })
    expect(auditLogWhere(STORE, { before })).toEqual({ storeId: STORE, timestamp: { lt: before } })
  })

  it('cannot be pointed at another store by a filter: the store is not one', () => {
    const where = auditLogWhere(STORE, { storeId: 'other' } as never)
    expect(where.storeId).toBe(STORE)
    expect(auditLogExportFiltersSchema.safeParse({ storeId: 'other' }).success).toBe(false)
  })
})

describe('auditLogExportFiltersSchema', () => {
  it('reads what the api writes and refuses what does not fit', () => {
    expect(
      auditLogExportFiltersSchema.safeParse({ action: 'x', from: '2026-01-01T00:00:00.000Z' })
        .success
    ).toBe(true)
    expect(auditLogExportFiltersSchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
    expect(auditLogExportFiltersSchema.safeParse({ userId: 'not-a-uuid' }).success).toBe(false)
  })
})
