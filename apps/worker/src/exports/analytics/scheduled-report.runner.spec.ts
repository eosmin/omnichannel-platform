import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { MembershipStatus } from '@platform/core/domain'

import { ReportRunOutcomes, ScheduledReportRunner } from './scheduled-report.runner'

const STORE = '0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'
const USER = '6f1c2b7e-3c1a-4d57-9a38-0d5f7a6b1c11'
const REPORT = '9d3b7a1e-55aa-4c63-8c4e-2f9d3b7a1e01'

const report = {
  id: REPORT,
  storeId: STORE,
  createdBy: USER,
  enabled: true,
  lastSentAt: null,
  timezone: 'UTC',
  frequency: 'daily',
  metrics: [],
  format: 'csv',
  name: 'Daily',
  recipients: []
}

function build(membership: unknown) {
  const findMembership = jest.fn().mockResolvedValue(membership)
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma = {
    client: {
      scheduledReport: { findFirst: jest.fn().mockResolvedValue(report), updateMany },
      membership: { findFirst: findMembership },
      export: { create: jest.fn() }
    }
  }
  const generator = { generate: jest.fn() }
  const audit = { log: jest.fn() }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const jobContext = { forStore: jest.fn((_id: string, work: () => unknown) => work()) }
  const runner = new ScheduledReportRunner(
    prisma as never,
    generator as never,
    {} as never,
    audit as never,
    {} as never,
    logger as never,
    jobContext as never,
    { inc: jest.fn() } as never
  )
  return { runner, findMembership, updateMany, generator, audit, prisma }
}

const role = (...names: string[]): unknown => ({
  role: { permissions: names.map(name => ({ name })) }
})

describe('the person a scheduled report is made for', () => {
  it('turns the report off, and makes no file, when the membership is gone or revoked (no row answers)', async () => {
    const t = build(null)
    await expect(t.runner.run(STORE, REPORT, '2026-11-22', false)).resolves.toBe(
      ReportRunOutcomes.DISABLED
    )
    expect(t.findMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER,
          storeId: STORE,
          status: MembershipStatus.ACTIVE,
          revokedAt: null
        }
      })
    )
    expect(t.generator.generate).not.toHaveBeenCalled()
    expect(t.prisma.client.export.create).not.toHaveBeenCalled()
    expect(t.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.REPORT_DISABLED, storeId: STORE })
    )
  })

  it('turns the report off when the role lost the right to export', async () => {
    const t = build(role(Permissions.ANALYTICS_VIEW))
    await expect(t.runner.run(STORE, REPORT, '2026-11-22', false)).resolves.toBe(
      ReportRunOutcomes.DISABLED
    )
    expect(t.generator.generate).not.toHaveBeenCalled()
  })

  it('turns the report off when the role lost the right to view', async () => {
    const t = build(role(Permissions.ANALYTICS_EXPORT))
    await expect(t.runner.run(STORE, REPORT, '2026-11-22', false)).resolves.toBe(
      ReportRunOutcomes.DISABLED
    )
  })

  it('does not turn the report off when the read of the permissions fails (the job is tried again)', async () => {
    const t = build(null)
    t.findMembership.mockRejectedValueOnce(new Error('database down'))
    await expect(t.runner.run(STORE, REPORT, '2026-11-22', false)).rejects.toThrow('database down')
    expect(t.updateMany).not.toHaveBeenCalled()
  })
})
