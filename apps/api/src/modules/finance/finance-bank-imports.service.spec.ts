import {
  BankStatementEncodings,
  BankThousandsSeparators,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { FinanceBankImportsService } from './finance-bank-imports.service'
import type { BankProfileView } from './finance-bank-profiles.service'

// The recovery of a failed bank import (N-2). The rows of an import are ONE unit; when it fails, the recovery reads in a FRESH unit (the old
// code read inside the aborted transaction, 25P02, and answered a raw error instead of the 409 of a race, leaving the object in the bucket).
// The service is read here with fakes for the units, the bucket and the queue: which unit asked what, and what the bucket was told.
describe('FinanceBankImportsService.importFile: the recovery of a failed import', () => {
  const ORG = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
  const STORE = '2d307c85-af40-4e6f-9c63-2c3d4e5f6071'
  const PROFILE: BankProfileView = {
    id: 'p-1',
    accountId: 'a-1',
    name: 'Banco',
    delimiter: RemittanceDelimiters.COMMA,
    hasHeader: true,
    skipRows: 0,
    decimalSeparator: RemittanceDecimalSeparators.DOT,
    thousandsSeparator: BankThousandsSeparators.NONE,
    dateFormat: RemittanceDateFormats.ISO,
    encoding: BankStatementEncodings.UTF8,
    dateWindowDays: 3,
    columns: { date: 'Date', description: 'Description', reference: 'Ref', amount: 'Amount' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const TEXT = 'Date,Description,Ref,Amount\n2026-03-04,Pago,R1,10.00\n'
  const FILE = { text: TEXT, bytes: Buffer.from(TEXT) }
  const ACTOR = { userId: 'u-1', storeId: STORE, ipAddress: '127.0.0.1', userAgent: 'jest' }
  // Recognized by its shape (`isUniqueViolation`), as the error of a transaction or of a driver adapter is
  const unique = () => Object.assign(new Error('unique constraint failed'), { code: 'P2002' })

  // `units`: what each unit does, in order of opening. A string is a result; an Error is thrown
  function build(units: readonly (object | Error)[]) {
    const calls: string[] = []
    const queue = [...units]
    const prisma = {
      client: {
        bankStatementLine: { count: jest.fn().mockResolvedValue(0) },
        bankStatementImport: { findFirst: jest.fn() }
      },
      afterCommitStep: jest.fn((_db: unknown, step: () => Promise<unknown>) => step())
    }
    const jobs = {
      forStore: jest.fn((_store: string, work: () => Promise<unknown>) => {
        calls.push('unit')
        const next = queue.shift()
        if (next instanceof Error) return Promise.reject(next)
        // A unit with a result of its own stands in for the rows; one without it runs the callback
        return next === undefined ? work() : Promise.resolve(next)
      }),
      forStoreOrJoin: jest.fn((_store: string, work: () => Promise<unknown>) => {
        calls.push('read')
        return work()
      })
    }
    const storage = {
      put: jest.fn(() => {
        calls.push('put')
        return Promise.resolve()
      }),
      delete: jest.fn(() => {
        calls.push('delete')
        return Promise.resolve()
      })
    }
    const service = new FinanceBankImportsService(
      prisma as never,
      jobs as never,
      storage as never,
      { log: jest.fn() } as never,
      { add: jest.fn() } as never
    )
    return { service, prisma, storage, calls }
  }
  const run = (service: FinanceBankImportsService) =>
    service.importFile(ORG, STORE, { profileId: 'p-1' }, PROFILE, FILE, ACTOR)

  it('puts the file before the rows, outside any unit, and removes it when nothing was made', async () => {
    const { service, prisma, storage, calls } = build([new Error('the unit failed')])
    prisma.client.bankStatementImport.findFirst.mockResolvedValue(null)

    await expect(run(service)).rejects.toThrow('the unit failed')

    // The count of known lines is a read of its own; the bucket is called between units; the recovery reads in a fresh unit and the object goes
    // when the import does not exist
    expect(calls).toEqual(['read', 'put', 'unit', 'unit', 'delete'])
    expect(storage.delete).toHaveBeenCalledTimes(1)
  })

  it('answers the 409 of a race (unique violation of the hash) and removes the object, reading in a fresh unit', async () => {
    const { service, prisma, storage } = build([unique()])
    prisma.client.bankStatementImport.findFirst.mockResolvedValue(null)

    await expect(run(service)).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_CONFLICT,
      statusCode: 409
    })

    expect(prisma.client.bankStatementImport.findFirst).toHaveBeenCalledTimes(1)
    expect(storage.delete).toHaveBeenCalledTimes(1)
  })

  it('keeps the file when the import exists after all (an error after the commit): it is its evidence', async () => {
    const { service, prisma, storage } = build([new Error('connection dropped on the way back')])
    prisma.client.bankStatementImport.findFirst.mockResolvedValue({ id: 'i-1' })

    await expect(run(service)).rejects.toThrow('connection dropped')

    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('keeps the file when it cannot tell whether the import exists: never delete evidence on doubt', async () => {
    const { service, prisma, storage } = build([unique()])
    prisma.client.bankStatementImport.findFirst.mockRejectedValue(new Error('the pool is gone'))

    await expect(run(service)).rejects.toThrow()

    expect(storage.delete).not.toHaveBeenCalled()
  })
})
