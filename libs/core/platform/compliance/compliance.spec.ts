import {
  AuditColdExport,
  ComplianceConfig,
  DataRetentionPolicies,
  dsrExecutorAvailable
} from './compliance-constants'

describe('ComplianceConfig', () => {
  it('alerts before the response deadline', () => {
    expect(ComplianceConfig.DSR_DEADLINE_ALERT_DAY).toBeLessThan(
      ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS
    )
  })
})

describe('dsrExecutorAvailable', () => {
  // The sweep `dsr-erase-due` exists (Step 7.2-H2b-1): an erasure can be approved. The public form stays off until the owner turns the flag on
  it('is true now that the sweep that carries out an approved erasure ships', () => {
    expect(dsrExecutorAvailable()).toBe(true)
  })
})

describe('the grace period of an approved erasure', () => {
  // The owner's decision (2026-11-22, option C), pinned: a change of this number is a decision, not a refactor. It must also end well inside
  // the 30 days the law gives to answer, with no extension (the 60-day one is out of the MVP)
  it('is 7 days and ends inside the response deadline', () => {
    expect(ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS).toBe(7)
    expect(ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS).toBeLessThan(
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
