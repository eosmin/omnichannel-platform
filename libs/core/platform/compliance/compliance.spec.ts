import { ComplianceConfig, DataRetentionPolicies } from './compliance-constants'

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
