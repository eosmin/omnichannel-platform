import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChainProblem,
  FinanceCountryCodes,
  JournalEntryType,
  PeriodStatus
} from '@platform/core/domain'

import { tamperWithLedger } from '../builders/finance'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ChainBody {
  ok: boolean
  break: { reason: string } | null
  frozenHeads: { year: number; month: number; present: boolean }[]
}

const OK = 200
const CREATED = 201
const CASH = '1101'
const RENT = '6105'

// HC-115 (TDD_18 §11): the head a month froze when it was closed is still watched after the month is reopened. A reopen keeps the record
// of the close, and the entries up to that head are immutable, so a head that is no longer in the chain says entries were removed.
describe('The frozen head of a reopened month (HC-115)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)

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

  it('finds entries removed from the end of a month that was closed and opened again', async () => {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id, code: { in: [CASH, RENT] } },
      select: { id: true, code: true }
    })
    const id = (code: string): string => rows.find(row => row.code === code)?.id ?? ''
    for (const cents of [500, 700]) {
      const posted = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send({
          idempotencyKey: `k-${randomUUID()}`,
          entryDate: '2026-01-15',
          type: JournalEntryType.MANUAL,
          memo: 'Entry of the suite',
          lines: [
            { accountId: id(RENT), debitCents: cents },
            { accountId: id(CASH), creditCents: cents }
          ]
        })
      expect(posted.status).toBe(CREATED)
    }
    const january = await owner.fiscalPeriod.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 1 }
    })
    expect(
      (await asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({})).status
    ).toBe(OK)
    const reopened = await asAdminA()
      .post(ApiRoutes.finance.periods.reopen(january.id))
      .send({ reason: 'A correction' })
    expect(reopened.status).toBe(OK)
    expect((await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: january.id } })).status).toBe(
      PeriodStatus.OPEN
    )
    const sound = (await asAdminA().post(ApiRoutes.finance.reports.verifyChain).send({}))
      .body as ChainBody
    expect(sound.ok).toBe(true)
    expect(sound.frozenHeads.map(({ year, month, present }) => ({ year, month, present }))).toEqual(
      [{ year: 2026, month: 1, present: true }]
    )

    // Someone with the owner role of the database removes the last entry and puts the head of the books back where it was
    const org = ctx.orgA.id
    await tamperWithLedger(owner, [
      `DELETE FROM journal_lines WHERE organization_id = '${org}' AND entry_id = (SELECT id FROM journal_entries WHERE organization_id = '${org}' ORDER BY number DESC LIMIT 1)`,
      `DELETE FROM journal_entries WHERE organization_id = '${org}' AND number = (SELECT MAX(number) FROM journal_entries WHERE organization_id = '${org}')`,
      `UPDATE finance_settings SET last_entry_hash = (SELECT hash FROM journal_entries WHERE organization_id = '${org}' ORDER BY number DESC LIMIT 1), next_entry_number = (SELECT MAX(number) + 1 FROM journal_entries WHERE organization_id = '${org}') WHERE organization_id = '${org}'`
    ])

    const cut = (await asAdminA().post(ApiRoutes.finance.reports.verifyChain).send({}))
      .body as ChainBody
    expect(cut.break?.reason).toBe(ChainProblem.FROZEN_HEAD_MISSING)
    expect(cut.frozenHeads.map(frozen => frozen.present)).toEqual([false])
  })
})
