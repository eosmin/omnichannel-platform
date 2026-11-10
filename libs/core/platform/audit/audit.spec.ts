import { AuditAction } from './audit-actions'

describe('AuditAction', () => {
  it('uses unique dotted names', () => {
    const names: string[] = Object.values(AuditAction)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('audits the magic link instead of passwords and has no staff or billing actions', () => {
    expect(AuditAction.MAGIC_LINK_REQUESTED).toBeDefined()
    expect(AuditAction.MAGIC_LINK_CONSUMED).toBeDefined()
    const forbidden =
      /(password|subscription|payment_method|staff|impersonation|ai_|org_|feature_flag)/
    expect(Object.values(AuditAction).filter(name => forbidden.test(name))).toEqual([])
  })
})

describe('order audit actions', () => {
  it('audits the scheduled day and both internal notes with an action of their own', () => {
    expect(AuditAction.ORDER_SCHEDULE_CHANGED).toBe('order.schedule_changed')
    expect(AuditAction.ORDER_INTERNAL_NOTE_CHANGED).toBe('order.internal_note_changed')
    expect(AuditAction.ORDER_PACKING_NOTE_CHANGED).toBe('order.packing_note_changed')
  })

  it('audits a payment recorded by hand and its status, without naming a payment method', () => {
    expect(AuditAction.ORDER_PAYMENT_RECORDED).toBe('order.payment_recorded')
    expect(AuditAction.ORDER_PAYMENT_STATUS_CHANGED).toBe('order.payment_status_changed')
  })
})
