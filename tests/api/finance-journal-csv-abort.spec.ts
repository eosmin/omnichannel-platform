import { EventEmitter } from 'node:events'

import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'

import type { AuthenticatedUser } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import { REDIS_CLIENT } from '@platform/core/redis'

import { FinanceReportsController } from '../../apps/api/src/modules/finance/finance-reports.controller'
import { FinanceReportsService } from '../../apps/api/src/modules/finance/finance-reports.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Express pipes the file into the response and does not stop the pipe when the client goes away, so the generator stays suspended, and an
// async generator that never started skips its `finally`: the controller must give the place of the file back when the response closes
describe('The CSV of the journal when the client goes away', () => {
  const prefix = newRunPrefix()
  let owner: OwnerClient
  let ctx: TestContext
  let redis: Redis
  let app: INestApplication
  let controller: FinanceReportsController
  let reports: FinanceReportsService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    controller = app.get(FinanceReportsController, { strict: false })
    reports = app.get(FinanceReportsService, { strict: false })
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await redis.del(CacheKeys.financeReports.streamSlots(ctx.orgA.id))
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  async function open(finished: boolean) {
    const dispose = jest.fn().mockResolvedValue(undefined)
    async function* never(): AsyncGenerator<never[]> {
      await new Promise(() => undefined)
      yield []
    }
    jest.spyOn(reports, 'journalCsv').mockResolvedValue(Object.assign(never(), { dispose }))
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      writableFinished: finished
    })
    const file = await controller.journalCsv(
      { id: 'org-1' },
      { id: 'store-1' } as never,
      { id: 'user-1' } as AuthenticatedUser,
      { from: '2026-01-01', to: '2026-01-31' },
      { ip: '127.0.0.1', get: () => 'jest' } as never,
      res as never
    )
    return { dispose, res, stream: file.getStream() }
  }

  it('gives the place of the file back and closes the stream when the client goes away before the end', async () => {
    const { dispose, res, stream } = await open(false)

    res.emit('close')

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stream.destroyed).toBe(true)
  })

  it('gives the place back, and leaves the stream alone, when the response closed after the whole file was written', async () => {
    const { dispose, res, stream } = await open(true)

    res.emit('close')

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stream.destroyed).toBe(false)
  })

  // The window the first version left open: the place is taken inside `reports.journalCsv` (the count and its audit row follow), so a
  // client that goes away DURING that await has already closed when the handler gets its stream, and a listener registered afterwards
  // never hears it
  it('gives the place back when the client goes away while the place is being taken', async () => {
    const dispose = jest.fn().mockResolvedValue(undefined)
    async function* never(): AsyncGenerator<never[]> {
      await new Promise(() => undefined)
      yield []
    }
    let arrive: () => void = () => undefined
    const taking = new Promise<void>(resolve => {
      arrive = resolve
    })
    jest.spyOn(reports, 'journalCsv').mockImplementation(async () => {
      await taking
      return Object.assign(never(), { dispose })
    })
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      writableFinished: false,
      destroyed: false
    })
    const pending = controller.journalCsv(
      { id: 'org-1' },
      { id: 'store-1' } as never,
      { id: 'user-1' } as AuthenticatedUser,
      { from: '2026-01-01', to: '2026-01-31' },
      { ip: '127.0.0.1', get: () => 'jest' } as never,
      res as never
    )
    // The client goes away before the place is in hand
    res.destroyed = true
    res.emit('close')
    arrive()
    await pending

    expect(dispose).toHaveBeenCalled()
  })

  // The real gate on the real Redis: the file takes its place, nobody reads it (the pipe is paused, the generator never starts) and the
  // client goes away. The count of places must come back to what it was
  it('takes the place back in Redis when a file nobody read is dropped, and the next file is not refused', async () => {
    jest.restoreAllMocks()
    const key = CacheKeys.financeReports.streamSlots(ctx.orgA.id)
    const res = Object.assign(new EventEmitter(), { setHeader: jest.fn(), writableFinished: false })
    const query = { from: '2026-01-01', to: '2026-01-31' }
    const ask = () =>
      controller.journalCsv(
        { id: ctx.orgA.id },
        ctx.storeA as never,
        ctx.adminA as unknown as AuthenticatedUser,
        query,
        { ip: '127.0.0.1', get: () => 'jest' } as never,
        res as never
      )

    const file = await ask()
    expect(await redis.zcard(key)).toBe(1)
    res.emit('close')

    for (let attempt = 0; attempt < 50 && (await redis.zcard(key)) > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(await redis.zcard(key)).toBe(0)
    expect(file.getStream().destroyed).toBe(true)
    // Two more files fit: the dropped one is not counted against the organization
    res.removeAllListeners('close')
    await ask()
    await ask()
    expect(await redis.zcard(key)).toBe(2)
    res.emit('close')
  })
})
