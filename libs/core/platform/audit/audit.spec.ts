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
