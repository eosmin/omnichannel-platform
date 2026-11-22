import type { JobContext } from '@platform/core/database'
import { FinanceReportLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { FinanceReportGate } from './finance-report-gate.service'

// A Redis that does what the two scripts and ZREM do, in memory, so the cap is read without a server. The scripts themselves run in the
// integration case (tests/api/finance-report-cap.spec.ts).
class FakeRedis {
  places = new Map<string, Map<string, number>>()
  down = false
  evalCalls = 0

  eval(script: string, _keys: number, key: string, ...args: (string | number)[]): Promise<number> {
    this.evalCalls += 1
    if (this.down) return Promise.reject(new Error('connection lost'))
    const set = this.places.get(key) ?? new Map<string, number>()
    this.places.set(key, set)
    if (script.includes('ZCARD')) {
      const [, now, oldest, most] = args.map(Number) as [number, number, number, number]
      const name = String(args[0])
      for (const [member, seen] of set) if (seen <= oldest) set.delete(member)
      if (set.size >= most) return Promise.resolve(0)
      set.set(name, now)
      return Promise.resolve(1)
    }
    const name = String(args[0])
    if (!set.has(name)) return Promise.resolve(0)
    set.set(name, Number(args[1]))
    return Promise.resolve(1)
  }

  zrem(key: string, token: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('connection lost'))
    return Promise.resolve(this.places.get(key)?.delete(token) === true ? 1 : 0)
  }

  held(): number {
    return [...this.places.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

const jobContext = {
  inOrganization: <T>(_organizationId: string, work: () => Promise<T>) => work()
} as unknown as JobContext
const warn = jest.fn()
const logger = { warn } as never

const MOST = FinanceReportLimits.MAX_CONCURRENT_READS_PER_ORGANIZATION

function gateOf(redis: FakeRedis): FinanceReportGate {
  return new FinanceReportGate(redis as never, jobContext, logger)
}

// A report that stays open until it is told to finish
function pending(): { done: () => void; work: () => Promise<string> } {
  let done: () => void = () => undefined
  const wait = new Promise<void>(resolve => {
    done = resolve
  })
  return { done, work: () => wait.then(() => 'ok') }
}

describe('FinanceReportGate', () => {
  it('lets as many reads of an organization run at once as the cap says, and refuses the next one with its own code', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    const open = Array.from({ length: MOST }, () => pending())
    const running = open.map(report => gate.read('org-1', report.work))
    await new Promise(resolve => setImmediate(resolve))
    expect(redis.held()).toBe(MOST)

    const refused = gate
      .read('org-1', () => Promise.resolve('never'))
      .catch((error: unknown) => error)
    const error = await refused
    expect(error).toBeInstanceOf(PlatformException)
    expect((error as PlatformException).code).toBe(ErrorCodes.FINANCE_REPORT_BUSY)
    expect((error as PlatformException).statusCode).toBe(HttpStatusCodes.TOO_MANY_REQUESTS)

    open.forEach(report => report.done())
    await Promise.all(running)
    expect(redis.held()).toBe(0)
  })

  it('counts each organization on its own', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    const open = Array.from({ length: MOST }, () => pending())
    const running = open.map(report => gate.read('org-1', report.work))
    await new Promise(resolve => setImmediate(resolve))
    await expect(gate.read('org-2', () => Promise.resolve('fine'))).resolves.toBe('fine')
    open.forEach(report => report.done())
    await Promise.all(running)
  })

  it('gives the place back when the report fails, so a failing report never fills the cap', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    for (let attempt = 0; attempt < MOST + 2; attempt += 1) {
      await expect(
        gate.read('org-1', () => Promise.reject(new Error('the query failed')))
      ).rejects.toThrow('the query failed')
    }
    expect(redis.held()).toBe(0)
    await expect(gate.read('org-1', () => Promise.resolve('fine'))).resolves.toBe('fine')
  })

  it('takes one place for a report that reads another (the CSV of a report reads the report)', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    const inner = (): Promise<string> => gate.read('org-1', () => Promise.resolve('inner'))
    const result = await gate.read('org-1', async () => {
      expect(redis.held()).toBe(1)
      return inner().then(() => inner())
    })
    expect(result).toBe('inner')
    expect(redis.held()).toBe(0)
  })

  it('does not take a place for a unit that no report opened', async () => {
    const redis = new FakeRedis()
    await expect(gateOf(redis).unit('org-1', () => Promise.resolve(3))).resolves.toBe(3)
    expect(redis.evalCalls).toBe(0)
  })

  it('renews the place on every page of a report, and only while the place is its own', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    await gate.read('org-1', async () => {
      await gate.unit('org-1', () => Promise.resolve(1))
      await gate.unit('org-1', () => Promise.resolve(2))
    })
    // one to take it, one for each page
    expect(redis.evalCalls).toBe(3)
  })

  it('runs the report without the cap, and says so, when Redis cannot be reached', async () => {
    const redis = new FakeRedis()
    redis.down = true
    await expect(gateOf(redis).read('org-1', () => Promise.resolve('fine'))).resolves.toBe('fine')
    expect(warn).toHaveBeenCalled()
  })

  it('frees a place that nobody renewed for longer than the expiry', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now - FinanceReportLimits.READ_SLOT_TTL_MS - 1)
    const stale = Array.from({ length: MOST }, () => pending())
    const running = stale.map(report => gate.read('org-1', report.work))
    await new Promise(resolve => setImmediate(resolve))
    jest.spyOn(Date, 'now').mockReturnValue(now)
    await expect(gate.read('org-1', () => Promise.resolve('fine'))).resolves.toBe('fine')
    jest.restoreAllMocks()
    stale.forEach(report => report.done())
    await Promise.all(running)
  })

  it('takes the place again when it expired between two pages, and refuses the page when the organization filled up meanwhile', async () => {
    const redis = new FakeRedis()
    const gate = gateOf(redis)
    await gate.read('org-1', async () => {
      const set = [...redis.places.values()][0] as Map<string, number>
      set.clear()
      await gate.unit('org-1', () => Promise.resolve(1))
      expect(redis.held()).toBe(1)
      // The organization fills up while this report is between pages
      set.clear()
      for (let index = 0; index < MOST; index += 1) set.set(`other-${String(index)}`, Date.now())
      const error = await gate.unit('org-1', () => Promise.resolve(2)).catch((e: unknown) => e)
      expect((error as PlatformException).code).toBe(ErrorCodes.FINANCE_REPORT_BUSY)
    })
  })
})
