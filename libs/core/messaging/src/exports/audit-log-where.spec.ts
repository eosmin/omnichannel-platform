import { auditLogMatches, auditLogWhere } from './audit-log-where'
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
})

describe('auditLogExportFiltersSchema', () => {
  it('has no field for the store: the row of the export says it, never the filters', () => {
    expect(auditLogExportFiltersSchema.safeParse({ storeId: 'other' }).success).toBe(false)
  })

  it('reads what the api writes and refuses what does not fit', () => {
    expect(
      auditLogExportFiltersSchema.safeParse({ action: 'x', from: '2026-01-01T00:00:00.000Z' })
        .success
    ).toBe(true)
    expect(auditLogExportFiltersSchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
    expect(auditLogExportFiltersSchema.safeParse({ userId: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('auditLogMatches', () => {
  const entry = {
    storeId: STORE,
    action: 'order.cancelled',
    userId: 'u',
    resourceType: 'order',
    resourceId: 'o',
    timestamp: new Date('2026-01-15T00:00:00.000Z')
  }

  it('never matches an entry of another store or with no store, whatever the filters', () => {
    expect(auditLogMatches(STORE, {}, entry)).toBe(true)
    expect(auditLogMatches(STORE, {}, { ...entry, storeId: 'other' })).toBe(false)
    expect(auditLogMatches(STORE, {}, { ...entry, storeId: null })).toBe(false)
  })

  it('reads each filter exactly, like the where of the database', () => {
    expect(auditLogMatches(STORE, { action: 'order.cancelled' }, entry)).toBe(true)
    expect(auditLogMatches(STORE, { action: 'order' }, entry)).toBe(false)
    expect(auditLogMatches(STORE, { userId: 'x' }, entry)).toBe(false)
    expect(auditLogMatches(STORE, { userId: 'u' }, { ...entry, userId: null })).toBe(false)
    expect(auditLogMatches(STORE, { resourceType: 'order', resourceId: 'o' }, entry)).toBe(true)
    expect(auditLogMatches(STORE, { resourceId: 'x' }, entry)).toBe(false)
    expect(auditLogMatches(STORE, { resourceType: 'x' }, entry)).toBe(false)
  })

  it('takes the start of the range in and leaves the end out', () => {
    const at = entry.timestamp
    expect(auditLogMatches(STORE, { from: at }, entry)).toBe(true)
    expect(auditLogMatches(STORE, { before: at }, entry)).toBe(false)
    expect(auditLogMatches(STORE, { from: new Date(at.getTime() + 1) }, entry)).toBe(false)
    expect(auditLogMatches(STORE, { before: new Date(at.getTime() + 1) }, entry)).toBe(true)
  })
})
