import { EventEmitter } from 'node:events'

import type { INestApplication } from '@nestjs/common'

import type { AuthenticatedUser } from '@platform/core/auth'

import { FinanceReportsController } from '../../apps/api/src/modules/finance/finance-reports.controller'
import { FinanceReportsService } from '../../apps/api/src/modules/finance/finance-reports.service'
import { createTestApp } from '../helpers/app'

// Express pipes the file into the response and does not stop the pipe when the client goes away, so the generator stays suspended, and an
// async generator that never started skips its `finally`: the controller must give the place of the file back when the response closes
describe('The CSV of the journal when the client goes away', () => {
  let app: INestApplication
  let controller: FinanceReportsController
  let reports: FinanceReportsService

  beforeAll(async () => {
    app = await createTestApp()
    controller = app.get(FinanceReportsController, { strict: false })
    reports = app.get(FinanceReportsService, { strict: false })
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await app.close()
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
})
