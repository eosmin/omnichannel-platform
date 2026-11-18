import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { FinanceCountryCodes, JournalEntryType, PeriodStatus } from '@platform/core/domain'

import { createPeriod } from '../builders/finance'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const ROUNDS = 20
const CASH = '1101'
const RENT = '6105'

// HC-020 (TDD_18 §5): closing a month and reopening the one before it, at the same time, never leaves the later month closed with the
// earlier one open. Both calls take the lock of the settings row of the organization, so one runs after the other and the second sees
// what the first did.
describe('Closing a month while the month before it is reopened (HC-020)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const statusOf = async (id: string): Promise<string> =>
    (await owner.fiscalPeriod.findUniqueOrThrow({ where: { id } })).status

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const setup = await asAdminA()
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2026-01-01' })
    expect(setup.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it(`keeps the closed months a prefix of the calendar over ${ROUNDS} rounds of the race`, async () => {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id, code: { in: [CASH, RENT] } },
      select: { id: true, code: true }
    })
    const id = (code: string): string => rows.find(row => row.code === code)?.id ?? ''
    for (const entryDate of ['2026-01-15', '2026-02-10']) {
      const posted = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send({
          idempotencyKey: `k-${randomUUID()}`,
          entryDate,
          type: JournalEntryType.MANUAL,
          memo: 'Entry of the suite',
          lines: [
            { accountId: id(RENT), debitCents: 100 },
            { accountId: id(CASH), creditCents: 100 }
          ]
        })
      expect(posted.status).toBe(CREATED)
    }
    const january = await owner.fiscalPeriod.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 1 }
    })
    const february = (await owner.fiscalPeriod.findFirst({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 2 }
    })) ?? { id: await createPeriod(owner, ctx.orgA.id, 2026, 2) }
    const close = (periodId: string) =>
      asAdminA().post(ApiRoutes.finance.periods.close(periodId)).send({})
    const reopen = (periodId: string) =>
      asAdminA()
        .post(ApiRoutes.finance.periods.reopen(periodId))
        .send({ reason: 'A round of the race' })

    expect((await close(january.id)).status).toBe(OK)
    for (let round = 0; round < ROUNDS; round += 1) {
      // January closed, February open: close February while January is reopened
      await Promise.all([close(february.id), reopen(january.id)])
      const [jan, feb] = [await statusOf(january.id), await statusOf(february.id)]
      expect([jan, feb]).not.toEqual([PeriodStatus.OPEN, PeriodStatus.CLOSED])
      const settings = await owner.financeSettings.findUniqueOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      // The lock of the books follows the last closed month, whichever call won
      const lockedThrough = settings.lockedThrough?.toISOString().slice(0, 10) ?? null
      expect(lockedThrough).toBe(
        feb === (PeriodStatus.CLOSED as string)
          ? '2026-02-28'
          : jan === (PeriodStatus.CLOSED as string)
            ? '2026-01-31'
            : null
      )
      // Back to January closed and February open, in the order the rules ask
      if (feb === (PeriodStatus.CLOSED as string))
        expect((await reopen(february.id)).status).toBe(OK)
      if ((await statusOf(january.id)) === (PeriodStatus.OPEN as string)) {
        expect((await close(january.id)).status).toBe(OK)
      }
    }
  })
})
