import {
  AuditColdExport,
  ComplianceConfig,
  DataRetentionPolicies,
  dsrExecutorAvailable,
  dsrPublicFlowReady
} from './compliance-constants'
import { OrderDocumentRetention } from './order-document-retention'

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

  // The public form needs more than the sweep (the alert of day 25, the notices of a request given back, access and portability): its own
  // switch stays false until H2b-2 ships, and the env schema refuses the flag while it is
  it('does not open the public flow: that is the switch of the PR that finishes H2b', () => {
    expect(dsrPublicFlowReady()).toBe(false)
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
  it('keeps orders for the ten years of the tax period (CT art. 147) and never lets them be configured', () => {
    expect(DataRetentionPolicies.ORDERS).toEqual({ defaultDays: 3650, configurable: false })
  })

  it('names the same period as the sweep of the documents of orders (years of 365 days at least)', () => {
    expect(DataRetentionPolicies.ORDERS.defaultDays).toBeGreaterThanOrEqual(
      OrderDocumentRetention.LEGAL_YEARS * 365
    )
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
