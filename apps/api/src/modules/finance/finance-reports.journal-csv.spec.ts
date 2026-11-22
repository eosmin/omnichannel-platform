import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import type { JobContext, PrismaService } from '@platform/core/database'
import { FinanceReportLimits } from '@platform/core/domain'

import type { FinanceReportGate } from './finance-report-gate.service'
import { FinanceReportsService } from './finance-reports.service'

const ORGANIZATION_ID = 'org-a'
const QUERY = { from: '2026-01-01', to: '2026-01-31' }
const ACTOR = { userId: 'user-a', storeId: 'store-a' }
const MAX_NUMBER = 12n

function line(number: bigint, lineNo: number) {
  return {
    entry_id: `entry-${number.toString()}`,
    number,
    entry_date: new Date('2026-01-10T00:00:00Z'),
    period_id: 'period',
    type: 'manual',
    source_type: null,
    source_id: null,
    source_date: null,
    reverses_entry_id: null,
    idempotency_key: `key-${number.toString()}`,
    entry_memo: null,
    currency: 'USD',
    total_cents: 100n,
    origin: 'manual',
    created_by: null,
    prev_hash: null,
    hash: 'hash',
    line_no: lineNo,
    account_id: 'account',
    account_code: '1000',
    account_name: 'Cash',
    debit_cents: 100n,
    credit_cents: 0n,
    store_id: null,
    party_type: null,
    party_id: null,
    tax_rate_id: null,
    line_memo: null
  }
}

// What the service asks the database, told apart by its text; `inUnit` says whether a unit of the organization was open at the time
// The cap of the files is proved in finance-report-gate.service.spec.ts and finance-report-cap.spec.ts; here the gate only lets the file through
const passGate = {
  openStream: async (
    _organizationId: string,
    prepare: () => Promise<() => AsyncGenerator<unknown>>
  ) => (await prepare())()
} as unknown as FinanceReportGate

function build(pages: ReturnType<typeof line>[][]) {
  let inUnit = false
  const asked: { text: string; values: unknown[]; inUnit: boolean }[] = []
  const queue = [...pages]
  const queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    asked.push({ text, values, inUnit })
    if (text.includes('COUNT(*)')) {
      return Promise.resolve([{ rows: 3n, max_number: MAX_NUMBER }])
    }
    return Promise.resolve(queue.shift() ?? [])
  })
  const prisma = { client: { $queryRaw: queryRaw } } as unknown as PrismaService // the one call the class makes here
  const inOrganization = jest.fn(async (organizationId: string, work: () => Promise<unknown>) => {
    expect(organizationId).toBe(ORGANIZATION_ID)
    inUnit = true
    try {
      return await work()
    } finally {
      inUnit = false
    }
  })
  const jobContext = { inOrganization } as unknown as JobContext // the one method the class calls
  const log = jest.fn<void, [unknown]>()
  const audit = { log } as unknown as AuditService // the one method the class calls
  const error = jest.fn()
  const logger = { setContext: jest.fn(), error } as unknown as PinoLogger // what the class calls
  return {
    service: new FinanceReportsService(prisma, audit, jobContext, passGate, logger),
    error,
    asked,
    inOrganization,
    log
  }
}

async function drain(pages: AsyncGenerator<unknown[]>): Promise<number> {
  let total = 0
  for await (const page of pages) total += page.length
  return total
}

describe('FinanceReportsService.journalCsv', () => {
  it('reads the count and every page in a unit of the organization of its own, never outside one', async () => {
    const full = Array.from({ length: FinanceReportLimits.CSV_PAGE_SIZE }, (_, index) =>
      line(11n, index + 1)
    )
    const { service, asked, inOrganization } = build([full, [line(12n, 1)]])

    const total = await drain(await service.journalCsv(ORGANIZATION_ID, QUERY, ACTOR))

    expect(total).toBe(FinanceReportLimits.CSV_PAGE_SIZE + 1)
    expect(asked.length).toBeGreaterThanOrEqual(2)
    expect(asked.every(call => call.inUnit)).toBe(true)
    // The count and each page: one unit apiece, so no transaction stays open while the file is sent
    expect(inOrganization.mock.calls.length).toBe(
      1 + asked.filter(call => !call.text.includes('COUNT(*)')).length
    )
  })

  it('cuts every page at the last entry that was counted, so the file is what the audit row says', async () => {
    const size = FinanceReportLimits.CSV_PAGE_SIZE
    const full = Array.from({ length: size }, (_, index) => line(11n, index + 1))
    const { service, asked, log } = build([full, [line(12n, 1)]])

    await drain(await service.journalCsv(ORGANIZATION_ID, QUERY, ACTOR))

    const pagesAsked = asked.filter(call => !call.text.includes('COUNT(*)'))
    expect(pagesAsked).toHaveLength(2)
    for (const page of pagesAsked) {
      expect(page.text).toContain('e.number <=')
      expect(page.values).toContain(MAX_NUMBER)
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toMatchObject({ metadata: { report: 'journal', rows: 3 } })
  })

  it('writes the header alone and counts zero rows for an empty range, with no page read', async () => {
    const { service, asked, log } = build([])
    asked.length = 0
    const empty = jest.fn((strings: TemplateStringsArray) => {
      asked.push({ text: strings.join('?'), values: [], inUnit: true })
      return Promise.resolve([{ rows: 0n, max_number: null }])
    })
    const built = new FinanceReportsService(
      { client: { $queryRaw: empty } } as unknown as PrismaService, // the one call the class makes here
      { log } as unknown as AuditService,
      {
        inOrganization: (_org: string, work: () => Promise<unknown>) => work()
      } as unknown as JobContext,
      passGate,
      { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger
    )

    const total = await drain(await built.journalCsv(ORGANIZATION_ID, QUERY, ACTOR))

    expect(total).toBe(0)
    expect(asked).toHaveLength(1)
    expect(service).toBeDefined()
    expect(log.mock.calls[0]?.[0]).toMatchObject({ metadata: { report: 'journal', rows: 0 } })
  })

  it('logs a page that cannot be read and rejects, so the stream is cut', async () => {
    const full = Array.from({ length: FinanceReportLimits.CSV_PAGE_SIZE }, (_, index) =>
      line(11n, index + 1)
    )
    const { service, error } = build([full])
    const pages = await service.journalCsv(ORGANIZATION_ID, QUERY, ACTOR)
    const first = await pages.next()
    expect(first.done).toBe(false)
    // The next page fails: the queue of the double is empty, so make the database refuse
    const failing = build([])
    failing.asked.length = 0
    const broken = new FinanceReportsService(
      {
        client: {
          $queryRaw: jest.fn((strings: TemplateStringsArray) =>
            strings.join('?').includes('COUNT(*)')
              ? Promise.resolve([{ rows: 5n, max_number: MAX_NUMBER }])
              : Promise.reject(new RangeError('pool timeout'))
          )
        }
      } as unknown as PrismaService, // the one call the class makes here
      { log: jest.fn() } as unknown as AuditService,
      {
        inOrganization: (_org: string, work: () => Promise<unknown>) => work()
      } as unknown as JobContext,
      passGate,
      { setContext: jest.fn(), error } as unknown as PinoLogger
    )

    await expect(drain(await broken.journalCsv(ORGANIZATION_ID, QUERY, ACTOR))).rejects.toThrow(
      'pool timeout'
    )
    expect(error).toHaveBeenCalledWith(
      { organizationId: ORGANIZATION_ID, errorName: 'RangeError' },
      'a page of the journal file could not be read; the file was cut'
    )
  })
})
