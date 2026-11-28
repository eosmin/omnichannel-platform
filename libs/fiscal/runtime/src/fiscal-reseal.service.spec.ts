import { randomBytes } from 'node:crypto'

import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { FiscalReseal } from '@platform/core/domain'

import { FiscalResealService, type FiscalResealUnit } from './fiscal-reseal.service'

// The part of the re-seal that no honest database run reaches: a new value that does not open to the same content is never written, a write
// that finds the row changed is a conflict and not a loss, and a run without a previous key reads nothing.
describe('FiscalResealService (what the database run cannot show)', () => {
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    warn: () => undefined
  } as unknown as PinoLogger
  const unit: FiscalResealUnit = work => work()
  const audit = { log: jest.fn() }

  function prismaWith(sealed: Uint8Array, updated: number) {
    const updateMany = jest.fn().mockResolvedValue({ count: updated })
    const findMany = jest
      .fn()
      .mockImplementation((args: { where?: { id?: unknown } }) =>
        Promise.resolve(
          args.where?.id === undefined ? [{ id: 'row-1', dataEncrypted: sealed }] : []
        )
      )
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    return {
      client: {
        customerFiscalData: { findMany, updateMany },
        fiscalDocument: empty,
        fiscalIssuer: empty,
        fiscalContingency: empty,
        excludedSubjectPurchase: empty
      },
      updateMany,
      findMany
    }
  }

  beforeEach(() => audit.log.mockReset())

  it('writes nothing and counts a failure when the value sealed again does not open to the same content', async () => {
    const sealedOld = new CredentialCipher(oldKey).seal({ taxId: 'T-1' })
    const prisma = prismaWith(new Uint8Array(sealedOld), 1)
    class Faulty extends CredentialCipher {
      override open(sealed: Uint8Array): Record<string, unknown> {
        const real = super.open(sealed)
        return { ...real, taxId: 'changed' }
      }
    }
    const service = new FiscalResealService(
      prisma as never,
      new Faulty(newKey, oldKey),
      audit as never,
      logger
    )

    const report = await service.run('org-1', unit)

    expect(prisma.updateMany).not.toHaveBeenCalled()
    expect(report.resealed).toBe(0)
    expect(report.failed).toEqual({ reseal_mismatch: 1 })
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('counts a conflict, writes no entry and loses nothing when the row changed meanwhile', async () => {
    const sealedOld = new CredentialCipher(oldKey).seal({ taxId: 'T-1' })
    const prisma = prismaWith(new Uint8Array(sealedOld), 0)
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey, oldKey),
      audit as never,
      logger
    )

    const report = await service.run('org-1', unit)

    expect(report).toMatchObject({ resealed: 0, conflicts: 1, failed: {} })
    expect(audit.log).not.toHaveBeenCalled()
    // The swap named the old bytes, so a row that moved is not overwritten
    const calls = prisma.updateMany.mock.calls as [
      { where: { dataEncrypted: Uint8Array; store: unknown } }
    ][]
    const where = calls[0]?.[0].where as { dataEncrypted: Uint8Array; store: unknown }
    expect(Buffer.from(where.dataEncrypted).equals(Buffer.from(sealedOld))).toBe(true)
    expect(where.store).toEqual({ organizationId: 'org-1' })
  })

  it('reads no sealed value to seal again without a previous key (only the masks are looked for)', async () => {
    const prisma = prismaWith(new Uint8Array(), 1)
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey),
      audit as never,
      logger
    )
    const report = await service.run('org-1', unit)
    expect(report.enabled).toBe(false)
    expect(prisma.findMany).not.toHaveBeenCalled()
  })

  it('calculates no mask from a receiver that only the previous key opens, and counts it by code without its content', async () => {
    const sealedOld = new CredentialCipher(oldKey).seal({
      name: 'Ana Receptora',
      taxId: '0614-010101-101-1'
    })
    const queryRaw = jest.fn()
    const documents = {
      // The re-seal reads nothing of the documents; only the step of the masks finds this one
      findMany: jest
        .fn()
        .mockImplementation((args: { where: { receiverMaskedAt?: null } }) =>
          Promise.resolve(
            args.where.receiverMaskedAt === null
              ? [{ id: 'doc-1', receiverEncrypted: new Uint8Array(sealedOld) }]
              : []
          )
        ),
      updateMany: jest.fn()
    }
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    const prisma = {
      client: {
        customerFiscalData: empty,
        fiscalDocument: documents,
        fiscalIssuer: empty,
        fiscalContingency: empty,
        excludedSubjectPurchase: empty,
        $queryRaw: queryRaw
      }
    }
    const errors: unknown[] = []
    const loud = {
      setContext: () => undefined,
      error: (entry: unknown) => errors.push(entry),
      warn: (entry: unknown) => errors.push(entry)
    } as unknown as PinoLogger
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey, oldKey),
      audit as never,
      loud
    )

    const report = await service.run('org-1', unit)

    // The previous key opens it for the re-seal (which found nothing here), never for a mask
    expect(queryRaw).not.toHaveBeenCalled()
    expect(report.masked).toBe(0)
    expect(report.failed).toEqual({})
    expect(report.maskFailed).toEqual({ key_mismatch: 1 })
    expect(JSON.stringify(errors)).not.toMatch(/Receptora|0614/)
  })

  it('masks the healthy receiver behind more unreadable ones than the cap of masks written, and counts each unreadable by code', async () => {
    const stranger = new CredentialCipher(randomBytes(32))
    const lost = new Uint8Array(stranger.seal({ name: 'Nobody', taxId: '0614-010101-101-1' }))
    const healthy = new Uint8Array(
      new CredentialCipher(newKey).seal({ name: 'Ana', taxId: '0614-010101-101-1' })
    )
    const unreadable = FiscalReseal.MAX_VALUES_PER_KIND + 150
    // Ids in order: the unreadable ones first, the healthy one last (the cursor of the run is the id)
    const all = [
      ...Array.from({ length: unreadable }, (_, i) => ({
        id: `a${String(i).padStart(6, '0')}`,
        receiverEncrypted: lost
      })),
      { id: 'z-healthy', receiverEncrypted: healthy }
    ]
    const queryRaw = jest.fn().mockResolvedValue([{ changed: true }])
    const documents = {
      findMany: jest
        .fn()
        .mockImplementation(
          (args: { where: { receiverMaskedAt?: null; id?: { gt: string } }; take: number }) =>
            Promise.resolve(
              args.where.receiverMaskedAt === null
                ? all
                    .filter(row => args.where.id === undefined || row.id > args.where.id.gt)
                    .slice(0, args.take)
                : []
            )
        ),
      updateMany: jest.fn()
    }
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    const prisma = {
      client: {
        customerFiscalData: empty,
        fiscalDocument: documents,
        fiscalIssuer: empty,
        fiscalContingency: empty,
        excludedSubjectPurchase: empty,
        $queryRaw: queryRaw
      }
    }
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey),
      audit as never,
      logger
    )

    const report = await service.run('org-1', unit)

    expect(report.masked).toBe(1)
    expect(report.maskFailed).toEqual({ key_mismatch: unreadable })
    expect(report.truncated).toBe(false)
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('stops at the cap of values sealed again, says truncated, and a second run goes on and ends clean', async () => {
    const old = new CredentialCipher(oldKey)
    const cipher = new CredentialCipher(newKey, oldKey)
    const total = FiscalReseal.MAX_VALUES_PER_KIND + 1
    // Rows by id, as the table holds them: the swap of a row changes what the next read returns
    const rows: { id: string; dataEncrypted: Uint8Array }[] = Array.from(
      { length: total },
      (_, i) => ({
        id: `row-${String(i).padStart(6, '0')}`,
        dataEncrypted: new Uint8Array(old.seal({ n: i }))
      })
    )
    const customerFiscalData = {
      findMany: jest.fn().mockImplementation((args: { where: { id?: { gt: string } } }) => {
        const after = args.where.id?.gt
        return Promise.resolve(
          rows.filter(r => after === undefined || r.id > after).slice(0, FiscalReseal.PAGE_SIZE)
        )
      }),
      updateMany: jest
        .fn()
        .mockImplementation(
          (args: { where: { id: string }; data: { dataEncrypted: Uint8Array } }) => {
            const row = rows.find(r => r.id === args.where.id)
            if (row !== undefined) row.dataEncrypted = args.data.dataEncrypted
            return Promise.resolve({ count: 1 })
          }
        )
    }
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    const prisma = {
      client: {
        customerFiscalData,
        fiscalDocument: empty,
        fiscalIssuer: empty,
        fiscalContingency: empty,
        excludedSubjectPurchase: empty
      }
    }
    const service = new FiscalResealService(prisma as never, cipher, audit as never, logger)

    const first = await service.run('org-1', unit)
    expect(first).toMatchObject({
      truncated: true,
      resealed: FiscalReseal.MAX_VALUES_PER_KIND,
      failed: {}
    })

    // The rows already current are skipped and do not count: the second run seals the one left and ends clean
    const second = await service.run('org-1', unit)
    expect(second).toMatchObject({ truncated: false, resealed: 1, failed: {} })
    const third = await service.run('org-1', unit)
    expect(third).toMatchObject({ truncated: false, resealed: 0, conflicts: 0, failed: {} })
    expect(third.current).toBe(total)
  }, 60_000)
})
