import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { ApiRoutes } from '@platform/core/api'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import { FinanceCountryCodes, FinanceReportLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'

import { FinanceReportGate } from '../../apps/api/src/modules/finance/finance-report-gate.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const TOO_MANY_REQUESTS = 429
const MOST = FinanceReportLimits.MAX_CONCURRENT_READS_PER_ORGANIZATION
const RANGE = { from: '2026-01-01', to: '2026-01-31' }

interface Held {
  release: () => void
  finished: Promise<unknown>
}

// The cap of the reports of Finance that one organization reads at once (Step 7.3-D, debt (f) of F6-3), on the real Redis and the real app
describe('The cap of finance report reads per organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let gate: FinanceReportGate
  let redis: Redis

  const slots = (organizationId: string): Promise<number> =>
    redis.zcard(CacheKeys.financeReports.readSlots(organizationId))

  // A report that holds its place until it is told to leave
  function hold(organizationId: string): Held {
    let release: () => void = () => undefined
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    return { release, finished: gate.read(organizationId, () => waiting) }
  }
  async function holdAll(organizationId: string, count: number): Promise<Held[]> {
    const held = Array.from({ length: count }, () => hold(organizationId))
    // The places are taken before the first answer: wait until Redis says so
    for (let attempt = 0; attempt < 100 && (await slots(organizationId)) < count; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return held
  }
  const leave = async (held: Held[]): Promise<void> => {
    held.forEach(one => one.release())
    await Promise.all(held.map(one => one.finished))
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    gate = app.get(FinanceReportGate, { strict: false })
    redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
  })
  afterAll(async () => {
    await redis.del(
      CacheKeys.financeReports.readSlots(ctx.orgA.id),
      CacheKeys.financeReports.readSlots(ctx.orgB.id),
      CacheKeys.financeReports.streamSlots(ctx.orgA.id)
    )
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asA = () => api(app, ctx.adminA, ctx.storeA)

  it('answers the reports as usual while the organization is under the cap, and leaves no place behind', async () => {
    const held = await holdAll(ctx.orgA.id, MOST - 1)
    for (const route of [
      ApiRoutes.finance.reports.margin,
      ApiRoutes.finance.reports.vat,
      ApiRoutes.finance.reports.marginCsv,
      ApiRoutes.finance.reports.vatCsv
    ]) {
      const response = await asA().get(route).query(RANGE)
      expect(response.status).toBe(OK)
    }
    await leave(held)
    expect(await slots(ctx.orgA.id)).toBe(0)
  })

  it('refuses the next read with its own code and a retry time, on every route of the family, and answers again when one leaves', async () => {
    const held = await holdAll(ctx.orgA.id, MOST)
    const routes = [
      ApiRoutes.finance.reports.margin,
      ApiRoutes.finance.reports.marginCsv,
      ApiRoutes.finance.reports.vat,
      ApiRoutes.finance.reports.vatCsv
    ]
    for (const route of routes) {
      const refused = await asA().get(route).query(RANGE)
      expect(refused.status).toBe(TOO_MANY_REQUESTS)
      const error = (
        refused.body as { error: { code: string; metadata: { retryAfterSeconds: number } } }
      ).error
      expect(error.code).toBe(ErrorCodes.FINANCE_REPORT_BUSY)
      expect(error.metadata.retryAfterSeconds).toBe(FinanceReportLimits.READ_BUSY_RETRY_SECONDS)
    }
    const aging = await asA()
      .get(ApiRoutes.finance.reports.aging)
      .query({ kind: 'payables', asOf: RANGE.to })
    expect(aging.status).toBe(TOO_MANY_REQUESTS)
    // The refusals took no place of their own
    expect(await slots(ctx.orgA.id)).toBe(MOST)

    held[0]?.release()
    await held[0]?.finished
    const again = await asA().get(ApiRoutes.finance.reports.margin).query(RANGE)
    expect(again.status).toBe(OK)
    await leave(held.slice(1))
    expect(await slots(ctx.orgA.id)).toBe(0)
  })

  it('counts each organization on its own: a full organization does not stop another', async () => {
    const held = await holdAll(ctx.orgA.id, MOST)
    const other = await api(app, ctx.adminB, ctx.storeB)
      .get(ApiRoutes.finance.reports.vat)
      .query(RANGE)
    expect(other.status).toBe(OK)
    await leave(held)
  })

  it('lets exactly the cap through when many ask at the same moment (the script is one step for Redis)', async () => {
    const release: (() => void)[] = []
    const asks = Array.from({ length: MOST * 3 }, () =>
      gate
        .read(
          ctx.orgB.id,
          () =>
            new Promise<void>(resolve => {
              release.push(resolve)
            })
        )
        .then(
          () => 'granted',
          (error: unknown) => (error as { code?: string }).code ?? 'other'
        )
    )
    // Give every ask time to reach Redis: the refused ones answer at once, the granted ones wait
    for (let attempt = 0; attempt < 100 && release.length < MOST; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(release).toHaveLength(MOST)
    release.forEach(resolve => resolve())
    const outcomes = await Promise.all(asks)
    expect(outcomes.filter(outcome => outcome === 'granted')).toHaveLength(MOST)
    expect(outcomes.filter(outcome => outcome === ErrorCodes.FINANCE_REPORT_BUSY)).toHaveLength(
      MOST * 2
    )
    expect(await slots(ctx.orgB.id)).toBe(0)
  })

  it('gives the place back when the report fails, so failures never fill the cap', async () => {
    for (let attempt = 0; attempt < MOST + 2; attempt += 1) {
      await expect(
        gate.read(ctx.orgA.id, () => Promise.reject(new Error('the query failed')))
      ).rejects.toThrow('the query failed')
    }
    expect(await slots(ctx.orgA.id)).toBe(0)
    expect((await asA().get(ApiRoutes.finance.reports.margin).query(RANGE)).status).toBe(OK)
  })

  it('drops the places of a process that died: a place nobody renewed for longer than the expiry does not count', async () => {
    const key = CacheKeys.financeReports.readSlots(ctx.orgA.id)
    const stale = Date.now() - FinanceReportLimits.READ_SLOT_TTL_MS - 1000
    for (let index = 0; index < MOST; index += 1)
      await redis.zadd(key, stale, `dead-${String(index)}`)
    expect(await slots(ctx.orgA.id)).toBe(MOST)

    expect((await asA().get(ApiRoutes.finance.reports.margin).query(RANGE)).status).toBe(OK)
    expect(await slots(ctx.orgA.id)).toBe(0)
  })

  it('takes a place of the reads for the CSV of a ledger too: a full organization is refused before the account is looked up', async () => {
    const held = await holdAll(ctx.orgA.id, MOST)
    const refused = await asA()
      .get(ApiRoutes.finance.reports.ledgerCsv)
      .query({ ...RANGE, accountId: randomUUID() })
    await leave(held)

    expect(refused.status).toBe(TOO_MANY_REQUESTS)
    expect(await slots(ctx.orgA.id)).toBe(0)
  })

  // The files of the journal have a cap of their own, apart from the reads (debt (a) of 7.3-D): a download paced by the client must not
  // take the places of the reports, and a full organization is refused before the file starts
  describe('the files of the journal', () => {
    const MOST_FILES = FinanceReportLimits.MAX_CONCURRENT_STREAMS_PER_ORGANIZATION
    const files = (organizationId: string): Promise<number> =>
      redis.zcard(CacheKeys.financeReports.streamSlots(organizationId))
    async function* nothing(): AsyncGenerator<never> {
      await Promise.resolve()
      yield* [] as never[]
    }

    it('refuses the next file with FINANCE_REPORT_BUSY when the organization is sending as many as it may, leaves the reads alone, and gives each place back', async () => {
      const open = await Promise.all(
        Array.from({ length: MOST_FILES }, () =>
          gate.openStream(ctx.orgA.id, () => Promise.resolve(nothing))
        )
      )
      expect(await files(ctx.orgA.id)).toBe(MOST_FILES)
      expect(await slots(ctx.orgA.id)).toBe(0)

      const refused = await asA().get(ApiRoutes.finance.reports.journalCsv).query(RANGE)
      const read = await asA().get(ApiRoutes.finance.reports.margin).query(RANGE)
      const other = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.finance.reports.journalCsv)
        .query(RANGE)

      expect(refused.status).toBe(TOO_MANY_REQUESTS)
      expect((refused.body as { error?: { code?: string } }).error?.code).toBe(
        ErrorCodes.FINANCE_REPORT_BUSY
      )
      expect(read.status).toBe(OK)
      expect(other.status).toBe(OK)
      // Only the file that was refused left nothing behind: the open ones still hold their places
      expect(await files(ctx.orgA.id)).toBe(MOST_FILES)

      // The files are empty: asking for the first page ends each one and gives its place back
      for (const stream of open) expect((await stream.next()).done).toBe(true)
      expect(await files(ctx.orgA.id)).toBe(0)
      const again = await asA().get(ApiRoutes.finance.reports.journalCsv).query(RANGE)
      expect(again.status).toBe(OK)
      // The file of the request ended: its place went back with the stream
      expect(await files(ctx.orgA.id)).toBe(0)
    })
  })
})
