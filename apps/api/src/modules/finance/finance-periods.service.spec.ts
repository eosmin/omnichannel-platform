import { AuditAction } from '@platform/core/audit'
import { ErrorCodes } from '@platform/core/errors'

import { FinancePeriodsService } from './finance-periods.service'

const ORG = 'org-1'
const PERIOD = 'period-1'
const ACTOR = { userId: 'user-1', storeId: 'store-1', ipAddress: '10.0.0.1', userAgent: 'jest' }

interface Fixture {
  startsOn: string | null
  counts?: { entries?: number; balances?: number; snapshots?: number }
  deleteError?: Error
}

// 2026-11-25 is "today" for the organization: one store in El Salvador
function build(fixture: Fixture) {
  const remove = jest.fn(() =>
    fixture.deleteError === undefined ? Promise.resolve({}) : Promise.reject(fixture.deleteError)
  )
  const tx = {
    fiscalPeriod: {
      findFirst: () =>
        Promise.resolve(
          fixture.startsOn === null
            ? null
            : {
                id: PERIOD,
                year: 2031,
                month: 1,
                startsOn: new Date(`${fixture.startsOn}T00:00:00Z`)
              }
        ),
      delete: remove
    },
    journalEntry: { count: () => Promise.resolve(fixture.counts?.entries ?? 0) },
    accountPeriodBalance: { count: () => Promise.resolve(fixture.counts?.balances ?? 0) },
    financeBookSnapshot: { count: () => Promise.resolve(fixture.counts?.snapshots ?? 0) }
  }
  const prisma = {
    client: {
      store: { findMany: () => Promise.resolve([{ timezone: 'America/El_Salvador' }]) }
    },
    transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx)
  }
  const log = jest.fn()
  const service = new FinancePeriodsService(prisma as never, { log } as never)
  return { service, remove, log }
}

describe('FinancePeriodsService.remove (FIN-052)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00Z') })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('deletes a period that has not started and nothing points at, and audits it', async () => {
    const { service, remove, log } = build({ startsOn: '2031-01-01' })

    await service.remove(ORG, PERIOD, ACTOR)

    expect(remove).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: ORG, id: PERIOD } }
    })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.FINANCE_PERIOD_DELETED,
        organizationId: ORG,
        resourceId: PERIOD,
        metadata: { year: 2031, month: 1 }
      })
    )
  })

  it('answers not found for a period that is not in the organization', async () => {
    const { service, remove } = build({ startsOn: null })

    await expect(service.remove(ORG, PERIOD, ACTOR)).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_NOT_FOUND
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it.each(['2026-11-01', '2026-11-25'])(
    'refuses a period that started on %s (today or earlier)',
    async startsOn => {
      const { service, remove, log } = build({ startsOn })

      await expect(service.remove(ORG, PERIOD, ACTOR)).rejects.toMatchObject({
        code: ErrorCodes.FINANCE_PERIOD_NOT_FUTURE
      })
      expect(remove).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    }
  )

  it('deletes the month that starts tomorrow', async () => {
    const { service, remove } = build({ startsOn: '2026-11-26' })

    await service.remove(ORG, PERIOD, ACTOR)

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an entry', { entries: 1 }],
    ['a balance', { balances: 1 }],
    ['a frozen book', { snapshots: 1 }]
  ])('refuses a future period with %s', async (_name, counts) => {
    const { service, remove, log } = build({ startsOn: '2031-01-01', counts })

    await expect(service.remove(ORG, PERIOD, ACTOR)).rejects.toMatchObject({
      code: ErrorCodes.FINANCE_PERIOD_HAS_ACTIVITY
    })
    expect(remove).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('maps a reference that appears between the check and the delete to the same refusal', async () => {
    const { service, log } = build({
      startsOn: '2031-01-01',
      deleteError: Object.assign(new Error('fk'), { code: 'P2003' })
    })

    await expect(service.remove(ORG, PERIOD, ACTOR)).rejects.toMatchObject({
      code: ErrorCodes.FINANCE_PERIOD_HAS_ACTIVITY
    })
    expect(log).not.toHaveBeenCalled()
  })

  it('lets any other database error through', async () => {
    const { service } = build({ startsOn: '2031-01-01', deleteError: new Error('boom') })

    await expect(service.remove(ORG, PERIOD, ACTOR)).rejects.toThrow('boom')
  })
})
