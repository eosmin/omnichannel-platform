import { AuditColdExport, ComplianceConfig, DataRetentionPolicies } from './compliance-constants'

describe('ComplianceConfig', () => {
  it('alerts before the response deadline', () => {
    expect(ComplianceConfig.DSR_DEADLINE_ALERT_DAY).toBeLessThan(
      ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS
    )
  })
})

describe('DataRetentionPolicies', () => {
  it('keeps orders for the tax period and never lets them be configured', () => {
    expect(DataRetentionPolicies.ORDERS).toEqual({ defaultDays: 2555, configurable: false })
  })

  it('keeps cold audit logs longer than hot ones', () => {
    expect(DataRetentionPolicies.AUDIT_LOGS_COLD.defaultDays).toBeGreaterThan(
      DataRetentionPolicies.AUDIT_LOGS_HOT.defaultDays
    )
  })
})

describe('AuditColdExport', () => {
  // purge_audit_logs() (migration 20270121100000) refuses a window under 730 days and more than 5000 ids a call: a constant
  // that drifted past either would make every purge fail, and the export would write a new part on each run
  it('stays inside what the purge function of the database accepts', () => {
    expect(AuditColdExport.HOT_DAYS).toBeGreaterThanOrEqual(730)
    expect(AuditColdExport.DELETE_BATCH).toBeLessThanOrEqual(5000)
  })
})
